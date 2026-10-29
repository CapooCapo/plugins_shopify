import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, redirect, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { SizeGuideManager } from "../components/SizeGuideManager";
import { createSizeGuide, createSizeGuideAssignment, deleteSizeGuide, getSizeGuide, getSizeGuideAssignment, listGuideAssignments, listOrphanedSizeGuideSyncLocks, listSizeGuides, saveSizeGuide } from "../utils/size-guide-repository.server";
import { getSizeGuideProduct, searchSizeGuideProducts } from "../utils/size-guide-products.server";
import type { SizeGuideProduct } from "../utils/size-guide-products.server";
import { validateSizeGuideDraft } from "../utils/size-guides.shared";
import { removeSizeGuideAssignment, retryOrphanedSizeGuideCleanup, retrySizeGuideRemoval, retrySizeGuideSync, syncSizeGuideAssignment } from "../utils/size-guide-sync.server";

const PRODUCT_ID = /^gid:\/\/shopify\/Product\/\d+$/;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  try {
    const guides = await listSizeGuides(session.shop);
    const cleanupLocks = await listOrphanedSizeGuideSyncLocks(session.shop);
    const requested = url.searchParams.get("guide");
    const selectedGuideId = guides.some((guide) => guide.id === requested) ? requested : guides[0]?.id ?? null;
    let products: SizeGuideProduct[] = [];
    let productError = null;
    if (query.length >= 2) {
      try { products = await searchSizeGuideProducts(admin, query); }
      catch { productError = "Products could not be searched. Check product access and retry."; }
    }
    return data({ guides, selectedGuideId, query, products, productError, cleanupLocks, storageError: null });
  } catch {
    return data({ guides: [], selectedGuideId: null, query, products: [], productError: null,
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

  if (intent === "assign") {
    const productId = String(form.get("productId") ?? "");
    if (!PRODUCT_ID.test(productId)) return data({ error: "Choose a product from the search results." }, { status: 400 });
    if (!await getSizeGuide(session.shop, guideId)) return data({ error: "Choose a guide in this store before assigning products." }, { status: 404 });
    try {
      const product = await getSizeGuideProduct(admin, productId);
      if (!product || product.id !== productId) return data({ error: "That product is no longer available in this store." }, { status: 404 });
      await createSizeGuideAssignment({ shop: session.shop, guideId, productId, productTitle: product.title });
      const assigned = await listGuideAssignments(session.shop, guideId);
      const row = assigned.find((item) => item.productId === productId);
      if (row) await syncSizeGuideAssignment(admin, session.shop, row.id);
    } catch (error) {
      const message = String(error);
      if (message.includes("SIZE_GUIDE_PRODUCT_SYNC_LOCKED")) {
        return data({ error: "This product is reserved while an interrupted size-guide operation is being recovered. Retry recovery, then assign it again." }, { status: 409 });
      }
      if (/23505|P2002|SizeGuideProduct_shop_productId_key/.test(message)) {
        return data({ error: "This product already has a size guide assigned. Remove its current assignment first." }, { status: 409 });
      }
      return data({ error: "The product could not be assigned. Canonical guide data was not removed; retry." }, { status: 500 });
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

export default function SizeGuidesRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return <s-page inlineSize="large"><SizeGuideManager {...data} actionError={actionData?.error ?? null} /></s-page>;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
