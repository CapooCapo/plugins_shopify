import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const VERIFY_QUERY = `#graphql
  query StockHubVerifyImportState($ids: [ID!]!, $locationId: ID!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        status
        metafield(namespace: "$app", key: "stockhub_import_operation") { value }
      }
      ... on ProductVariant {
        id
        sku
        product {
          id
          status
          metafield(namespace: "$app", key: "stockhub_import_operation") { value }
        }
        inventoryItem {
          id
          tracked
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  }
`;

type VerifyLine = {
  id?: string;
  rowNumber: number;
  sku: string;
  operationType: string;
  status: string;
  stage: string;
  errorCode: string | null;
  operationId: string;
  productId: string | null;
  variantId: string | null;
  inventoryItemId: string | null;
};

type ShopifyVariant = {
  id: string;
  sku: string | null;
  product: { id: string; status: string; metafield: { value: string } | null } | null;
  inventoryItem: {
    id: string;
    tracked: boolean;
    inventoryLevel: { quantities: Array<{ name: string; quantity: number }> } | null;
  } | null;
};

export type VerificationRow = {
  id?: string;
  rowNumber: number;
  sku: string;
  classification: "BLOCKED" | "SAFE_CANDIDATE" | "UNCERTAIN";
  reasons: string[];
  checks?: {
    productIdMatch: boolean;
    variantIdMatch: boolean;
    inventoryItemIdMatch: boolean;
    operationMarkerMatch: boolean;
    productStatus: string;
    tracked: boolean;
    inventoryLevelPresent: boolean;
    availableQuantity: number | null;
  };
};

export type VerificationReport = {
  verifiedAt: string;
  counts: { BLOCKED: number; SAFE_CANDIDATE: number; UNCERTAIN: number };
  rows: VerificationRow[];
  copyText: string;
};

const apiReason = "Shopify state could not be read completely; this row remains uncertain.";

function isVariant(value: unknown): value is ShopifyVariant {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ShopifyVariant>;
  return typeof item.id === "string" && (typeof item.sku === "string" || item.sku === null) &&
    !!item.product && typeof item.product.id === "string" &&
    typeof item.product.status === "string" && !!item.inventoryItem &&
    typeof item.inventoryItem.id === "string" && typeof item.inventoryItem.tracked === "boolean" &&
    (item.inventoryItem.inventoryLevel === null ||
      (typeof item.inventoryItem.inventoryLevel === "object" && Array.isArray(item.inventoryItem.inventoryLevel.quantities)));
}

async function readVariants(admin: AdminApiContext, lines: VerifyLine[], locationId: string) {
  const ids = [...new Set(lines.flatMap((line) => [line.productId, line.variantId].filter((id): id is string => Boolean(id))))];
  const variants = new Map<string, ShopifyVariant | null>();
  for (const line of lines) if (!line.variantId) variants.set(line.id ?? `${line.rowNumber}`, null);
  if (!ids.length) return variants;
  const response = await admin.graphql(VERIFY_QUERY, {
    variables: { ids, locationId },
  });
  if (!response.ok) throw new Error(response.status === 401 ? "SHOPIFY_401" : response.status === 403 ? "SHOPIFY_403" : "SHOPIFY_HTTP_ERROR");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Incomplete Shopify response");
  const result = body as { data?: { nodes?: unknown[] }; errors?: unknown[] };
  if (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length)) throw new Error("SHOPIFY_GRAPHQL_ERROR");
  if (!Array.isArray(result.data?.nodes) || result.data.nodes.length !== ids.length) throw new Error("Incomplete Shopify response");
  // nodes preserves input order. Indexing by the saved ID lets an unexpected
  // returned identity be classified as a confirmed mismatch.
  result.data.nodes.forEach((node, index) => {
    const requestedId = ids[index]!;
    if (requestedId.startsWith("gid://shopify/ProductVariant/")) {
      if (node === null) variants.set(requestedId, null);
      else if (isVariant(node)) variants.set(requestedId, node);
      else throw new Error("Incomplete Shopify variant");
    }
  });
  return variants;
}

/** Reads current Shopify state only. It never changes receipt or Shopify state. */
export async function verifyShopifyState(input: {
  admin: AdminApiContext;
  locationId: string;
  lines: VerifyLine[];
}): Promise<VerificationReport> {
  const rows: VerificationRow[] = [];
  let variants: Map<string, ShopifyVariant | null> | null = null;
  let readFailure: string | null = null;
  try {
    variants = await readVariants(input.admin, input.lines, input.locationId);
  } catch (error) {
    readFailure = error instanceof Error ? error.message : "";
  }
  for (const line of input.lines) {
    const reasons: string[] = [];
    let classification: VerificationRow["classification"] = "UNCERTAIN";
    let checks: VerificationRow["checks"];
    try {
      if (!variants) throw new Error(readFailure ?? "Incomplete Shopify response");
      const variant = variants.get(line.variantId ?? line.id ?? `${line.rowNumber}`);
      if (!variant) {
        classification = "BLOCKED";
        reasons.push("Saved Shopify variant target is missing.");
      } else {
        const product = variant.product!;
        const inventory = variant.inventoryItem!;
        const productIdMatch = product.id === line.productId;
        const variantIdMatch = variant.id === line.variantId;
        const inventoryItemIdMatch = inventory.id === line.inventoryItemId;
        const operationMarkerMatch = product.metafield?.value === line.operationId;
        const matches = variantIdMatch && productIdMatch && inventoryItemIdMatch;
        if (!matches) reasons.push("Current Shopify target IDs do not match the saved import receipt.");
        if (variant.sku !== line.sku) reasons.push("Current SKU does not match the saved import row.");
        if (product.status !== "DRAFT" && line.operationType === "CREATE_DRAFT") reasons.push("Created product is no longer Draft.");
        if (!inventory.tracked) reasons.push("Inventory tracking is disabled for the saved variant.");
        if (!operationMarkerMatch && line.operationType === "CREATE_DRAFT") reasons.push("Product import-operation marker does not match this receipt row.");

        const inventoryLevel = inventory.inventoryLevel;
        const availableQuantity = inventoryLevel?.quantities.find((item) => item.name === "available")?.quantity ?? null;
        checks = { productIdMatch, variantIdMatch, inventoryItemIdMatch, operationMarkerMatch, productStatus: product.status, tracked: inventory.tracked, inventoryLevelPresent: inventoryLevel !== null, availableQuantity };
        const recoverableActivationFailure = line.operationType === "CREATE_DRAFT" &&
          line.status === "FAILED" && line.stage === "INVENTORY_ACTIVATING" &&
          line.errorCode === "INVENTORY_ACTIVATE_USER_ERROR";
        if (recoverableActivationFailure && inventoryLevel !== null) {
          reasons.push("Inventory is already present at the selected location; a prior activation may have succeeded.");
        }
        if (line.operationType === "ADJUST" && ["FAILED", "UNCERTAIN", "RUNNING", "SUCCEEDED"].includes(line.status)) {
          reasons.push("An inventory adjustment was attempted or may have been attempted; read state cannot prove whether it applied.");
        }
        if (line.operationType === "CREATE_DRAFT" && !recoverableActivationFailure && line.status !== "BLOCKED") {
          reasons.push("This product operation is not the known failed activation case eligible for a safe retry candidate.");
        }
        const confirmedMismatch = !matches || variant.sku !== line.sku ||
          (line.operationType === "CREATE_DRAFT" && (product.status !== "DRAFT" || !operationMarkerMatch)) ||
          !inventory.tracked;
        if (confirmedMismatch) classification = "BLOCKED";
        else if (recoverableActivationFailure && inventoryLevel === null) {
          classification = "SAFE_CANDIDATE";
          reasons.push("Exact saved Draft targets and operation marker match; no inventory level exists at the authorized location.");
        } else if (reasons.length === 0) {
          reasons.push("Read-only state does not establish that retrying is safe.");
        }
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : readFailure ?? "";
      reasons.push(code === "SHOPIFY_401"
        ? "Shopify authentication was rejected (401); refresh the embedded app and retry verification. No retry or mutation is authorized."
        : code === "SHOPIFY_403" || code === "SHOPIFY_GRAPHQL_ERROR"
          ? "Shopify denied or rejected the state read (403/GraphQL error); confirm current read permissions and retry. No retry or mutation is authorized."
          : apiReason);
    }
    if (line.status === "SUCCEEDED" && variants !== null && readFailure === null) {
      classification = "BLOCKED";
      reasons.push("This import row is already marked Succeeded and is not retryable.");
    }
    rows.push({ id: line.id, rowNumber: line.rowNumber, sku: line.sku, classification, reasons, checks });
  }
  const counts = {
    BLOCKED: rows.filter((row) => row.classification === "BLOCKED").length,
    SAFE_CANDIDATE: rows.filter((row) => row.classification === "SAFE_CANDIDATE").length,
    UNCERTAIN: rows.filter((row) => row.classification === "UNCERTAIN").length,
  };
  const verifiedAt = new Date().toISOString();
  const copyText = [
    `Shopify state verification: ${verifiedAt}`,
    `Blocked: ${counts.BLOCKED}; safe candidates: ${counts.SAFE_CANDIDATE}; uncertain: ${counts.UNCERTAIN}`,
    ...rows.map((row) => `Row ${row.rowNumber} (${row.sku}): ${row.classification} — ${row.reasons.join(" ")}`),
    "Read-only report; this is not authorization to resume or merge.",
  ].join("\n");
  return { verifiedAt, counts, rows, copyText };
}

export async function verifyImportBatchShopifyState(input: {
  admin: AdminApiContext;
  batch: { id?: string; receiptCode?: string; locationName?: string; lines: VerifyLine[] };
  locationId: string;
  locationName?: string;
  savedLocationName?: string;
  shop?: string;
  now?: () => Date;
}) {
  const report = await verifyShopifyState({ admin: input.admin, locationId: input.locationId, lines: input.batch.lines });
  if (input.now) report.verifiedAt = input.now().toISOString();
  const lines = report.rows;
  const safeMessage = "Read-only verification only; uncertain rows are not safe to retry or mutate.";
  const copyText = [
    `Receipt: ${input.batch.receiptCode ?? "Import receipt"}`,
    `Location: ${input.locationName ?? input.batch.locationName ?? "Authorized receipt location"}`,
    ...(input.savedLocationName && input.locationName && input.savedLocationName !== input.locationName
      ? [`Saved receipt location: ${input.savedLocationName}`]
      : []),
    `Shopify state verification: ${report.verifiedAt}`,
    `Blocked: ${report.counts.BLOCKED}; safe candidates: ${report.counts.SAFE_CANDIDATE}; uncertain: ${report.counts.UNCERTAIN}`,
    ...lines.map((row) => {
      const checks = row.checks
        ? `Checks: product ID match ${row.checks.productIdMatch}; variant ID match ${row.checks.variantIdMatch}; inventory item ID match ${row.checks.inventoryItemIdMatch}; operation marker match ${row.checks.operationMarkerMatch}; product status ${row.checks.productStatus}; tracked ${row.checks.tracked}; inventory level present ${row.checks.inventoryLevelPresent}; available quantity ${row.checks.availableQuantity ?? "unavailable"}.`
        : "Checks: current Shopify fields unavailable.";
      return `Row ${row.rowNumber} (${row.sku}): ${row.classification} — ${checks} ${row.reasons.join(" ")}`;
    }),
    safeMessage,
  ].join("\n");
  return {
    ...report,
    lines,
    counts: {
      ...report.counts,
      total: lines.length,
      safeCandidate: report.counts.SAFE_CANDIDATE,
      blocked: report.counts.BLOCKED,
      uncertain: report.counts.UNCERTAIN,
    },
    safeMessage,
    copyText,
    rows: lines,
  };
}
