import { createHash, randomUUID } from "node:crypto";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { actorFromShopifySession, appendActivity } from "../utils/activity-log.server";
import { useImportDirtyContext } from "../import-dirty-context";
import {
  CsvFormatError,
  parseCsvPreview,
  type CsvPreviewRow,
} from "../utils/csv.server";
import { MAX_CSV_BYTES, MAX_CSV_ROWS } from "../utils/csv-limits.js";
import {
  readRequestBodyLimited,
  RequestBodyTooLargeError,
} from "../utils/request-body.server";
import { getGraphQLData } from "../utils/shopify-graphql.server";
import {
  MergeImportError,
  mergeImportBatch,
} from "../utils/import-merge.server";
import {
  DuplicateImportPreviewError,
  ImportSubmissionConflictError,
  persistImportPreview,
} from "../utils/import-receipts.server";
import {
  loadShopifyLocationContext as queryLocations,
  type ShopifyLocation,
} from "../utils/shopify-locations.server";
import {
  missingScopesForGrant,
  queryGrantedScopes,
} from "../utils/shopify-scopes.server";
import {
  verifyImportBatchShopifyState,
} from "../utils/import-state-verification.server";

const SKU_BATCH_SIZE = 20;
const VARIANT_PAGE_SIZE = 100;
const MAX_LOOKUP_PAGES = 20;
const MAX_MERGE_LINES = 50;
const MAX_UPLOAD_REQUEST_BYTES = MAX_CSV_BYTES + 64 * 1024;
const SKU_LOOKUP_QUERY = `#graphql
  query StockHubImportSkuLookup($query: String!, $after: String, $locationId: ID!) {
    productVariants(first: ${VARIANT_PAGE_SIZE}, after: $after, query: $query) {
      edges {
        node {
          id sku title
          product { id title status }
          inventoryItem {
            id tracked
            inventoryLevel(locationId: $locationId) {
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type VariantMatch = {
  id: string;
  sku: string;
  title: string;
  product: { id: string; title: string; status: string };
  inventoryItem: {
    id: string;
    tracked: boolean;
    inventoryLevel: { quantities: Array<{ name: string; quantity: number }> } | null;
  };
};
type PreviewStatus = "READY" | "BLOCKED";
type AuthorizationStatus = "verified" | "unavailable" | "mismatch";
type PreparedLine = {
  row: CsvPreviewRow;
  operationType: "ADJUST" | "CREATE_DRAFT" | "BLOCKED";
  status: PreviewStatus;
  errorCode: string | null;
  errorDetail: string | null;
  match?: VariantMatch;
  expectedQuantity: number | null;
};
type ActionData = {
  error?: string;
  authorizationError?: string;
  duplicateImport?: {
    batchId: string;
    receiptCode: string;
    status: string;
    locationName: string;
    createdAt: Date;
  };
  verification?: Awaited<ReturnType<typeof verifyImportBatchShopifyState>>;
  mergeProgress?: {
    batchId: string;
    approvalId: string | null;
    approvalStatus: string | null;
    chunkNumber: number;
    continueRequired: boolean;
    status: string;
    paused?: boolean;
  };
};

const SCOPE_VERIFICATION_UNAVAILABLE =
  "StockHub could not verify current Shopify permissions. No preview or merge was started; refresh the embedded app and retry.";
const SCOPE_VERIFICATION_MISMATCH =
  "Shopify returned conflicting current permission grants for this store. StockHub has disabled validation and merging; refresh the embedded app and retry.";

function sameScopeGrant(left: readonly string[], right: readonly string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((scope) => rightSet.has(scope));
}

function safeHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { status?: unknown; response?: { status?: unknown } };
  const status = typeof value.status === "number" ? value.status : value.response?.status;
  return typeof status === "number" ? status : null;
}

async function lookupVariants(
  admin: AdminApiContext,
  skus: string[],
  locationId: string,
) {
  const matches = new Map<string, VariantMatch[]>();
  const incompleteSkus = new Set<string>();

  for (let start = 0; start < skus.length; start += SKU_BATCH_SIZE) {
    const batch = skus.slice(start, start + SKU_BATCH_SIZE);
    const searchQuery = batch.map((sku) => `sku:${JSON.stringify(sku)}`).join(" OR ");
    let after: string | null = null;
    let hasNextPage = true;
    let pageNumber = 0;

    while (hasNextPage && pageNumber < MAX_LOOKUP_PAGES) {
      const response: Response = await admin.graphql(SKU_LOOKUP_QUERY, {
        variables: { query: searchQuery, after, locationId },
      });
      const data: {
        productVariants: {
          edges: Array<{ node: VariantMatch }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } = await getGraphQLData(response);
      for (const { node } of data.productVariants.edges) {
        if (!batch.includes(node.sku)) continue;
        const current = matches.get(node.sku) ?? [];
        current.push(node);
        matches.set(node.sku, current);
      }
      hasNextPage = data.productVariants.pageInfo.hasNextPage;
      after = data.productVariants.pageInfo.endCursor;
      pageNumber += 1;
    }

    if (hasNextPage) {
      for (const sku of batch) incompleteSkus.add(sku);
    }
  }
  return { matches, incompleteSkus };
}

async function parseActionForm(request: Request) {
  const body = await readRequestBodyLimited(request, MAX_UPLOAD_REQUEST_BYTES);
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
  }).formData();
}

function resultLineFromPrepared(prepared: PreparedLine, id: string) {
  const { row, match } = prepared;
  return {
    id,
    rowNumber: row.rowNumber,
    sku: row.sku,
    title: row.title,
    description: row.description,
    price: row.price,
    imageUrl: row.image_url,
    quantity: row.quantity,
    operationType: prepared.operationType,
    status: prepared.status === "READY" ? "PREVIEWED" : "BLOCKED",
    stage: "PREPARED",
    operationId: randomUUID(),
    idempotencyKey: randomUUID(),
    productId: match?.product.id ?? null,
    variantId: match?.id ?? null,
    inventoryItemId: match?.inventoryItem.id ?? null,
    expectedQuantity: prepared.expectedQuantity,
    matchedProductTitle: match?.product.title ?? null,
    matchedVariantTitle: match?.title ?? null,
    errorCode: prepared.errorCode,
    errorDetail: prepared.errorDetail,
    shopifyProductUrl: null,
  };
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function draftCsvRowFromValues(values: string[], rowNumber: number) {
  const row = parseCsvPreview(`sku,quantity,title,price,description,image_url\n${values.map(csvCell).join(",")}`)[0];
  if (!row) throw new Error("Enter a valid import row.");
  return { ...row, rowNumber };
}

function draftCsvRow(formData: FormData, rowNumber: number) {
  return draftCsvRowFromValues(["sku", "quantity", "title", "price", "description", "image_url"]
    .map((key) => String(formData.get(key) ?? "")), rowNumber);
}

function savedLineAsCsvRow(line: { rowNumber: number; sku: string; quantity: number | null; title: string | null; price: string | null; description: string | null; imageUrl: string | null }) {
  return draftCsvRowFromValues([line.sku, line.quantity === null ? "" : String(line.quantity), line.title ?? "", line.price ?? "", line.description ?? "", line.imageUrl ?? ""], line.rowNumber);
}

async function prepareDraftLine(admin: AdminApiContext, row: CsvPreviewRow, locationId: string): Promise<PreparedLine> {
  if (row.errors.length) return { row, operationType: "BLOCKED", status: "BLOCKED", errorCode: "CSV_INVALID_ROW", errorDetail: row.errors.join(" "), expectedQuantity: null };
  let lookup: Awaited<ReturnType<typeof lookupVariants>>;
  try { lookup = await lookupVariants(admin, [row.sku], locationId); }
  catch { return { row, operationType: "BLOCKED", status: "BLOCKED", errorCode: "SKU_LOOKUP_INCOMPLETE", errorDetail: "Shopify SKU and location matching could not be completed. This row is blocked until it can be validated again.", expectedQuantity: null }; }
  if (lookup.incompleteSkus.has(row.sku)) return { row, operationType: "BLOCKED", status: "BLOCKED", errorCode: "SKU_LOOKUP_INCOMPLETE", errorDetail: "Shopify returned too many candidates to determine an exact SKU match safely.", expectedQuantity: null };
  const matches = lookup.matches.get(row.sku) ?? [];
  if (matches.length > 1) return { row, operationType: "BLOCKED", status: "BLOCKED", errorCode: "SKU_AMBIGUOUS", errorDetail: "More than one exact SKU match exists in this store.", expectedQuantity: null };
  if (matches.length === 1) {
    const match = matches[0]!;
    if (!match.inventoryItem.tracked) return { row, operationType: "BLOCKED", status: "BLOCKED", errorCode: "INVENTORY_NOT_TRACKED", errorDetail: "Inventory tracking is disabled for this variant.", match, expectedQuantity: null };
    const expectedQuantity = match.inventoryItem.inventoryLevel?.quantities.find((item) => item.name === "available")?.quantity;
    if (expectedQuantity === undefined) return { row, operationType: "BLOCKED", status: "BLOCKED", errorCode: "LOCATION_NOT_STOCKED", errorDetail: "This variant is not stocked at the selected location; the app will not activate existing inventory automatically.", match, expectedQuantity: null };
    return { row, operationType: "ADJUST", status: "READY", errorCode: null, errorDetail: null, match, expectedQuantity };
  }
  const missing = [...(!row.title ? ["title"] : []), ...(row.price === null ? ["price"] : [])];
  if (missing.length) return { row, operationType: "BLOCKED", status: "BLOCKED", errorCode: "NEW_PRODUCT_FIELDS_MISSING", errorDetail: `New SKU requires ${missing.join(" and ")}.`, expectedQuantity: null };
  return { row, operationType: "CREATE_DRAFT", status: "READY", errorCode: null, errorDetail: null, expectedQuantity: null };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin, scopes } = await authenticate.admin(request);
  const requestUrl = new URL(request.url);
  const legacyBatchId = requestUrl.searchParams.get("batchId");
  if (legacyBatchId) {
    requestUrl.pathname = `/app/imports/history/${encodeURIComponent(legacyBatchId)}`;
    requestUrl.searchParams.delete("batchId");
    return redirect(`${requestUrl.pathname}${requestUrl.search}`);
  }
  let locations: ShopifyLocation[] = [];
  let currencyCode: string | null = null;
  let locationStatus: "ready" | "missing_scope" | "error" = "error";
  let locationMessage: string | null = null;
  let shopDomain: string | null = null;
  let grantedScopes: string[] = [];
  let authorizationStatus: AuthorizationStatus = "verified";
  let authorizationMessage: string | null = null;
  try {
    grantedScopes = await queryGrantedScopes(scopes);
  } catch {
    authorizationStatus = "unavailable";
    authorizationMessage = SCOPE_VERIFICATION_UNAVAILABLE;
  }
  const installedScopes = [...grantedScopes];
  let missingLocationScopes: string[] = [];
  const locationContext = await queryLocations(admin);
  const locationScopes = locationContext.status === "error" ? null : locationContext.scopes;
  if (
    authorizationStatus === "verified" &&
    locationScopes &&
    !sameScopeGrant(grantedScopes, locationScopes)
  ) {
    authorizationStatus = "mismatch";
    authorizationMessage = SCOPE_VERIFICATION_MISMATCH;
    locationStatus = "error";
    locationMessage = SCOPE_VERIFICATION_MISMATCH;
  } else if (locationContext.status === "ready") {
    shopDomain = locationContext.shopDomain;
    const sessionShop = session.shop.toLowerCase();
    if (locationContext.shopDomain.toLowerCase() !== sessionShop) {
      locationMessage =
        "The authenticated Shopify session and Admin API returned different stores. Open StockHub from the intended store and reload before continuing.";
    } else {
      locationStatus = "ready";
      locations = locationContext.locations;
      currencyCode = locationContext.currencyCode;
      if (!locations.length) {
        locationMessage = "Shopify returned no active locations for this store. Add or activate a location in Shopify Admin, then reload.";
      }
    }
  } else {
    locationStatus = locationContext.status;
    locationMessage = locationContext.message;
    if (locationContext.status === "missing_scope") {
      missingLocationScopes = locationContext.missingScopes;
    }
  }

  if (authorizationStatus === "mismatch") {
    // Do not expose a location choice when Shopify's two current-grant
    // responses disagree, even if one query returned locations successfully.
    locations = [];
    currencyCode = null;
    missingLocationScopes = [];
  }

  const missingReadScopes = authorizationStatus === "verified"
    ? missingScopesForGrant(grantedScopes, ["read_products", "read_inventory"])
    : [];
  const missingWriteScopes = authorizationStatus === "verified"
    ? missingScopesForGrant(grantedScopes, ["write_inventory", "write_products"])
    : [];
  return {
    shop: session.shop,
    shopDomain,
    installedScopes,
    authorizationStatus,
    authorizationMessage,
    locations,
    currencyCode,
    locationStatus,
    locationMessage,
    missingLocationScopes,
    missingReadScopes,
    missingWriteScopes,
    submissionId: randomUUID(),
    maxMergeLines: MAX_MERGE_LINES,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin, scopes } = await authenticate.admin(request);
  let grantedScopes: string[];
  try {
    grantedScopes = await queryGrantedScopes(scopes);
  } catch (error) {
    const status = safeHttpStatus(error);
    const message = status === 401
      ? "Shopify authentication was rejected (401) while checking current permissions. Refresh the embedded app and retry."
      : status === 403
        ? "Shopify denied the current permission check (403). Reauthorize the app and retry."
        : SCOPE_VERIFICATION_UNAVAILABLE;
    return { authorizationError: message } satisfies ActionData;
  }
  let formData: FormData;
  try {
    formData = await parseActionForm(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { error: `CSV uploads are limited to ${MAX_CSV_BYTES.toLocaleString()} bytes.` } satisfies ActionData;
    }
    throw error;
  }

  const intent = formData.get("intent");
  if (intent === "draftAddLine" || intent === "draftEditLine" || intent === "draftDeleteLine") {
    const batchId = String(formData.get("batchId") ?? "");
    const expectedUpdatedAt = new Date(String(formData.get("expectedUpdatedAt") ?? ""));
    if (!batchId || Number.isNaN(expectedUpdatedAt.getTime())) return { error: "Refresh this draft before editing; its version could not be verified." } satisfies ActionData;
    const batch = await prisma.importBatch.findFirst({ where: { id: batchId, shop: session.shop }, include: { lines: { orderBy: { rowNumber: "asc" } } } });
    if (!batch) return { error: "This import receipt was not found in the authenticated store." } satisfies ActionData;
    if (batch.status !== "PREVIEWED" || batch.lines.some((line) => line.stage !== "PREPARED" || !["PREVIEWED", "BLOCKED"].includes(line.status))) return { error: "This draft is locked because Shopify processing has started." } satisfies ActionData;
    if (batch.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return { error: "This draft changed in another tab. Refresh it before making another edit." } satisfies ActionData;
    if (intent !== "draftDeleteLine") {
      const missing = missingScopesForGrant(grantedScopes, ["read_products", "read_inventory", "read_locations"]);
      if (missing.length) return { error: `Shopify authorization is missing: ${missing.join(", ")}. Reauthorize before validating this row.` } satisfies ActionData;
    }
    const lineId = String(formData.get("lineId") ?? "");
    const preparedLines: Array<{ id: string | null; prepared: PreparedLine; original: (typeof batch.lines)[number] | null }> = [];
    if (intent !== "draftDeleteLine") {
      const rowNumber = intent === "draftAddLine" ? Math.max(0, ...batch.lines.map((line) => line.rowNumber)) + 1 : batch.lines.find((line) => line.id === lineId)?.rowNumber;
      if (!rowNumber) return { error: "This draft row no longer exists. Refresh and try again." } satisfies ActionData;
      if (rowNumber > MAX_CSV_ROWS) return { error: `A draft cannot exceed ${MAX_CSV_ROWS} rows.` } satisfies ActionData;
      const original = intent === "draftEditLine" ? batch.lines.find((line) => line.id === lineId) ?? null : null;
      if (intent === "draftEditLine" && !original) return { error: "This draft row no longer exists. Refresh and try again." } satisfies ActionData;
      let row: CsvPreviewRow;
      try { row = draftCsvRow(formData, rowNumber); }
      catch (error) { return { error: error instanceof Error ? error.message : "The row could not be validated." } satisfies ActionData; }
      const locationContext = await queryLocations(admin);
      if (locationContext.status !== "ready" || locationContext.shopDomain.toLowerCase() !== session.shop.toLowerCase() || !locationContext.locations.some((location) => location.id === batch.locationId && location.isActive)) {
        return { error: "The draft location could not be verified for this store. No changes were saved." } satisfies ActionData;
      }
      if (!sameScopeGrant(grantedScopes, locationContext.scopes)) return { authorizationError: SCOPE_VERIFICATION_MISMATCH } satisfies ActionData;
      const candidateLines = batch.lines.filter((line) => line.id === lineId || line.sku === row.sku || line.sku === original?.sku);
      const candidates: Array<{ id: string; original: (typeof batch.lines)[number] | null; row: CsvPreviewRow }> = candidateLines.map((line) => ({ id: line.id, original: line, row: line.id === lineId ? row : savedLineAsCsvRow(line) }));
      if (intent === "draftAddLine") candidates.push({ id: "", original: null, row });
      const skuCounts = new Map<string, number>();
      for (const candidate of candidates) if (candidate.row.sku) skuCounts.set(candidate.row.sku, (skuCounts.get(candidate.row.sku) ?? 0) + 1);
      const newLineId = intent === "draftAddLine" ? randomUUID() : null;
      for (const candidate of candidates) {
        const duplicates = (skuCounts.get(candidate.row.sku) ?? 0) > 1;
        if (duplicates) candidate.row.errors.push(`SKU "${candidate.row.sku}" appears more than once in this draft.`);
        const prepared = await prepareDraftLine(admin, candidate.row, batch.locationId);
        if (candidate.original && candidate.original.sku === candidate.row.sku && candidate.original.productId && candidate.original.expectedQuantity !== null && prepared.operationType === "ADJUST") {
          // Keep the preview-time inventory baseline so an unrelated draft edit
          // cannot mask stock changes that the merge safety check must detect.
          prepared.expectedQuantity = candidate.original.expectedQuantity;
        }
        preparedLines.push({ id: candidate.id || newLineId, prepared, original: candidate.original });
      }
    } else {
      const target = batch.lines.find((line) => line.id === lineId && ["PREVIEWED", "BLOCKED"].includes(line.status) && line.stage === "PREPARED");
      if (!target) return { error: "Only unprocessed draft rows can be removed." } satisfies ActionData;
      const duplicateSiblings = batch.lines.filter((line) => line.id !== target.id && line.sku === target.sku && line.errorCode === "CSV_INVALID_ROW" && line.errorDetail?.includes("appears more than once"));
      if (duplicateSiblings.length) {
        const missing = missingScopesForGrant(grantedScopes, ["read_products", "read_inventory", "read_locations"]);
        if (missing.length) return { error: `Shopify authorization is missing: ${missing.join(", ")}. Reauthorize before revalidating duplicate rows.` } satisfies ActionData;
        const locationContext = await queryLocations(admin);
        if (locationContext.status !== "ready" || locationContext.shopDomain.toLowerCase() !== session.shop.toLowerCase() || !locationContext.locations.some((location) => location.id === batch.locationId && location.isActive)) return { error: "The draft location could not be verified for this store. No changes were saved." } satisfies ActionData;
        if (!sameScopeGrant(grantedScopes, locationContext.scopes)) return { authorizationError: SCOPE_VERIFICATION_MISMATCH } satisfies ActionData;
        for (const line of duplicateSiblings) {
          const row = savedLineAsCsvRow(line);
          const prepared = await prepareDraftLine(admin, row, batch.locationId);
          if (line.productId && line.expectedQuantity !== null && prepared.operationType === "ADJUST") prepared.expectedQuantity = line.expectedQuantity;
          preparedLines.push({ id: line.id, prepared, original: line });
        }
      }
    }
    try {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.importBatch.updateMany({ where: { id: batch.id, shop: session.shop, status: "PREVIEWED", revision: batch.revision, updatedAt: expectedUpdatedAt }, data: { revision: { increment: 1 }, updatedAt: new Date(Math.max(Date.now(), expectedUpdatedAt.getTime() + 1)) } });
        if (claimed.count !== 1) throw new Error("DRAFT_CONFLICT");
        if (intent === "draftAddLine" || intent === "draftEditLine") {
          for (const candidate of preparedLines) {
            const prepared = candidate.prepared;
            const keepPriorMatch = Boolean(candidate.original?.productId && candidate.original.sku === prepared.row.sku && prepared.status === "BLOCKED");
            const data = {
              sku: prepared.row.sku, title: prepared.row.title, description: prepared.row.description, price: prepared.row.price,
              imageUrl: prepared.row.image_url, quantity: prepared.row.quantity, operationType: prepared.operationType,
              status: prepared.status === "READY" ? "PREVIEWED" : "BLOCKED", stage: "PREPARED",
              productId: prepared.match?.product.id ?? (keepPriorMatch ? candidate.original!.productId : null),
              variantId: prepared.match?.id ?? (keepPriorMatch ? candidate.original!.variantId : null),
              inventoryItemId: prepared.match?.inventoryItem.id ?? (keepPriorMatch ? candidate.original!.inventoryItemId : null),
              expectedQuantity: prepared.match ? prepared.expectedQuantity : keepPriorMatch ? candidate.original!.expectedQuantity : prepared.expectedQuantity,
              matchedProductTitle: prepared.match?.product.title ?? (keepPriorMatch ? candidate.original!.matchedProductTitle : null),
              matchedVariantTitle: prepared.match?.title ?? (keepPriorMatch ? candidate.original!.matchedVariantTitle : null),
              errorCode: prepared.errorCode, errorDetail: prepared.errorDetail,
            };
            if (!candidate.original) {
              await tx.importLine.create({ data: { ...resultLineFromPrepared(prepared, candidate.id!), batchId: batch.id } });
            } else {
              const updated = await tx.importLine.updateMany({ where: { id: candidate.id!, batchId: batch.id, status: candidate.original.status, stage: "PREPARED" }, data });
              if (updated.count !== 1) throw new Error("DRAFT_CONFLICT");
            }
          }
        } else if (intent === "draftDeleteLine") {
          const deleted = await tx.importLine.deleteMany({ where: { id: lineId, batchId: batch.id, status: { in: ["PREVIEWED", "BLOCKED"] }, stage: "PREPARED" } });
          if (deleted.count !== 1) throw new Error("DRAFT_CONFLICT");
          for (const candidate of preparedLines) {
            const prepared = candidate.prepared;
            const keepPriorMatch = Boolean(candidate.original?.productId && candidate.original.sku === prepared.row.sku && prepared.status === "BLOCKED");
            const updated = await tx.importLine.updateMany({ where: { id: candidate.id!, batchId: batch.id, status: candidate.original!.status, stage: "PREPARED" }, data: {
              sku: prepared.row.sku, title: prepared.row.title, description: prepared.row.description, price: prepared.row.price,
              imageUrl: prepared.row.image_url, quantity: prepared.row.quantity, operationType: prepared.operationType,
              status: prepared.status === "READY" ? "PREVIEWED" : "BLOCKED", stage: "PREPARED",
              productId: prepared.match?.product.id ?? (keepPriorMatch ? candidate.original!.productId : null),
              variantId: prepared.match?.id ?? (keepPriorMatch ? candidate.original!.variantId : null),
              inventoryItemId: prepared.match?.inventoryItem.id ?? (keepPriorMatch ? candidate.original!.inventoryItemId : null),
              expectedQuantity: prepared.match ? prepared.expectedQuantity : keepPriorMatch ? candidate.original!.expectedQuantity : prepared.expectedQuantity,
              matchedProductTitle: prepared.match?.product.title ?? (keepPriorMatch ? candidate.original!.matchedProductTitle : null),
              matchedVariantTitle: prepared.match?.title ?? (keepPriorMatch ? candidate.original!.matchedVariantTitle : null),
              errorCode: prepared.errorCode, errorDetail: prepared.errorDetail,
            } });
            if (updated.count !== 1) throw new Error("DRAFT_CONFLICT");
          }
        }
        const actor = actorFromShopifySession(session);
        await tx.activityLog.create({ data: {
          id: randomUUID(), shop: session.shop, eventType: "IMPORT_DRAFT_LINE_EDITED", outcome: "SUCCEEDED",
          actorType: actor.actorType, actorId: actor.actorId, importBatchId: batch.id, importLineId: lineId || null,
          receiptCode: batch.receiptCode, summary: `${intent === "draftAddLine" ? "Added" : intent === "draftEditLine" ? "Updated" : "Removed"} an import draft line.`,
          metadataJson: JSON.stringify({ intent }), sourceKey: `draft:${randomUUID()}`,
        } });
      });
      return redirect(`/app/imports/history/${encodeURIComponent(batch.id)}?draft=${intent === "draftAddLine" ? "added" : intent === "draftEditLine" ? "updated" : "removed"}`);
    } catch (error) {
      return { error: error instanceof Error && error.message === "DRAFT_CONFLICT" ? "This draft changed or started processing in another tab. Refresh before continuing." : "The draft change could not be saved. No Shopify changes were made." } satisfies ActionData;
    }
  }
  if (intent === "verifyShopifyState") {
    const batchId = String(formData.get("batchId") ?? "");
    const batch = await prisma.importBatch.findFirst({
      where: { id: batchId, shop: session.shop },
      include: { lines: { orderBy: { rowNumber: "asc" } } },
    });
    if (!batch) return { error: "This import receipt was not found in the authenticated store." } satisfies ActionData;
    const missing = missingScopesForGrant(grantedScopes, ["read_products", "read_inventory", "read_locations"]);
    if (missing.length) {
      return { error: `Shopify authorization is missing: ${missing.join(", ")}. Reauthorize before verifying state.` } satisfies ActionData;
    }
    const locationContext = await queryLocations(admin);
    if (locationContext.status !== "ready") {
      const error = locationContext.status === "error" && locationContext.graphqlError
        ? "Shopify GraphQL rejected the location read. Confirm read_locations access and retry verification."
        : locationContext.status === "error" && locationContext.httpStatus === 401
          ? "Shopify authentication was rejected (401) while verifying the authorized location. Refresh the embedded app and retry."
          : locationContext.status === "error" && locationContext.httpStatus === 403
            ? "Shopify denied location access (403). Confirm the app's read_locations permission and reauthorize before retrying."
            : locationContext.message;
      return { error } satisfies ActionData;
    }
    if (!sameScopeGrant(grantedScopes, locationContext.scopes)) {
      return { authorizationError: SCOPE_VERIFICATION_MISMATCH } satisfies ActionData;
    }
    if (locationContext.shopDomain.toLowerCase() !== session.shop.toLowerCase()) {
      return { error: "The authenticated Shopify session and Admin API returned different stores. No verification was completed." } satisfies ActionData;
    }
    if (!locationContext.locations.some((location) => location.id === batch.locationId && location.isActive)) {
      return { error: "The receipt location is not active and authorized for this authenticated Shopify store." } satisfies ActionData;
    }
    const authorizedLocation = locationContext.locations.find((location) => location.id === batch.locationId && location.isActive)!;
    const verification = await verifyImportBatchShopifyState({
      admin,
      batch,
      locationId: batch.locationId,
      locationName: authorizedLocation.name,
      savedLocationName: batch.locationName,
      shop: session.shop,
    });
    const verifiedCount = verification.rows.filter((row) => row.classification === "SAFE_CANDIDATE").length;
    const blockedCount = verification.rows.filter((row) => row.classification === "BLOCKED").length;
    await appendActivity({
      shop: session.shop,
      actor: actorFromShopifySession(session),
      eventType: "SHOPIFY_STATE_VERIFIED",
      outcome: "SUCCEEDED",
      importBatchId: batch.id,
      receiptCode: batch.receiptCode,
      summary: `Read-only Shopify verification completed for ${batch.receiptCode}.`,
      metadata: { checkedRows: verification.rows.length, safeRows: verifiedCount, blockedRows: blockedCount },
    }, prisma);
    return { verification } satisfies ActionData;
  }

  const mergeIntent = typeof intent === "string" ? intent : "";
  if (["merge", "resume", "continueMerge", "resumeApprovedMerge", "pauseMerge"].includes(mergeIntent)) {
    const batchId = String(formData.get("batchId") ?? "");
    if (!batchId) return { error: "The import receipt identity is missing." } satisfies ActionData;
    const batch = await prisma.importBatch.findFirst({
      where: { id: batchId, shop: session.shop },
      include: { lines: { orderBy: { rowNumber: "asc" } } },
    });
    if (!batch) return { error: "This import receipt was not found in the authenticated store." } satisfies ActionData;

    const postedApprovalId = String(formData.get("approvalId") ?? "");
    if (mergeIntent === "pauseMerge") {
      if (!postedApprovalId || batch.activeMergeApprovalId !== postedApprovalId) {
        return { error: "This Pause request does not match the receipt's active approval." } satisfies ActionData;
      }
      const paused = await prisma.importMergeApproval.updateMany({
        where: { id: postedApprovalId, shop: session.shop, batchId, status: "ACTIVE" },
        data: { status: "PAUSED" },
      });
      const approval = await prisma.importMergeApproval.findFirst({ where: { id: postedApprovalId, shop: session.shop, batchId } });
      if (!approval || (paused.count !== 1 && approval.status !== "PAUSED")) {
        return { error: "The saved approval is no longer active; refresh to inspect its current state." } satisfies ActionData;
      }
      const actor = actorFromShopifySession(session);
      const pauseId = randomUUID();
      await appendActivity({
        shop: session.shop,
        actor,
        eventType: "IMPORT_MERGE_PAUSED",
        outcome: "SUCCEEDED",
        importBatchId: batch.id,
        receiptCode: batch.receiptCode,
        attemptId: pauseId,
        sourceKey: `attempt:${pauseId}:pause`,
        summary: `Automatic Merge continuation was paused for ${batch.receiptCode}. Completed Shopify changes remain in place.`,
        metadata: { approvalId: approval.id, chunkNumber: approval.chunkNumber, processedCount: approval.processedCount },
      }, prisma);
      return { mergeProgress: {
        batchId,
        approvalId: approval.id,
        approvalStatus: approval.status,
        chunkNumber: approval.chunkNumber,
        continueRequired: false,
        status: batch.status,
        paused: true,
      } } satisfies ActionData;
    }

    const initialConfirmation = mergeIntent === "merge" || mergeIntent === "resume";
    if (initialConfirmation && formData.get("confirmed") !== "yes") {
      return { error: "Explicit confirmation is required before writing to Shopify." } satisfies ActionData;
    }
    const eligibleLines = batch.lines.filter((line) => !["SUCCEEDED", "BLOCKED"].includes(line.status) && line.operationType !== "BLOCKED");
    const excludedLines = batch.lines.filter((line) => line.status === "BLOCKED" || line.operationType === "BLOCKED");
    const completedResumeReplay = mergeIntent === "resume"
      && batch.status === "COMPLETED"
      && batch.lines.length > 0
      && batch.lines.every((line) => line.status === "SUCCEEDED" && line.stage === "COMPLETED");
    if (initialConfirmation && ((eligibleLines.length === 0 && !completedResumeReplay)
      || String(formData.get("confirmedCount") ?? "") !== String(eligibleLines.length)
      || (excludedLines.length > 0 && formData.get("partialConfirmed") !== "yes"))) {
      return { error: "Confirm the current number of eligible rows and any excluded rows before merging." } satisfies ActionData;
    }
    if (mergeIntent === "merge" && eligibleLines.some((line) => !["PREVIEWED"].includes(line.status) || line.stage !== "PREPARED")) {
      return { error: "This receipt has failed or uncertain work. Use explicit Resume to reconcile it safely." } satisfies ActionData;
    }

    let serviceIntent: "continue" | "merge" | "resume" = "continue";
    if (mergeIntent === "merge" || mergeIntent === "resume") serviceIntent = mergeIntent;
    let confirmedLineIds: string[] = [];
    let expectedRevision: number | undefined;
    let approvalId: string | undefined;
    if (initialConfirmation) {
      const revision = Number(String(formData.get("expectedRevision") ?? ""));
      if (!Number.isSafeInteger(revision) || revision !== batch.revision) {
        return { error: "This receipt changed after the confirmation was prepared. Refresh and review the current eligible rows." } satisfies ActionData;
      }
      confirmedLineIds = eligibleLines.map((line) => line.id);
      expectedRevision = revision;
    } else {
      approvalId = postedApprovalId;
      if (!approvalId || batch.activeMergeApprovalId !== approvalId) {
        return { error: "This continuation does not match the receipt's active approval." } satisfies ActionData;
      }
      const approval = await prisma.importMergeApproval.findFirst({ where: { id: approvalId, shop: session.shop, batchId } });
      if (!approval) return { error: "The saved Merge approval was not found for this receipt." } satisfies ActionData;
      if (mergeIntent === "continueMerge" && approval.status === "COMPLETED") {
        // A browser may retry an auto-continue POST after losing its response.
        // Return the persisted terminal state without requiring write scopes,
        // creating another attempt record, or dispatching Shopify work.
        return { mergeProgress: {
          batchId,
          approvalId: approval.id,
          approvalStatus: approval.status,
          chunkNumber: approval.chunkNumber,
          continueRequired: false,
          status: batch.status,
        } } satisfies ActionData;
      }
      if (mergeIntent === "resumeApprovedMerge") {
        if (approval.status === "PAUSED") {
          const resumed = await prisma.importMergeApproval.updateMany({
            where: { id: approvalId, shop: session.shop, batchId, status: "PAUSED" },
            data: { status: "ACTIVE" },
          });
          if (resumed.count !== 1) return { error: "The saved approval changed while resuming. Refresh and retry." } satisfies ActionData;
        } else if (approval.status !== "ACTIVE") {
          return { error: "Only an active or paused saved approval can continue. Use explicit Resume to reconcile failed work." } satisfies ActionData;
        }
      } else if (approval.status !== "ACTIVE") {
        return { error: "This saved approval is not active. Refresh to inspect its current state." } satisfies ActionData;
      }
    }

    const needsProductWrite = eligibleLines.some(
      (line) => line.operationType === "CREATE_DRAFT" && !["VARIANT_PRICE_CONFIGURED", "INVENTORY_ACTIVATING", "INVENTORY_ACTIVE"].includes(line.stage),
    );
    const neededScopes = new Set(["read_products", "read_inventory", "read_locations", "write_inventory"]);
    if (needsProductWrite) neededScopes.add("write_products");
    const missing = missingScopesForGrant(grantedScopes, [...neededScopes]);
    if (missing.length) {
      return { error: `Shopify authorization is missing: ${missing.join(", ")}. Reauthorize the app before merging.` } satisfies ActionData;
    }
    const locationContext = await queryLocations(admin);
    if (locationContext.status !== "ready") return { error: locationContext.message } satisfies ActionData;
    if (!sameScopeGrant(grantedScopes, locationContext.scopes)) return { authorizationError: SCOPE_VERIFICATION_MISMATCH } satisfies ActionData;
    if (locationContext.shopDomain.toLowerCase() !== session.shop.toLowerCase()) {
      return { error: "The authenticated Shopify session and Admin API returned different stores. Open StockHub from the intended store and retry." } satisfies ActionData;
    }
    if (!locationContext.locations.some((location) => location.id === batch.locationId && location.isActive)) {
      return { error: "The selected location is not active and authorized for this authenticated Shopify store. No merge was started." } satisfies ActionData;
    }

    if (completedResumeReplay) {
      const replay = await mergeImportBatch({ shop: session.shop, batchId, admin, prisma, intent: "resume", confirmedLineIds: [], expectedRevision: batch.revision });
      return { mergeProgress: {
        batchId,
        approvalId: replay.approvalId,
        approvalStatus: replay.approvalStatus,
        chunkNumber: replay.chunkNumber,
        continueRequired: false,
        status: replay.status,
      } } satisfies ActionData;
    }

    const actor = actorFromShopifySession(session);
    const attemptId = randomUUID();
    const isResume = serviceIntent === "resume";
    const displayIntent = isResume ? "Resume" : "Merge";
    await appendActivity({
      shop: session.shop,
      actor,
      eventType: isResume ? "IMPORT_RESUME" : "IMPORT_MERGE_CHUNK",
      outcome: "ATTEMPTED",
      importBatchId: batch.id,
      receiptCode: batch.receiptCode,
      attemptId,
      sourceKey: `attempt:${attemptId}:start`,
      summary: `${displayIntent} chunk requested for ${batch.receiptCode}.`,
      metadata: { approvalId: approvalId ?? null, expectedRevision: expectedRevision ?? null },
    }, prisma);
    try {
      const result = await mergeImportBatch({
        shop: session.shop,
        batchId,
        admin,
        prisma,
        intent: serviceIntent,
        confirmedLineIds,
        expectedRevision,
        approvalId,
      });
      const changedLines = result.lines.filter((line) => {
        const previous = batch.lines.find((candidate) => candidate.id === line.id);
        return previous && previous.status !== line.status && previous.status !== "SUCCEEDED" && previous.status !== "BLOCKED";
      });
      const hasFailure = changedLines.some((line) => line.status === "FAILED");
      const hasUnknown = changedLines.some((line) => ["UNCERTAIN", "RUNNING"].includes(line.status));
      const outcome = hasUnknown ? "UNCERTAIN" : hasFailure ? "FAILED" : "SUCCEEDED";
      await prisma.$transaction(async (tx) => {
        await tx.activityLog.create({ data: {
          id: randomUUID(),
          shop: session.shop,
          eventType: "IMPORT_MERGE_CHUNK_RESULT",
          outcome,
          actorType: actor.actorType,
          actorId: actor.actorId,
          importBatchId: batch.id,
          receiptCode: batch.receiptCode,
          attemptId,
          sourceKey: `attempt:${attemptId}:result`,
          summary: `${displayIntent} chunk ${result.chunkNumber} for ${batch.receiptCode} finished: ${result.approvalStatus ?? result.status}.`,
          metadataJson: JSON.stringify({
            approvalId: result.approvalId,
            approvalStatus: result.approvalStatus,
            chunkNumber: result.chunkNumber,
            processedLines: changedLines.length,
            receiptLineCount: result.lines.length,
            successfulLines: changedLines.filter((line) => line.status === "SUCCEEDED").length,
            blockedLines: changedLines.filter((line) => line.status === "BLOCKED").length,
            failedLines: changedLines.filter((line) => line.status === "FAILED").length,
            uncertainLines: changedLines.filter((line) => ["UNCERTAIN", "RUNNING"].includes(line.status)).length,
            continueRequired: result.continueRequired,
          }),
        } });
        await tx.activityLog.createMany({ data: changedLines.map((line) => {
          const sku = line.sku || "unknown SKU";
          const quantity = line.quantity ?? 0;
          const lineOutcome = line.status === "SUCCEEDED" ? "SUCCEEDED"
            : line.status === "BLOCKED" ? "BLOCKED"
              : line.status === "UNCERTAIN" || line.status === "RUNNING" ? "UNCERTAIN" : "FAILED";
          const action = line.operationType === "CREATE_DRAFT"
            ? `Created a Draft product and added ${quantity} units for SKU ${sku}`
            : `Added ${quantity} units for SKU ${sku}`;
          return {
            id: randomUUID(),
            shop: session.shop,
            eventType: "IMPORT_LINE_RESULT",
            outcome: lineOutcome,
            actorType: actor.actorType,
            actorId: actor.actorId,
            importBatchId: batch.id,
            importLineId: line.id,
            receiptCode: batch.receiptCode,
            attemptId,
            sourceKey: `attempt:${attemptId}:line:${line.id}`,
            summary: lineOutcome === "SUCCEEDED" ? `${action}.` : `Import line for SKU ${sku} finished with ${line.status}; check Import History before retrying.`,
            metadataJson: JSON.stringify({ sku, quantity, operationType: line.operationType, stage: line.stage, errorCode: line.errorCode ?? null }),
          };
        }) });
      });
      return { mergeProgress: {
        batchId,
        approvalId: result.approvalId,
        approvalStatus: result.approvalStatus,
        chunkNumber: result.chunkNumber,
        continueRequired: result.continueRequired,
        status: result.status,
      } } satisfies ActionData;
    } catch (error) {
      const outcome = error instanceof MergeImportError && (error.code.startsWith("BATCH_") || error.code.startsWith("APPROVAL_"))
        ? "BLOCKED" : "UNCERTAIN";
      await appendActivity({
        shop: session.shop,
        actor,
        eventType: "IMPORT_MERGE_CHUNK_RESULT",
        outcome,
        importBatchId: batch.id,
        receiptCode: batch.receiptCode,
        attemptId,
        sourceKey: `attempt:${attemptId}:result`,
        summary: outcome === "BLOCKED"
          ? `${displayIntent} was blocked before processing ${batch.receiptCode}.`
          : `${displayIntent} outcome requires reconciliation for ${batch.receiptCode}.`,
        metadata: { approvalId: approvalId ?? null, errorCode: error instanceof MergeImportError ? error.code : "UNEXPECTED_ERROR" },
      }, prisma);
      return { error: error instanceof MergeImportError
        ? error.message
        : "The import could not be completed safely. Refresh to inspect its persisted status before retrying." } satisfies ActionData;
    }
  }

  if (intent !== "preview") return { error: "Unsupported CSV import action." } satisfies ActionData;
  const missingReadScopes = missingScopesForGrant(grantedScopes, ["read_products", "read_inventory"]);
  if (missingReadScopes.length) {
    return {
      error: `Shopify authorization is missing: ${missingReadScopes.join(", ")}. Reauthorize before previewing inventory.`,
    } satisfies ActionData;
  }

  const file = formData.get("file");
  const submissionId = String(formData.get("submissionId") ?? "").trim();
  const locationId = String(formData.get("locationId") ?? "").trim();
  if (typeof file === "string" || !file) return { error: "Choose a CSV file to preview." } satisfies ActionData;
  if (!file.name.toLowerCase().endsWith(".csv")) return { error: "The selected file must have a .csv extension." } satisfies ActionData;
  const allowedTypes = new Set([
    "text/csv",
    "application/csv",
    "application/vnd.ms-excel",
    "text/plain",
  ]);
  if (file.type && !allowedTypes.has(file.type.toLowerCase())) {
    return { error: "The selected file is not a supported CSV file." } satisfies ActionData;
  }
  if (file.size === 0) return { error: "The selected CSV file is empty." } satisfies ActionData;
  if (file.size > MAX_CSV_BYTES) return { error: `CSV files must be ${MAX_CSV_BYTES.toLocaleString()} bytes or smaller.` } satisfies ActionData;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) {
    return { error: "The upload form expired. Reload Imports and choose the CSV again." } satisfies ActionData;
  }
  if (!locationId) return { error: "Select a Shopify location before previewing." } satisfies ActionData;

  let source: string;
  let fileBytes: ArrayBuffer;
  try {
    fileBytes = await file.arrayBuffer();
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fileBytes);
  } catch {
    return { error: "The CSV file must use valid UTF-8 text encoding." } satisfies ActionData;
  }

  let parsedRows: CsvPreviewRow[];
  try {
    parsedRows = parseCsvPreview(source);
  } catch (error) {
    if (error instanceof CsvFormatError) return { error: error.message } satisfies ActionData;
    throw error;
  }

  const context = await queryLocations(admin);
  if (context.status !== "ready") {
    return { error: context.message } satisfies ActionData;
  }
  if (!sameScopeGrant(grantedScopes, context.scopes)) {
    return { authorizationError: SCOPE_VERIFICATION_MISMATCH } satisfies ActionData;
  }
  if (context.shopDomain.toLowerCase() !== session.shop.toLowerCase()) {
    return {
      error: "The authenticated Shopify session and Admin API returned different stores. Open StockHub from the intended store and retry.",
    } satisfies ActionData;
  }
  const location = context.locations.find((candidate) => candidate.id === locationId && candidate.isActive);
  if (!location) return { error: "Select an active location authorized for this authenticated Shopify store." } satisfies ActionData;

  const validSkus = [...new Set(parsedRows.filter((row) => row.errors.length === 0).map((row) => row.sku))];
  let lookup: Awaited<ReturnType<typeof lookupVariants>> | null = null;
  let lookupError: string | null = null;
  if (validSkus.length) {
    try {
      lookup = await lookupVariants(admin, validSkus, location.id);
    } catch {
      lookupError = "Shopify SKU and location matching could not be completed. Rows remain blocked.";
    }
  }

  const preparedRows: PreparedLine[] = parsedRows.map((row) => {
    if (row.errors.length) {
      return {
        row,
        operationType: "BLOCKED",
        status: "BLOCKED",
        errorCode: "CSV_INVALID_ROW",
        errorDetail: row.errors.join(" "),
        expectedQuantity: null,
      };
    }
    if (!lookup || lookupError) {
      return {
        row,
        operationType: "BLOCKED",
        status: "BLOCKED",
        errorCode: "SKU_LOOKUP_INCOMPLETE",
        errorDetail: lookupError ?? "Shopify SKU matching did not return a complete result.",
        expectedQuantity: null,
      };
    }
    if (lookup.incompleteSkus.has(row.sku)) {
      return {
        row,
        operationType: "BLOCKED",
        status: "BLOCKED",
        errorCode: "SKU_LOOKUP_INCOMPLETE",
        errorDetail: "Shopify returned too many candidates to determine an exact SKU match safely.",
        expectedQuantity: null,
      };
    }
    const matches = lookup.matches.get(row.sku) ?? [];
    if (matches.length > 1) {
      return {
        row,
        operationType: "BLOCKED",
        status: "BLOCKED",
        errorCode: "SKU_AMBIGUOUS",
        errorDetail: "More than one exact SKU match exists in this store.",
        expectedQuantity: null,
      };
    }
    if (matches.length === 1) {
      const match = matches[0]!;
      if (!match.inventoryItem.tracked) {
        return {
          row,
          operationType: "BLOCKED",
          status: "BLOCKED",
          errorCode: "INVENTORY_NOT_TRACKED",
          errorDetail: "Inventory tracking is disabled for this variant.",
          match,
          expectedQuantity: null,
        };
      }
      const level = match.inventoryItem.inventoryLevel;
      const expectedQuantity = level?.quantities.find((item) => item.name === "available")?.quantity;
      if (expectedQuantity === undefined) {
        return {
          row,
          operationType: "BLOCKED",
          status: "BLOCKED",
          errorCode: "LOCATION_NOT_STOCKED",
          errorDetail: "This variant is not stocked at the selected location; the app will not activate existing inventory automatically.",
          match,
          expectedQuantity: null,
        };
      }
      return {
        row,
        operationType: "ADJUST",
        status: "READY",
        errorCode: null,
        errorDetail: null,
        match,
        expectedQuantity,
      };
    }
    const missingFields = [
      ...(row.title ? [] : ["title"]),
      ...(row.price !== null ? [] : ["price"]),
    ];
    if (missingFields.length) {
      return {
        row,
        operationType: "BLOCKED",
        status: "BLOCKED",
        errorCode: "NEW_PRODUCT_FIELDS_MISSING",
        errorDetail: `New SKU requires ${missingFields.join(" and ")}.`,
        expectedQuantity: null,
      };
    }
    return {
      row,
      operationType: "CREATE_DRAFT",
      status: "READY",
      errorCode: null,
      errorDetail: null,
      expectedQuantity: null,
    };
  });

  try {
    const persisted = await persistImportPreview({
      shop: session.shop,
      actor: session.id,
      auditActor: actorFromShopifySession(session),
      submissionId,
      fileName: file.name,
      checksum: createHash("sha256").update(Buffer.from(fileBytes)).digest("hex"),
      originalCsv: source,
      location: { id: location.id, name: location.name },
      currencyCode: context.currencyCode,
      lines: preparedRows.map((row) => resultLineFromPrepared(row, randomUUID())),
      duplicateConfirmed: formData.get("duplicateConfirmed") === "yes",
    });
    return redirect(`/app/imports/history/${encodeURIComponent(persisted.batchId)}`);
  } catch (error) {
    return {
      duplicateImport: error instanceof DuplicateImportPreviewError ? error.duplicate : undefined,
      error: error instanceof ImportSubmissionConflictError
        ? error.message
        : error instanceof DuplicateImportPreviewError ? undefined
          : error instanceof Error ? error.message : "The import preview could not be saved.",
    } satisfies ActionData;
  }
};

export default function Imports() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  const navigation = useNavigation();
  const { setNewImportDirty } = useImportDirtyContext();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [duplicateConfirmation, setDuplicateConfirmation] = useState<{ file: File; locationId: string } | null>(null);
  const submittedSelectionRef = useRef<{ file: File | null; locationId: string; version: number } | null>(null);
  const selectionVersionRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const duplicateConfirmationValid = Boolean(actionData?.duplicateImport && duplicateConfirmation && selectedFile && duplicateConfirmation.file === selectedFile && duplicateConfirmation.locationId === selectedLocationId);
  useEffect(() => {
    if (!actionData?.duplicateImport) return;
    const submitted = submittedSelectionRef.current;
    if (!submitted?.file || !submitted.locationId || submitted.version !== selectionVersionRef.current) return;
    setDuplicateConfirmation({ file: submitted.file, locationId: submitted.locationId });
  }, [actionData?.duplicateImport]);
  const isSubmitting = navigation.state === "submitting";
  const previewDisabled =
    isSubmitting ||
    data.authorizationStatus !== "verified" ||
    !data.locations.length ||
    data.missingReadScopes.length > 0 ||
    data.missingLocationScopes.length > 0 ||
    data.locationStatus !== "ready";

  function invalidateDuplicateConfirmation() {
    selectionVersionRef.current += 1;
    setDuplicateConfirmation(null);
  }

  function updateNewImportDirty(form: HTMLFormElement | null) {
    const file = form?.querySelector<HTMLInputElement>('input[type="file"]');
    const locationId = form?.querySelector<HTMLSelectElement>('select[name="locationId"]');
    setNewImportDirty(Boolean(file?.files?.length || locationId?.value));
  }

  return (
    <div className="stockhub-import-new">
      <header className="stockhub-import-page-header">
        <div>
          <div className="stockhub-overview-eyebrow">StockHub imports</div>
          <h1>New import</h1>
          <p>Validate a stock CSV against an active Shopify location before you review and confirm its merge.</p>
          <p><Link to="/app/imports/catalog">Import a Product Catalog CSV</Link> — a separate draft workflow that does not update Shopify.</p>
        </div>
      </header>
      <div className="stockhub-hero-panel stockhub-import-workflow"><s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>Choose a CSV and an active location. StockHub validates rows and SKU matches, then saves a receipt for review. Validation does not write to Shopify; Merge is a separate, explicitly confirmed action on the receipt.</s-paragraph>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="small" accessibilityRole="region" accessibilityLabel="Import workflow">
            <s-box padding="small" background="subdued" borderRadius="base"><s-stack direction="inline" gap="small"><s-badge tone="info">1</s-badge><s-text type="strong">Upload</s-text></s-stack></s-box>
            <s-box padding="small" borderRadius="base"><s-stack direction="inline" gap="small"><s-badge>2</s-badge><s-text>Validate</s-text></s-stack></s-box>
            <s-box padding="small" borderRadius="base"><s-stack direction="inline" gap="small"><s-badge>3</s-badge><s-text>Review receipt</s-text></s-stack></s-box>
            <s-box padding="small" borderRadius="base"><s-stack direction="inline" gap="small"><s-badge>4</s-badge><s-text>Confirm merge</s-text></s-stack></s-box>
          </s-grid>
        </s-stack>
      </s-section></div>

      <div className="stockhub-panel stockhub-import-form-panel"><s-section heading="Upload and validate">
        <div className="stockhub-import-layout-grid">
          <div className="stockhub-import-main-col">
            <Form method="post" encType="multipart/form-data" data-import-preview-form="true"
              id="import-preview-form"
              aria-describedby={actionData?.error || actionData?.authorizationError ? "import-action-error" : undefined}
              onChange={(event) => { invalidateDuplicateConfirmation(); setSelectedLocationId(event.currentTarget.querySelector<HTMLSelectElement>('select[name="locationId"]')?.value ?? ""); updateNewImportDirty(event.currentTarget); }}
              onSubmit={() => { submittedSelectionRef.current = { file: selectedFile, locationId: selectedLocationId, version: selectionVersionRef.current }; }}>
              <input type="hidden" name="intent" value="preview" />
              <input type="hidden" name="submissionId" value={data.submissionId} />
              {duplicateConfirmationValid ? <input type="hidden" name="duplicateConfirmed" value="yes" /> : null}
              <s-stack direction="block" gap="base">
                <div className="stockhub-destination-badge">
                  <s-text type="strong">Import destination</s-text>
                  <span className="stockhub-current-shop-dot" />
                  <span>Store: {data.shop}</span>
                  {data.shopDomain ? <span className="stockhub-shop-domain">({data.shopDomain})</span> : null}
                </div>
                <div className="stockhub-field-group">
                  <label htmlFor="location-id" className="stockhub-field-label"><strong>Shopify location</strong></label>
                  <div className="stockhub-select-wrap">
                    <select id="location-id" name="locationId" required defaultValue="" aria-describedby="location-help">
                      <option value="" disabled>Select an active location</option>
                      {data.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                    </select>
                  </div>
                  <s-paragraph id="location-help">Used to check exact SKU matches and inventory availability.</s-paragraph>
                </div>

                <div className="stockhub-field-group">
                  <label htmlFor="csv-file" className="stockhub-field-label"><strong>CSV file</strong></label>
                  <div
                    className={`stockhub-import-upload stockhub-dropzone ${isDragging ? "stockhub-dropzone--dragging" : ""} ${selectedFile ? "stockhub-dropzone--has-file" : ""}`}
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDragging(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file) {
                        invalidateDuplicateConfirmation();
                        setSelectedFile(file);
                        const input = document.getElementById("csv-file") as HTMLInputElement;
                        if (input) {
                          const dt = new DataTransfer();
                          dt.items.add(file);
                          input.files = dt.files;
                          updateNewImportDirty(input.form);
                        }
                      }
                    }}
                  >
                    <input
                      id="csv-file"
                      type="file"
                      name="file"
                      accept=".csv,text/csv"
                      aria-describedby="csv-file-help"
                      required
                      onChange={(event) => {
                        setSelectedFile(event.currentTarget.files?.[0] ?? null);
                        updateNewImportDirty(event.currentTarget.form);
                      }}
                    />
                    {!selectedFile ? (
                      <div className="stockhub-dropzone-content">
                        <div className="stockhub-dropzone-icon" aria-hidden="true">
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                          </svg>
                        </div>
                        <div className="stockhub-dropzone-text">
                          <strong>Choose your stock file</strong> or drag and drop here
                        </div>
                        <span className="stockhub-dropzone-subtext">UTF-8 CSV up to 5 MB</span>
                      </div>
                    ) : (
                      <div className="stockhub-dropzone-file-card">
                        <div className="stockhub-file-card-icon" aria-hidden="true">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <line x1="16" y1="13" x2="8" y2="13" />
                            <line x1="16" y1="17" x2="8" y2="17" />
                          </svg>
                        </div>
                        <div className="stockhub-file-card-info">
                          <strong className="stockhub-file-card-name">{selectedFile.name}</strong>
                          <span className="stockhub-file-card-size">
                            {(selectedFile.size / 1024).toFixed(1)} KB · Ready to validate
                          </span>
                        </div>
                        <button
                          type="button"
                          className="stockhub-file-card-remove"
                          onClick={() => {
                            invalidateDuplicateConfirmation();
                            setSelectedFile(null);
                            const input = document.getElementById("csv-file") as HTMLInputElement;
                            if (input) {
                              input.value = "";
                              updateNewImportDirty(input.form);
                            }
                          }}
                        >
                          Change file
                        </button>
                      </div>
                    )}
                    {selectedFile ? <s-banner tone="info">Selected: <strong>{selectedFile.name}</strong> · {selectedFile.size.toLocaleString()} bytes</s-banner> : null}
                  </div>
                  <s-paragraph id="csv-file-help">UTF-8 CSV only. Required columns: <code>sku</code>, <code>quantity</code>. New products also need <code>title</code> and <code>price</code>.</s-paragraph>
                </div>

                <div className="stockhub-import-actions">
                  <s-button type="submit" variant="primary" disabled={previewDisabled}>{isSubmitting ? "Validating CSV…" : duplicateConfirmationValid ? "Confirm separate stock receipt" : "Validate and create preview receipt"}</s-button>
                </div>
              </s-stack>
            </Form>
          </div>
          <aside className="stockhub-import-side-col" aria-label="CSV import guidance">
            <div className="stockhub-guidance-card">
              <s-text type="strong">Before you upload</s-text>
              <s-paragraph>Required columns: <code>sku</code>, <code>quantity</code>. New products also need <code>title</code> and <code>price</code>. Optional columns: <code>description</code>, <code>image_url</code>.</s-paragraph>
              <s-paragraph>Maximum {MAX_CSV_BYTES.toLocaleString()} bytes and {MAX_CSV_ROWS.toLocaleString()} data rows. Inventory changes run in server-bounded chunks of up to {data.maxMergeLines} rows after one explicit confirmation; do not split a larger file.</s-paragraph>
              <div className="stockhub-guidance-note">
                <strong>Validation safety:</strong> Validating does not modify products or inventory in Shopify. A receipt is generated for your review first.
              </div>
            </div>
          </aside>
        </div>
        {data.authorizationMessage ? (
          <s-banner tone="critical">{data.authorizationMessage}</s-banner>
        ) : null}
        {data.locationMessage && data.authorizationStatus !== "mismatch" ? (
          <s-banner tone={data.locationStatus === "missing_scope" ? "critical" : "warning"}>
            {data.locationMessage}
            {data.missingLocationScopes.length ? ` Missing location-read scopes: ${data.missingLocationScopes.join(" or ")}.` : ""}
          </s-banner>
        ) : null}
        {data.locationStatus === "ready" && !data.locations.length ? (
          <s-banner tone="warning">The location request succeeded, but Shopify returned zero active locations. This is different from an API or authorization failure.</s-banner>
        ) : null}
        {data.missingReadScopes.length ? (
          <s-banner tone="critical">Read authorization missing: {data.missingReadScopes.join(", ")}. Reauthorize this app before previewing inventory.</s-banner>
        ) : null}
        {data.missingWriteScopes.length ? (
          <s-banner tone="warning">Merge remains disabled until Shopify authorizes the required write scopes: {data.missingWriteScopes.join(", ")}.</s-banner>
        ) : null}
        <div role="status" aria-live="polite" aria-atomic="true">
          {isSubmitting ? "Validating CSV, checking Shopify SKU matches, and saving the preview receipt. No Shopify changes are being made." : ""}
        </div>
        {actionData?.error || actionData?.authorizationError ? (
          <div id="import-action-error">
            <s-banner tone="critical">{actionData.authorizationError ?? actionData.error}</s-banner>
          </div>
        ) : null}
        {duplicateConfirmationValid && actionData?.duplicateImport ? (
          <s-banner tone="warning">
            <s-heading>Duplicate CSV Detected</s-heading>
            This file has already been uploaded to StockHub as receipt <Link to={`/app/imports/history/${encodeURIComponent(actionData.duplicateImport.batchId)}`}>{actionData.duplicateImport.receiptCode}</Link> ({actionData.duplicateImport.status}, {actionData.duplicateImport.locationName}). No duplicate batch was created.
            <s-paragraph>Open the earlier receipt instead. If this is a distinct stock receipt, keep the same file selected and explicitly confirm a separate stock receipt.</s-paragraph>
          </s-banner>
        ) : null}
      </s-section></div>

    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
