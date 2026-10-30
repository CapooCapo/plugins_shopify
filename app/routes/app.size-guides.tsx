import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, redirect, useActionData, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { SizeGuideManager } from "../components/SizeGuideManager";
import { assignSizeGuideProducts, createSizeGuide, deleteSizeGuide, getSizeGuide, getSizeGuideAssignment, listGuideAssignments, listOrphanedSizeGuideSyncLocks, listSizeGuides, saveSizeGuide } from "../utils/size-guide-repository.server";
import { getSizeGuideProductsByIds, SizeGuideProductLookupError } from "../utils/size-guide-products.server";
import type { SizeGuideResourcePicker, SizeGuideResourcePickerOptions } from "../components/SizeGuideManager";
import { validateSizeGuideDraft } from "../utils/size-guides.shared";
import { removeSizeGuideAssignment, retryOrphanedSizeGuideCleanup, retrySizeGuideRemoval, retrySizeGuideSync, syncSizeGuideAssignment } from "../utils/size-guide-sync.server";

const PRODUCT_ID = /^gid:\/\/shopify\/Product\/\d+$/;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  try {
    const guides = await listSizeGuides(session.shop);
    const cleanupLocks = await listOrphanedSizeGuideSyncLocks(session.shop);
    const requested = url.searchParams.get("guide");
    const selectedGuideId = guides.some((guide) => guide.id === requested) ? requested : guides[0]?.id ?? null;
    return data({ guides, selectedGuideId, cleanupLocks, storageError: null });
  } catch {
    return data({ guides: [], selectedGuideId: null,
      cleanupLocks: [], storageError: "Size Guide storage is unavailable. Apply the M4 database migration, then reload." });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const guideId = String(form.get("guideId") ?? "");
  if (intent === "save") {
    const rawId = String(form.get("id") ?? "");
    const id = rawId || crypto.randomUUID();
    let columns: unknown;
    let rows: unknown;
    try {
      columns = JSON.parse(String(form.get("columns") ?? ""));
      rows = JSON.parse(String(form.get("rows") ?? ""));
    } catch { return data({ error: "The size chart could not be read. Review its rows and retry." }, { status: 400 }); }
    const draft = validateSizeGuideDraft({ title: form.get("title"), unit: form.get("unit"), columns, rows });
    if (!draft.ok) return data({ error: draft.errors[0], errors: draft.errors }, { status: 400 });
    if (rawId) {
      if (!await getSizeGuide(session.shop, id)) return data({ error: "This guide was not found in the authenticated store." }, { status: 404 });
      await saveSizeGuide(session.shop, id, draft.value);
      const assigned = await listGuideAssignments(session.shop, id);
      for (const item of assigned) await syncSizeGuideAssignment(admin, session.shop, item.id);
    } else {
      await createSizeGuide(session.shop, id, draft.value);
    }
    return redirect(`/app/size-guides?guide=${encodeURIComponent(id)}`);
  }

  if (intent === "assignProducts") {
    const rawProductIds = form.getAll("productIds").map(String);
    const productIds = [...new Set(rawProductIds)];
    const rawReplaceIds = form.getAll("replaceProductIds").map(String);
    const replaceProductIds = [...new Set(rawReplaceIds)];
    const confirmReplacements = form.get("confirmReplacements") === "yes";
    if (!rawProductIds.length || rawProductIds.length > 250 || productIds.some((id) => !PRODUCT_ID.test(id))) {
      return data({ error: "Choose between 1 and 250 valid products from Shopify's product picker.", errorType: "invalid" }, { status: 400 });
    }
    if (replaceProductIds.some((id) => !PRODUCT_ID.test(id) || !productIds.includes(id))) {
      return data({ error: "Replacement confirmation must match products in this selection.", errorType: "invalid" }, { status: 400 });
    }
    if (!await getSizeGuide(session.shop, guideId)) {
      return data({ error: "Choose a guide in this store before assigning products.", errorType: "not_found" }, { status: 404 });
    }
    let products: Awaited<ReturnType<typeof getSizeGuideProductsByIds>>;
    try {
      products = await getSizeGuideProductsByIds(admin, productIds);
    } catch (error) {
      const errorType = error instanceof SizeGuideProductLookupError ? error.errorType : "api";
      return data({
        error: errorType === "permission" ? "Shopify denied access to product details. Confirm product access and reauthorize if needed." :
          "Shopify could not verify the selected products. Retry when the Admin API is available.",
        errorType,
      }, { status: errorType === "permission" ? 403 : 502 });
    }
    const productsById = new Map(products.map((product) => [product.id, product]));
    if (productIds.some((id) => !productsById.has(id))) {
      return data({ error: "One or more selected products are no longer available in this store. Reopen the product picker.", errorType: "product_not_found" }, { status: 404 });
    }
    const verifiedProducts = productIds.map((id) => ({ id, title: productsById.get(id)!.title }));
    let result: Awaited<ReturnType<typeof assignSizeGuideProducts>>;
    try {
      result = await assignSizeGuideProducts({ shop: session.shop, guideId, products: verifiedProducts, replaceProductIds, confirmReplacements });
    } catch (error) {
      const message = String(error);
      if (/SIZE_GUIDE_PRODUCT_SYNC_LOCKED/.test(message)) {
        return data({ error: "A selected product is reserved while an interrupted size-guide operation is being recovered. Retry recovery, then assign it again.", errorType: "locked" }, { status: 409 });
      }
      if (/23505|P2002|SIZE_GUIDE_ASSIGNMENT_RACE/.test(message)) {
        return data({ error: "A product assignment changed during this request. Refresh the guide and try again.", errorType: "conflict" }, { status: 409 });
      }
      return data({ error: "The product mapping could not be saved. Existing guide data was retained; retry.", errorType: "storage" }, { status: 500 });
    }
    if (result.status === "guide_not_found") return data({ error: "This guide was not found in the authenticated store.", errorType: "not_found" }, { status: 404 });
    if (result.status === "locked") return data({
      error: "Some selected products are reserved while a publish or cleanup operation is active. Retry after recovery completes.",
      errorType: "locked", lockedProductIds: result.productIds,
    }, { status: 409 });
    if (result.status === "replacement_confirmation_required") return data({
      error: "Some selected products already have a different size guide. Confirm replacement for every listed product.",
      errorType: "replacement", conflicts: result.conflicts,
    }, { status: 409 });
    const assigned = await listGuideAssignments(session.shop, guideId);
    const unchanged = new Set(result.unchangedProductIds);
    for (const product of verifiedProducts) {
      if (unchanged.has(product.id)) continue;
      const row = assigned.find((item) => item.productId === product.id);
      if (row) await syncSizeGuideAssignment(admin, session.shop, row.id);
    }
    return redirect(`/app/size-guides?guide=${encodeURIComponent(guideId)}`);
  }

  if (intent === "unassign") {
    const productId = String(form.get("productId") ?? "");
    if (!PRODUCT_ID.test(productId)) return data({ error: "The product assignment is invalid." }, { status: 400 });
    const result = await removeSizeGuideAssignment(admin, session.shop, productId);
    if (result.status === "failed") return data({ error: "Shopify did not confirm metafield removal. The assignment is retained for retry." }, { status: 502 });
    return redirect(`/app/size-guides?guide=${encodeURIComponent(guideId)}`);
  }

  if (intent === "retry") {
    const productId = String(form.get("productId") ?? "");
    if (!PRODUCT_ID.test(productId)) return data({ error: "The product assignment is invalid." }, { status: 400 });
    const item = await getSizeGuideAssignment(session.shop, productId);
    if (!item) return data({ error: "The product assignment no longer exists." }, { status: 404 });
    const result = item.syncStatus.startsWith("REMOVE_")
      ? await retrySizeGuideRemoval(admin, item)
      : await retrySizeGuideSync(admin, session.shop, item.id, item.productId);
    if (result.status === "pending") return data({ error: "This product operation is still active. Retry after its recovery lease expires." }, { status: 409 });
    if (result.status === "failed") return data({ error: "Shopify did not confirm recovery. The product remains safely locked for retry." }, { status: 502 });
    return redirect(`/app/size-guides?guide=${encodeURIComponent(item.guideId)}`);
  }

  if (intent === "retryOrphanCleanup") {
    const productId = String(form.get("productId") ?? "");
    if (!PRODUCT_ID.test(productId)) return data({ error: "The product recovery is invalid." }, { status: 400 });
    const result = await retryOrphanedSizeGuideCleanup(admin, session.shop, productId);
    if (result.status === "pending") return data({ error: "This product operation is still active. Retry after its recovery lease expires." }, { status: 409 });
    if (result.status === "failed") return data({ error: "Shopify did not confirm cleanup. The product remains safely locked for retry." }, { status: 502 });
    return redirect("/app/size-guides");
  }

  if (intent === "delete") {
    const guide = await getSizeGuide(session.shop, guideId);
    if (!guide) return data({ error: "This guide was not found in the authenticated store." }, { status: 404 });
    const assignments = await listGuideAssignments(session.shop, guideId);
    for (const item of assignments) await removeSizeGuideAssignment(admin, session.shop, item.productId);
    const remaining = await listGuideAssignments(session.shop, guideId);
    if (remaining.length) return data({ error: "Some product metafields could not be removed. The guide and assignments are retained; retry removal." }, { status: 502 });
    if (!await deleteSizeGuide(session.shop, guideId)) return data({ error: "The guide could not be deleted because assignments remain." }, { status: 409 });
    return redirect("/app/size-guides");
  }

  return data({ error: "Unsupported Size Guide action." }, { status: 400 });
};

type SizeGuideActionFeedback = {
  error?: string;
  errorType?: string;
  conflicts?: Array<{ productId: string; currentGuideId: string }>;
  lockedProductIds?: string[];
};

export default function SizeGuidesRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as SizeGuideActionFeedback | undefined;
  const shopify = useAppBridge();
  const resourcePicker: SizeGuideResourcePicker = (options: SizeGuideResourcePickerOptions) => shopify.resourcePicker(options);
  return <s-page inlineSize="large"><SizeGuideManager {...data} resourcePicker={resourcePicker}
    actionError={actionData?.error ?? null} actionErrorType={actionData?.errorType ?? null}
    actionConflicts={actionData?.conflicts ?? []} lockedProductIds={actionData?.lockedProductIds ?? []} /></s-page>;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
