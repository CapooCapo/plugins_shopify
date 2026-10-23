import { createHash, randomUUID } from "node:crypto";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useState } from "react";
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
  verification?: Awaited<ReturnType<typeof verifyImportBatchShopifyState>>;
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
    duplicateCsv: requestUrl.searchParams.get("duplicateCsv") === "1",
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

  if (intent === "merge" || intent === "resume") {
    if (formData.get("confirmed") !== "yes") {
      return { error: "Explicit confirmation is required before writing to Shopify." } satisfies ActionData;
    }
    const batchId = String(formData.get("batchId") ?? "");
    const batch = await prisma.importBatch.findFirst({
      where: { id: batchId, shop: session.shop },
      include: { lines: { orderBy: { rowNumber: "asc" } } },
    });
    if (!batch) return { error: "This import receipt was not found in the authenticated store." } satisfies ActionData;
    if (
      batch.status === "PREVIEWED" &&
      batch.lines.some((line) => line.status === "BLOCKED" || line.operationType === "BLOCKED")
    ) {
      return { error: "This preview has invalid or blocked rows. Correct the CSV and preview it again before merging." } satisfies ActionData;
    }
    const neededScopes = new Set(["read_products", "read_inventory", "read_locations", "write_inventory"]);
    const needsProductWrite = batch.lines.some(
      (line) =>
        line.operationType === "CREATE_DRAFT" &&
        !["SUCCEEDED", "BLOCKED"].includes(line.status) &&
        !["INVENTORY_ITEM_CONFIGURING", "VARIANT_PRICE_CONFIGURED", "INVENTORY_ACTIVATING", "INVENTORY_ACTIVE"].includes(line.stage),
    );
    if (needsProductWrite) neededScopes.add("write_products");
    const missing = missingScopesForGrant(grantedScopes, [...neededScopes]);
    if (missing.length) {
      return {
        error: `Shopify authorization is missing: ${missing.join(", ")}. Reauthorize the app before merging.`,
      } satisfies ActionData;
    }
    const locationContext = await queryLocations(admin);
    if (locationContext.status !== "ready") {
      return { error: locationContext.message } satisfies ActionData;
    }
    if (!sameScopeGrant(grantedScopes, locationContext.scopes)) {
      return { authorizationError: SCOPE_VERIFICATION_MISMATCH } satisfies ActionData;
    }
    if (locationContext.shopDomain.toLowerCase() !== session.shop.toLowerCase()) {
      return {
        error: "The authenticated Shopify session and Admin API returned different stores. Open StockHub from the intended store and retry.",
      } satisfies ActionData;
    }
    if (!locationContext.locations.some((location) => location.id === batch.locationId && location.isActive)) {
      return {
        error: "The selected location is not active and authorized for this authenticated Shopify store. No merge was started.",
      } satisfies ActionData;
    }
    const attemptId = randomUUID();
    const actor = actorFromShopifySession(session);
    await appendActivity({
      shop: session.shop,
      actor,
      eventType: intent === "merge" ? "IMPORT_MERGE" : "IMPORT_RESUME",
      outcome: "ATTEMPTED",
      importBatchId: batch.id,
      receiptCode: batch.receiptCode,
      attemptId,
      sourceKey: `attempt:${attemptId}:start`,
      summary: `${intent === "merge" ? "Merge" : "Resume"} started for ${batch.receiptCode}.`,
    }, prisma);
    try {
      const result = await mergeImportBatch({
        shop: session.shop,
        batchId,
        admin,
        prisma,
      });
      const outcome = result.status === "COMPLETED" ? "SUCCEEDED"
        : result.status === "UNCERTAIN" ? "UNCERTAIN" : "FAILED";
      await prisma.$transaction(async (tx) => {
        const successfulLines = result.lines.filter((line) => line.status === "SUCCEEDED");
        const blockedLines = result.lines.filter((line) => line.status === "BLOCKED");
        const activityLines = result.lines.filter((line) => {
          const previous = batch.lines.find((candidate) => candidate.id === line.id)?.status;
          return previous !== "SUCCEEDED" && previous !== "BLOCKED";
        });
        await tx.activityLog.create({
          data: {
            id: randomUUID(),
            shop: session.shop,
            eventType: "IMPORT_RESULT",
            outcome,
            actorType: actor.actorType,
            actorId: actor.actorId,
            importBatchId: batch.id,
            receiptCode: batch.receiptCode,
            attemptId,
            sourceKey: `attempt:${attemptId}:result`,
            summary: `${intent === "merge" ? "Merge" : "Resume"} finished for ${batch.receiptCode}: ${result.status}.`,
            metadataJson: JSON.stringify({
              lineCount: result.lines.length,
              successfulLines: successfulLines.length,
              blockedLines: blockedLines.length,
              failedLines: result.lines.filter((line) => line.status === "FAILED").length,
              uncertainLines: result.lines.filter((line) => line.status === "UNCERTAIN").length,
            }),
          },
        });
        await tx.activityLog.createMany({
          data: activityLines.map((line) => {
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
              summary: lineOutcome === "SUCCEEDED"
                ? `${action}.`
                : `Import line for SKU ${sku} finished with ${line.status}; check Import History before retrying.`,
              metadataJson: JSON.stringify({
                sku,
                quantity,
                operationType: line.operationType,
                stage: line.stage,
                errorCode: line.errorCode ?? null,
              }),
            };
          }),
        });
      });
      return redirect(`/app/imports/history/${encodeURIComponent(batchId)}`);
    } catch (error) {
      const outcome = error instanceof MergeImportError && error.code.startsWith("BATCH_")
        ? "BLOCKED"
        : "UNCERTAIN";
      await appendActivity({
        shop: session.shop,
        actor,
        eventType: "IMPORT_RESULT",
        outcome,
        importBatchId: batch.id,
        receiptCode: batch.receiptCode,
        attemptId,
        sourceKey: `attempt:${attemptId}:result`,
        summary: outcome === "BLOCKED"
          ? `${intent === "merge" ? "Merge" : "Resume"} was blocked before processing ${batch.receiptCode}.`
          : `${intent === "merge" ? "Merge" : "Resume"} outcome requires reconciliation for ${batch.receiptCode}.`,
        metadata: { errorCode: error instanceof MergeImportError ? error.code : "UNEXPECTED_ERROR" },
      }, prisma);
      return {
        error:
          error instanceof MergeImportError
            ? error.message
            : "The import could not be completed safely. Refresh to inspect its persisted status before retrying.",
      } satisfies ActionData;
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
    source = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes);
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
      location: { id: location.id, name: location.name },
      currencyCode: context.currencyCode,
      lines: preparedRows.map((row) => resultLineFromPrepared(row, randomUUID())),
    });
    const duplicateFlag = persisted.duplicateCsv ? "?duplicateCsv=1" : "";
    return redirect(`/app/imports/history/${encodeURIComponent(persisted.batchId)}${duplicateFlag}`);
  } catch (error) {
    return {
      error: error instanceof ImportSubmissionConflictError
        ? error.message
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
  const [isDragging, setIsDragging] = useState(false);
  const isSubmitting = navigation.state === "submitting";
  const previewDisabled =
    isSubmitting ||
    data.authorizationStatus !== "verified" ||
    !data.locations.length ||
    data.missingReadScopes.length > 0 ||
    data.missingLocationScopes.length > 0 ||
    data.locationStatus !== "ready";

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
              onChange={(event) => updateNewImportDirty(event.currentTarget)}>
              <input type="hidden" name="intent" value="preview" />
              <input type="hidden" name="submissionId" value={data.submissionId} />
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
                  <s-button type="submit" variant="primary" disabled={previewDisabled}>{isSubmitting ? "Validating CSV…" : "Validate and create preview receipt"}</s-button>
                </div>
              </s-stack>
            </Form>
          </div>
          <aside className="stockhub-import-side-col" aria-label="CSV import guidance">
            <div className="stockhub-guidance-card">
              <s-text type="strong">Before you upload</s-text>
              <s-paragraph>Required columns: <code>sku</code>, <code>quantity</code>. New products also need <code>title</code> and <code>price</code>. Optional columns: <code>description</code>, <code>image_url</code>.</s-paragraph>
              <s-paragraph>Maximum {MAX_CSV_BYTES.toLocaleString()} bytes and {MAX_CSV_ROWS} data rows. A maximum of {data.maxMergeLines} lines can be merged at once.</s-paragraph>
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
        {data.duplicateCsv ? (
          <s-banner tone="warning">This CSV matches an earlier upload in this store. A new receipt was created for this submission; verify that it represents a separate valid stock intake before merging.</s-banner>
        ) : null}
      </s-section></div>

    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
