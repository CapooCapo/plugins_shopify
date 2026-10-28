import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient, ImportBatch, ImportLine, ImportMergeApproval } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const MAX_MERGE_LINES = 50;
// Shopify only retains mutation idempotency keys for a limited time. The line's
// persisted creation time is a conservative lower bound for its first attempt.
const MAX_AUTOMATIC_ADJUST_RETRY_AGE_MS = 23 * 60 * 60 * 1000;
const LOCATION_QUERY = `#graphql
  query StockHubValidateLocation($after: String) {
    locations(first: 100, after: $after) {
      nodes { id name isActive }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const SKU_QUERY = `#graphql
  query StockHubRecheckSku($query: String!, $locationId: ID!) {
    productVariants(first: 20, query: $query) {
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
const FIND_MARKER_QUERY = `#graphql
  query StockHubFindDraftMarker($identifier: ProductIdentifierInput!, $locationId: ID!) {
    productByIdentifier(identifier: $identifier) {
      id title status
      metafield(namespace: "$app", key: "stockhub_import_operation") { value }
      variants(first: 2) {
        nodes {
          id sku price
          inventoryItem {
            id tracked
            inventoryLevel(locationId: $locationId) {
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      }
    }
  }
`;
const CREATE_DRAFT_MUTATION = `#graphql
  mutation StockHubCreateDraft($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id title status
        metafield(namespace: "$app", key: "stockhub_import_operation") { value }
        variants(first: 1) {
          nodes { id sku price inventoryItem { id tracked } }
        }
      }
      userErrors { field message }
    }
  }
`;
const UPDATE_INVENTORY_ITEM_MUTATION = `#graphql
  mutation StockHubUpdateDraftInventoryItem($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id sku tracked }
      userErrors { field message }
    }
  }
`;
const UPDATE_PRICE_MUTATION = `#graphql
  mutation StockHubSetDraftPrice($productId: ID!, $variantId: ID!, $price: Money!) {
    productVariantsBulkUpdate(
      productId: $productId
      variants: [{id: $variantId, price: $price}]
      allowPartialUpdates: false
    ) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;
const ACTIVATE_MUTATION = `#graphql
  mutation StockHubActivateDraftInventory(
    $inventoryItemId: ID!, $locationId: ID!, $quantity: Int!, $key: String!
  ) {
    inventoryActivate(
      inventoryItemId: $inventoryItemId
      locationId: $locationId
      available: $quantity
    ) @idempotent(key: $key) {
      inventoryLevel { id quantities(names: ["available"]) { name quantity } }
      userErrors { field message }
    }
  }
`;
const ADJUST_MUTATION = `#graphql
  mutation StockHubAdjustIncoming($input: InventoryAdjustQuantitiesInput!, $key: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }
`;

export type ImportLineResult = Pick<
  ImportLine,
  | "id"
  | "rowNumber"
  | "sku"
  | "status"
  | "errorCode"
  | "errorDetail"
  | "productId"
  | "variantId"
  | "shopifyProductUrl"
  | "stage"
  | "operationType"
  | "quantity"
> & { lineId: string };

export type MergeImportBatchResult = {
  batchId: string;
  status: string;
  lines: ImportLineResult[];
  approvalId: string | null;
  approvalStatus: string | null;
  chunkNumber: number;
  continueRequired: boolean;
};

export class MergeImportError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "MergeImportError";
    this.code = code;
  }
}

type MergeInput = {
  shop: string;
  batchId: string;
  admin: AdminApiContext;
  prisma: PrismaClient;
  intent?: "merge" | "continue" | "resume";
  confirmedLineIds?: string[];
  expectedRevision?: number;
  approvalId?: string;
  now?: () => Date;
};

type MergeWorkerInput = MergeInput & { leaseAt: Date };

class MergeLeaseLostError extends Error {
  constructor() {
    super("This Merge worker no longer owns the receipt lease.");
    this.name = "MergeLeaseLostError";
  }
}

type ShopifyUserError = { field?: string[] | null; message: string; code?: string | null };
type ShopifyProductVariant = {
  id: string;
  sku: string;
  title?: string;
  price?: string;
  inventoryItem: {
    id: string;
    tracked: boolean;
    inventoryLevel: { quantities: Array<{ name: string; quantity: number }> } | null;
  };
};
type ReconciledDraftProduct = {
  id: string;
  title: string;
  status: string;
  metafield: { value: string } | null;
  variants: { nodes: ShopifyProductVariant[] };
};
type SkuVariant = {
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

async function graphQL<T>(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response: Response = await admin.graphql(query, { variables });
  let body: { data?: T; errors?: Array<{ message?: string }> };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new Error("Shopify returned an unreadable GraphQL response.");
  }
  if (!response.ok || body.errors?.length || !body.data) {
    throw new Error(
      body.errors?.map((error) => error.message || "GraphQL error").join("; ") ||
        `Shopify returned HTTP ${response.status}.`,
    );
  }
  return body.data;
}

function errorText(errors: ShopifyUserError[]) {
  return errors.map((error) => error.message).filter(Boolean).join("; ");
}

function markerFor(operationId: string) {
  return `stockhub-${operationId.replace(/[^a-zA-Z0-9-]/g, "")}`;
}

function adminProductUrl(shop: string, gid: string | null) {
  if (!gid) return null;
  const numericId = gid.split("/").at(-1);
  if (!numericId || !/^\d+$/.test(numericId)) return null;
  return `https://${shop}/admin/products/${numericId}`;
}

function escapedHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll(/\r?\n/g, "<br>");
}

function resultLine(line: ImportLine): ImportLineResult {
  return {
    ...line,
    lineId: line.id,
  };
}

async function renewLease(input: MergeWorkerInput, now: () => Date) {
  const renewedAt = now();
  const renewed = await input.prisma.importBatch.updateMany({
    where: {
      id: input.batchId,
      shop: input.shop,
      status: "RUNNING",
      updatedAt: input.leaseAt,
    },
    data: { updatedAt: renewedAt },
  });
  if (renewed.count !== 1) throw new MergeLeaseLostError();
  input.leaseAt = renewedAt;
}

async function markLine(
  input: MergeWorkerInput,
  lineId: string,
  now: () => Date,
  data: Partial<ImportLine>,
) {
  await renewLease(input, now);
  const updated = await input.prisma.importLine.updateMany({
    where: {
      id: lineId,
      batch: {
        is: {
          id: input.batchId,
          shop: input.shop,
          status: "RUNNING",
          updatedAt: input.leaseAt,
        },
      },
    },
    data: { ...data, updatedAt: now() },
  });
  if (updated.count !== 1) throw new MergeLeaseLostError();
  return input.prisma.importLine.findUniqueOrThrow({ where: { id: lineId } });
}

async function readLocations(admin: AdminApiContext) {
  const locations: Array<{ id: string; name: string; isActive: boolean }> = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const data: {
      locations: {
        nodes: Array<{ id: string; name: string; isActive: boolean }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await graphQL(admin, LOCATION_QUERY, { after });
    const connection: (typeof data)["locations"] = data.locations;
    locations.push(...connection.nodes);
    after = connection.pageInfo.endCursor;
    pages += 1;
    if (pages >= 5 && connection.pageInfo.hasNextPage) {
      throw new Error("Shopify has more locations than this bounded import can verify.");
    }
    if (!connection.pageInfo.hasNextPage) break;
  } while (pages < 5);
  return locations;
}

async function exactSkuMatches(
  admin: AdminApiContext,
  sku: string,
  locationId: string,
) {
  const data = await graphQL<{
    productVariants: {
      edges: Array<{ node: SkuVariant }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(admin, SKU_QUERY, {
    query: `sku:${JSON.stringify(sku)}`,
    locationId,
  });
  const connection = data.productVariants;
  const matches = connection.edges
    .map((edge) => edge.node)
    .filter((variant) => variant.sku === sku);
  return { matches, incomplete: connection.pageInfo.hasNextPage };
}

async function findByMarker(admin: AdminApiContext, marker: string, locationId: string): Promise<ReconciledDraftProduct[]> {
  const data = await graphQL<{
    productByIdentifier: ReconciledDraftProduct | null;
  }>(admin, FIND_MARKER_QUERY, {
    identifier: { handle: marker },
    locationId,
  });
  return data.productByIdentifier ? [data.productByIdentifier] : [];
}

async function saveBatchState(
  input: MergeWorkerInput,
  status: string,
  now: () => Date,
  completedAt: Date | null = null,
) {
  const updated = await input.prisma.importBatch.updateMany({
    where: {
      id: input.batchId,
      shop: input.shop,
      status: "RUNNING",
      updatedAt: input.leaseAt,
    },
    data: { status, updatedAt: now(), completedAt },
  });
  if (updated.count !== 1) throw new MergeLeaseLostError();
}

function draftUserErrors(errors: ShopifyUserError[], stage: string) {
  return {
    status: "FAILED",
    errorCode: `${stage}_USER_ERROR`,
    errorDetail: errorText(errors),
  };
}

async function ensureDraftProduct(
  input: MergeWorkerInput,
  batch: ImportBatch,
  line: ImportLine,
  now: () => Date,
) {
  let current = line;
  const marker = markerFor(line.operationId);
  const isLegacyInventoryActivationFailure =
    current.stage === "INVENTORY_ACTIVATING" &&
    current.status === "FAILED" &&
    current.errorCode === "INVENTORY_ACTIVATE_USER_ERROR";

  if (current.stage === "PRODUCT_CREATING" || current.productId) {
    let products: ReconciledDraftProduct[];
    try {
      products = await findByMarker(input.admin, marker, batch.locationId);
    } catch (error) {
      return markLine(input, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "PRODUCT_RECONCILE_FAILED",
        errorDetail: error instanceof Error ? error.message : "Unable to reconcile draft product.",
      });
    }
    if (products.length > 1) {
      return markLine(input, line.id, now, {
        status: isLegacyInventoryActivationFailure ? "UNCERTAIN" : "BLOCKED",
        errorCode: "DUPLICATE_PRODUCT_MARKER",
        errorDetail: "More than one Shopify product has this import operation marker.",
      });
    }
    if (products.length === 1) {
      const product = products[0];
      if (product.metafield?.value !== line.operationId) {
        return markLine(input, line.id, now, {
          status: isLegacyInventoryActivationFailure ? "UNCERTAIN" : "BLOCKED",
          productId: product.id,
          errorCode: "DRAFT_HANDLE_COLLISION",
          errorDetail: "A Shopify product already uses this recovery handle but does not contain this import operation marker.",
        });
      }
      if (product.status !== "DRAFT") {
        return markLine(input, line.id, now, {
          status: isLegacyInventoryActivationFailure ? "UNCERTAIN" : "BLOCKED",
          productId: product.id,
          errorCode: "DRAFT_STATUS_CHANGED",
          errorDetail: "The reconciled product is no longer Draft; no further changes were applied.",
        });
      }
      const variant = product.variants.nodes[0];
      if (!variant) {
        return markLine(input, line.id, now, {
          status: "UNCERTAIN",
          productId: product.id,
          errorCode: "DRAFT_VARIANT_MISSING",
          errorDetail: "The Draft exists, but its initial variant could not be reconciled.",
        });
      }
      if (isLegacyInventoryActivationFailure) {
        const available = variant.inventoryItem.inventoryLevel?.quantities.find(
          (quantity) => quantity.name === "available",
        );
        if (
          product.id !== current.productId ||
          variant.id !== current.variantId ||
          variant.inventoryItem.id !== current.inventoryItemId ||
          variant.sku !== current.sku ||
          !variant.inventoryItem.tracked ||
          available
        ) {
          return markLine(input, line.id, now, {
            status: "UNCERTAIN",
            errorCode: "LEGACY_INVENTORY_ACTIVATION_RECONCILIATION_REQUIRED",
            errorDetail: "The legacy inventory activation could not be safely retried: the marked Draft, SKU, inventory item, or location-level inventory did not match the saved operation, or inventory already exists. No mutation was attempted.",
          });
        }
        // Shopify definitively rejected the old input. Persist a new key before
        // retrying with changed mutation parameters to avoid idempotency replay.
        current = await markLine(input, line.id, now, {
          idempotencyKey: randomUUID(),
        });
      }
      current = await markLine(input, line.id, now, {
        status: "RUNNING",
        stage: current.stage === "PRODUCT_CREATING" ? "PRODUCT_CREATED" : current.stage,
        productId: product.id,
        variantId: variant.id,
        inventoryItemId: variant.inventoryItem.id,
        shopifyProductUrl: adminProductUrl(input.shop, product.id),
        errorCode: null,
        errorDetail: null,
      });
    } else if (isLegacyInventoryActivationFailure || current.status === "UNCERTAIN" || current.status === "RUNNING") {
      return markLine(input, line.id, now, {
        status: "UNCERTAIN",
        errorCode: isLegacyInventoryActivationFailure
          ? "LEGACY_INVENTORY_ACTIVATION_RECONCILIATION_REQUIRED"
          : "PRODUCT_CREATE_UNCONFIRMED",
        errorDetail: isLegacyInventoryActivationFailure
          ? "The saved Draft product marker could not be found for this failed inventory activation. No mutation was attempted."
          : "Shopify has not returned the import marker yet. This product will not be created again automatically.",
      });
    }
  }

  if (
    current.stage === "PRODUCT_CREATING" &&
    current.status === "FAILED" &&
    ["PRODUCT_CREATE_USER_ERROR", "SKU_RECHECK_FAILED"].includes(current.errorCode ?? "")
  ) {
    current = await markLine(input, line.id, now, {
      status: "RUNNING",
      errorCode: null,
      errorDetail: null,
    });
  }

  if (current.stage === "PREPARED") {
    const { matches, incomplete } = await exactSkuMatches(
      input.admin,
      line.sku,
      batch.locationId,
    );
    if (incomplete || matches.length !== 0) {
      return markLine(input, line.id, now, {
        status: "BLOCKED",
        errorCode: incomplete ? "SKU_LOOKUP_INCOMPLETE" : "SKU_NO_LONGER_UNMATCHED",
        errorDetail: incomplete
          ? "Shopify could not confirm this SKU is unmatched; upload a new preview before retrying."
          : "This SKU now exists in Shopify; no new product was created. Upload a new preview to classify it safely.",
      });
    }
    if (!line.title || !line.price || line.quantity === null) {
      return markLine(input, line.id, now, {
        status: "BLOCKED",
        errorCode: "NEW_PRODUCT_FIELDS_MISSING",
        errorDetail: "A new SKU requires a title, valid price, and positive quantity.",
      });
    }
    current = await markLine(input, line.id, now, {
      status: "RUNNING",
      stage: "PRODUCT_CREATING",
      errorCode: null,
      errorDetail: null,
    });
  }

  if (current.stage === "PRODUCT_CREATING" && current.status === "RUNNING") {
    if (!current.title || !current.price || current.quantity === null) {
      return markLine(input, line.id, now, {
        status: "BLOCKED",
        errorCode: "NEW_PRODUCT_FIELDS_MISSING",
        errorDetail: "A new SKU requires a title, valid price, and positive quantity.",
      });
    }
    const descriptionHtml = current.description ? escapedHtml(current.description) : "";
    let latestMatches: Awaited<ReturnType<typeof exactSkuMatches>>;
    try {
      latestMatches = await exactSkuMatches(input.admin, current.sku, batch.locationId);
    } catch (error) {
      return markLine(input, line.id, now, {
        status: "FAILED",
        errorCode: "SKU_RECHECK_FAILED",
        errorDetail: error instanceof Error ? error.message : "SKU could not be rechecked before product creation.",
      });
    }
    if (latestMatches.incomplete || latestMatches.matches.length !== 0) {
      return markLine(input, line.id, now, {
        status: "BLOCKED",
        errorCode: latestMatches.incomplete ? "SKU_LOOKUP_INCOMPLETE" : "SKU_NO_LONGER_UNMATCHED",
        errorDetail: latestMatches.incomplete
          ? "Shopify could not confirm this SKU is unmatched immediately before creation."
          : "This SKU now exists in Shopify; no new product was created.",
      });
    }
    try {
      await renewLease(input, now);
      const data = await graphQL<{
        productCreate: {
          product: ReconciledDraftProduct | null;
          userErrors: ShopifyUserError[];
        };
      }>(input.admin, CREATE_DRAFT_MUTATION, {
        product: {
          title: current.title,
          descriptionHtml,
          status: "DRAFT",
          handle: marker,
          metafields: [
            {
              namespace: "$app",
              key: "stockhub_import_operation",
              type: "single_line_text_field",
              value: current.operationId,
            },
          ],
        },
      });
      const payload = data.productCreate;
      if (payload.userErrors?.length) {
        if (payload.product?.id) {
          return markLine(input, line.id, now, {
            status: "UNCERTAIN",
            stage: "PRODUCT_CREATING",
            productId: payload.product.id,
            errorCode: "PRODUCT_CREATE_PARTIAL_RESPONSE",
            errorDetail: errorText(payload.userErrors),
          });
        }
        return markLine(input, line.id, now, {
          ...draftUserErrors(payload.userErrors, "PRODUCT_CREATE"),
          stage: "PRODUCT_CREATING",
        });
      }
      const product = payload.product;
      const variant = product?.variants?.nodes?.[0];
      if (
        !product ||
        product.status !== "DRAFT" ||
        product.metafield?.value !== current.operationId ||
        !variant?.inventoryItem?.id
      ) {
        return markLine(input, line.id, now, {
          status: "UNCERTAIN",
          productId: product?.id ?? null,
          variantId: variant?.id ?? null,
          inventoryItemId: variant?.inventoryItem?.id ?? null,
          errorCode: "PRODUCT_CREATE_INCOMPLETE_RESPONSE",
          errorDetail: "Shopify did not return the Draft and initial variant IDs; reconciliation is required.",
        });
      }
      current = await markLine(input, line.id, now, {
        status: "RUNNING",
        stage: "PRODUCT_CREATED",
        productId: product.id,
        variantId: variant.id,
        inventoryItemId: variant.inventoryItem.id,
        shopifyProductUrl: adminProductUrl(input.shop, product.id),
        errorCode: null,
        errorDetail: null,
      });
    } catch (error) {
      return markLine(input, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "PRODUCT_CREATE_UNCERTAIN",
        errorDetail: error instanceof Error ? error.message : "Shopify product creation outcome is unknown.",
      });
    }
  }

  if (!current.productId || !current.variantId || !current.inventoryItemId) {
    return markLine(input, line.id, now, {
      status: "UNCERTAIN",
      errorCode: "DRAFT_IDS_MISSING",
      errorDetail: "The saved Draft product identifiers are incomplete; reconcile before retrying.",
    });
  }

  if (current.stage === "PRODUCT_CREATED" || current.stage === "INVENTORY_ITEM_CONFIGURING") {
    current = await markLine(input, line.id, now, {
      status: "RUNNING",
      stage: "INVENTORY_ITEM_CONFIGURING",
    });
    try {
      await renewLease(input, now);
      const data = await graphQL<{
        inventoryItemUpdate: {
          inventoryItem: { id: string; sku: string; tracked: boolean } | null;
          userErrors: ShopifyUserError[];
        };
      }>(input.admin, UPDATE_INVENTORY_ITEM_MUTATION, {
        id: current.inventoryItemId,
        input: { sku: current.sku, tracked: true },
      });
      const payload = data.inventoryItemUpdate;
      if (payload.userErrors?.length) {
        return markLine(input, line.id, now, {
          ...draftUserErrors(payload.userErrors, "INVENTORY_ITEM_SETUP"),
          stage: "INVENTORY_ITEM_CONFIGURING",
        });
      }
      const inventoryItem = payload.inventoryItem;
      if (!inventoryItem || inventoryItem.sku !== current.sku || !inventoryItem.tracked) {
        return markLine(input, line.id, now, {
          status: "UNCERTAIN",
          errorCode: "INVENTORY_ITEM_SETUP_UNCONFIRMED",
          errorDetail: "Shopify did not confirm the Draft inventory item SKU and tracking state.",
        });
      }
      current = await markLine(input, line.id, now, {
        status: "RUNNING",
        stage: "INVENTORY_ITEM_CONFIGURED",
        inventoryItemId: inventoryItem.id,
        errorCode: null,
        errorDetail: null,
      });
    } catch (error) {
      return markLine(input, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "INVENTORY_ITEM_SETUP_UNCERTAIN",
        errorDetail: error instanceof Error ? error.message : "Draft inventory item setup outcome is unknown.",
      });
    }
  }

  if (current.stage === "INVENTORY_ITEM_CONFIGURED" || current.stage === "VARIANT_PRICE_CONFIGURING") {
    if (!current.price) {
      return markLine(input, line.id, now, {
        status: "BLOCKED",
        errorCode: "NEW_PRODUCT_PRICE_MISSING",
        errorDetail: "The Draft product price is missing; inventory was not activated.",
      });
    }
    current = await markLine(input, line.id, now, {
      status: "RUNNING",
      stage: "VARIANT_PRICE_CONFIGURING",
    });
    try {
      await renewLease(input, now);
      const data = await graphQL<{
        productVariantsBulkUpdate: {
          productVariants: Array<{ id: string; price: string }>;
          userErrors: ShopifyUserError[];
        };
      }>(input.admin, UPDATE_PRICE_MUTATION, {
        productId: current.productId,
        variantId: current.variantId,
        price: current.price,
      });
      const payload = data.productVariantsBulkUpdate;
      if (payload.userErrors.length) {
        return markLine(input, line.id, now, {
          ...draftUserErrors(payload.userErrors, "VARIANT_PRICE"),
          stage: "VARIANT_PRICE_CONFIGURING",
        });
      }
      const variant = payload.productVariants.find((item) => item.id === current.variantId);
      if (!variant || Number(variant.price) !== Number(current.price)) {
        return markLine(input, line.id, now, {
          status: "UNCERTAIN",
          errorCode: "VARIANT_PRICE_UNCONFIRMED",
          errorDetail: "Shopify did not confirm the Draft variant price.",
        });
      }
      current = await markLine(input, line.id, now, {
        status: "RUNNING",
        stage: "VARIANT_PRICE_CONFIGURED",
        errorCode: null,
        errorDetail: null,
      });
    } catch (error) {
      return markLine(input, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "VARIANT_PRICE_UNCERTAIN",
        errorDetail: error instanceof Error ? error.message : "Draft variant price outcome is unknown.",
      });
    }
  }

  if (current.stage === "VARIANT_PRICE_CONFIGURED" || current.stage === "INVENTORY_ACTIVATING") {
    current = await markLine(input, line.id, now, {
      status: "RUNNING",
      stage: "INVENTORY_ACTIVATING",
    });
    try {
      if (current.quantity === null) {
        return markLine(input, line.id, now, {
          status: "BLOCKED",
          errorCode: "INVALID_INCOMING_QUANTITY",
          errorDetail: "New product quantity is missing; inventory was not activated.",
        });
      }
      await renewLease(input, now);
      const data = await graphQL<{
        inventoryActivate: {
          inventoryLevel: { id: string } | null;
          userErrors: ShopifyUserError[];
        };
      }>(input.admin, ACTIVATE_MUTATION, {
        inventoryItemId: current.inventoryItemId,
        locationId: batch.locationId,
        quantity: current.quantity,
        key: current.idempotencyKey,
      });
      const payload = data.inventoryActivate;
      if (payload.userErrors?.length) {
        return markLine(input, line.id, now, {
          ...draftUserErrors(payload.userErrors, "INVENTORY_ACTIVATE"),
          stage: "INVENTORY_ACTIVATING",
        });
      }
      if (!payload.inventoryLevel?.id) {
        return markLine(input, line.id, now, {
          status: "UNCERTAIN",
          errorCode: "INVENTORY_ACTIVATE_UNCONFIRMED",
          errorDetail: "Shopify did not confirm inventory activation; retry will reuse its idempotency key.",
        });
      }
      current = await markLine(input, line.id, now, {
        status: "RUNNING",
        stage: "INVENTORY_ACTIVE",
        errorCode: null,
        errorDetail: null,
      });
    } catch (error) {
      return markLine(input, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "INVENTORY_ACTIVATE_UNCERTAIN",
        errorDetail: error instanceof Error ? error.message : "Inventory activation outcome is unknown.",
      });
    }
  }

  return markLine(input, line.id, now, {
    status: "SUCCEEDED",
    stage: "COMPLETED",
    completedAt: now(),
    errorCode: null,
    errorDetail: null,
  });
}

async function runLine(
  input: MergeWorkerInput,
  batch: ImportBatch,
  line: ImportLine,
  now: () => Date,
) {
  if (line.operationType === "BLOCKED") return line;
  if (line.status === "SUCCEEDED" || line.status === "BLOCKED") return line;

  if (line.operationType === "CREATE_DRAFT") {
    return ensureDraftProduct(input, batch, line, now);
  }

  const { matches, incomplete } = await exactSkuMatches(
    input.admin,
    line.sku,
    batch.locationId,
  );
  const isReconciliationRetry =
    line.stage === "INVENTORY_ADJUSTING" &&
    ["RUNNING", "FAILED", "UNCERTAIN"].includes(line.status);
  if (incomplete || matches.length !== 1) {
    const retryDetail = isReconciliationRetry
      ? " Reconcile the previous uncertain attempt before any further adjustment."
      : " Upload a fresh preview before merging.";
    return markLine(input, line.id, now, {
      status: isReconciliationRetry ? "UNCERTAIN" : "BLOCKED",
      errorCode: incomplete ? "SKU_LOOKUP_INCOMPLETE" : "SKU_MATCH_CHANGED",
      errorDetail: incomplete
        ? `Shopify could not complete the exact SKU lookup. No new inventory adjustment was attempted.${retryDetail}`
        : matches.length > 1
          ? `More than one exact SKU variant now exists. No new inventory adjustment was attempted.${retryDetail}`
          : `The SKU no longer resolves to exactly one variant. No new inventory adjustment was attempted.${retryDetail}`,
    });
  }
  const variant = matches[0]!;
  if (
    !line.productId ||
    !line.variantId ||
    !line.inventoryItemId ||
    variant.product.id !== line.productId ||
    variant.id !== line.variantId ||
    variant.inventoryItem.id !== line.inventoryItemId
  ) {
    return markLine(input, line.id, now, {
      status: isReconciliationRetry ? "UNCERTAIN" : "BLOCKED",
      errorCode: "SKU_TARGET_CHANGED",
      errorDetail: isReconciliationRetry
        ? "The SKU no longer matches the product, variant, and inventory item saved at preview. The previous adjustment outcome requires manual reconciliation; no stock was adjusted again."
        : "The SKU no longer matches the product, variant, and inventory item saved at preview. Upload a fresh preview; no stock was adjusted.",
    });
  }
  if (isReconciliationRetry) {
    const createdAt = new Date(line.createdAt).getTime();
    const retryAgeMs = now().getTime() - createdAt;
    if (
      !Number.isFinite(retryAgeMs) ||
      retryAgeMs < 0 ||
      retryAgeMs >= MAX_AUTOMATIC_ADJUST_RETRY_AGE_MS
    ) {
      return markLine(input, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "INVENTORY_ADJUST_RECONCILIATION_REQUIRED",
        errorDetail: "The Shopify adjustment idempotency window cannot be proven safe for an automatic retry. Reconcile this receipt and inventory change manually before any further stock adjustment.",
      });
    }
  }
  const level = variant.inventoryItem.inventoryLevel;
  if (!variant.inventoryItem.tracked || !level) {
    return markLine(input, line.id, now, {
      status: isReconciliationRetry ? "UNCERTAIN" : "BLOCKED",
      errorCode: !variant.inventoryItem.tracked ? "INVENTORY_NOT_TRACKED" : "LOCATION_NOT_STOCKED",
      errorDetail: !variant.inventoryItem.tracked
        ? "Inventory tracking is disabled for this variant; no stock was adjusted."
        : "The variant is not stocked at the selected location; no stock was activated automatically.",
    });
  }
  if (line.quantity === null || line.quantity <= 0) {
    return markLine(input, line.id, now, {
      status: isReconciliationRetry ? "UNCERTAIN" : "BLOCKED",
      errorCode: "INVALID_INCOMING_QUANTITY",
      errorDetail: "Incoming quantity must be a positive whole number.",
    });
  }

  const currentAvailable = level.quantities.find(
    (quantity: { name: string; quantity: number }) => quantity.name === "available",
  )?.quantity;
  if (line.expectedQuantity === null || currentAvailable === undefined) {
    return markLine(input, line.id, now, {
      status: isReconciliationRetry ? "UNCERTAIN" : "BLOCKED",
      errorCode: "AVAILABLE_QUANTITY_UNAVAILABLE",
      errorDetail: "Shopify did not return the selected location's available quantity; no adjustment was attempted.",
    });
  }
  if (!isReconciliationRetry && currentAvailable !== line.expectedQuantity) {
    return markLine(input, line.id, now, {
      status: "BLOCKED",
      errorCode: "INVENTORY_CHANGED_SINCE_PREVIEW",
      errorDetail: "Available inventory changed after preview. Upload a fresh preview with a new receipt before merging.",
    });
  }
  const targetUrl = adminProductUrl(input.shop, variant.product.id);
  await markLine(input, line.id, now, {
    status: "RUNNING",
    stage: "INVENTORY_ADJUSTING",
    productId: variant.product.id,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id,
    matchedProductTitle: variant.product.title,
    matchedVariantTitle: variant.title,
    shopifyProductUrl: targetUrl,
    errorCode: null,
    errorDetail: null,
  });
  try {
    await renewLease(input, now);
    const data = await graphQL<{
      inventoryAdjustQuantities: {
        inventoryAdjustmentGroup: { id: string } | null;
        userErrors: ShopifyUserError[];
      };
    }>(input.admin, ADJUST_MUTATION, {
      input: {
        name: "available",
        reason: "received",
        referenceDocumentUri: `stockhub://receipt/${encodeURIComponent(batch.receiptCode)}/line/${line.operationId}`,
        changes: [
          {
            inventoryItemId: variant.inventoryItem.id,
            locationId: batch.locationId,
            delta: line.quantity,
            changeFromQuantity: line.expectedQuantity,
          },
        ],
      },
      key: line.idempotencyKey,
    });
    const payload = data.inventoryAdjustQuantities;
    if (payload.userErrors?.length) {
      return markLine(input, line.id, now, {
        ...draftUserErrors(payload.userErrors, "INVENTORY_ADJUST"),
        stage: "INVENTORY_ADJUSTING",
        productId: variant.product.id,
        variantId: variant.id,
        inventoryItemId: variant.inventoryItem.id,
        shopifyProductUrl: targetUrl,
      });
    }
    if (!payload.inventoryAdjustmentGroup?.id) {
      return markLine(input, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "INVENTORY_ADJUST_UNCONFIRMED",
        errorDetail: "Shopify returned no adjustment ID; retry will reuse the persisted idempotency key.",
        productId: variant.product.id,
        variantId: variant.id,
        inventoryItemId: variant.inventoryItem.id,
        shopifyProductUrl: targetUrl,
      });
    }
    return markLine(input, line.id, now, {
      status: "SUCCEEDED",
      stage: "COMPLETED",
      completedAt: now(),
      productId: variant.product.id,
      variantId: variant.id,
      inventoryItemId: variant.inventoryItem.id,
      matchedProductTitle: variant.product.title,
      matchedVariantTitle: variant.title,
      shopifyProductUrl: targetUrl,
      errorCode: null,
      errorDetail: null,
    });
  } catch (error) {
    return markLine(input, line.id, now, {
      status: "UNCERTAIN",
      errorCode: "INVENTORY_ADJUST_UNCERTAIN",
      errorDetail: error instanceof Error ? error.message : "Inventory adjustment outcome is unknown.",
      productId: variant.product.id,
      variantId: variant.id,
      inventoryItemId: variant.inventoryItem.id,
      matchedProductTitle: variant.product.title,
      matchedVariantTitle: variant.title,
      shopifyProductUrl: targetUrl,
    });
  }
}

type ApprovalSnapshotLine = {
  id: string;
  rowNumber: number;
  sku: string;
  title: string | null;
  description: string | null;
  price: string | null;
  imageUrl: string | null;
  quantity: number | null;
  operationType: string;
  operationId: string;
  idempotencyKey: string;
  productId: string | null;
  variantId: string | null;
  inventoryItemId: string | null;
  expectedQuantity: number | null;
};

type ApprovalSnapshot = { version: 1; lines: ApprovalSnapshotLine[] };

function snapshotLine(line: ImportLine): ApprovalSnapshotLine {
  return {
    id: line.id,
    rowNumber: line.rowNumber,
    sku: line.sku,
    title: line.title,
    description: line.description,
    price: line.price,
    imageUrl: line.imageUrl,
    quantity: line.quantity,
    operationType: line.operationType,
    operationId: line.operationId,
    idempotencyKey: line.idempotencyKey,
    productId: line.productId,
    variantId: line.variantId,
    inventoryItemId: line.inventoryItemId,
    expectedQuantity: line.expectedQuantity,
  };
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function makeApprovalSnapshot(lines: ImportLine[]): { snapshot: ApprovalSnapshot; json: string; fingerprint: string } {
  const snapshot: ApprovalSnapshot = {
    version: 1,
    lines: [...lines].sort((left, right) => left.rowNumber - right.rowNumber).map(snapshotLine),
  };
  return { snapshot, json: JSON.stringify(snapshot), fingerprint: fingerprint(snapshot) };
}

function readApprovalSnapshot(approval: ImportMergeApproval): ApprovalSnapshot {
  let parsed: unknown;
  try { parsed = JSON.parse(approval.snapshotJson); }
  catch { throw new MergeImportError("The saved Merge approval snapshot is unreadable. No new Shopify work was started.", "APPROVAL_SNAPSHOT_INVALID"); }
  if (!parsed || typeof parsed !== "object" || (parsed as ApprovalSnapshot).version !== 1 || !Array.isArray((parsed as ApprovalSnapshot).lines)) {
    throw new MergeImportError("The saved Merge approval snapshot is invalid. No new Shopify work was started.", "APPROVAL_SNAPSHOT_INVALID");
  }
  const snapshot = parsed as ApprovalSnapshot;
  if (fingerprint(snapshot) !== approval.fingerprint || new Set(snapshot.lines.map((line) => line.id)).size !== snapshot.lines.length) {
    throw new MergeImportError("The saved Merge approval fingerprint does not match. No new Shopify work was started.", "APPROVAL_FINGERPRINT_MISMATCH");
  }
  return snapshot;
}

function isPreviewEligible(line: ImportLine) {
  return line.status === "PREVIEWED" && line.stage === "PREPARED" && line.operationType !== "BLOCKED";
}

function isResumeEligible(line: ImportLine) {
  return !["SUCCEEDED", "BLOCKED"].includes(line.status) && line.operationType !== "BLOCKED";
}

function batchStatusFromLines(lines: ImportLine[]) {
  if (lines.some((line) => ["RUNNING", "UNCERTAIN"].includes(line.status))) return "UNCERTAIN";
  if (lines.some((line) => line.status === "PREVIEWED")) {
    return lines.some((line) => line.status === "SUCCEEDED") ? "PARTIAL" : "PREVIEWED";
  }
  const successful = lines.filter((line) => line.status === "SUCCEEDED").length;
  if (lines.length > 0 && successful === lines.length) return "COMPLETED";
  if (successful > 0) return "PARTIAL";
  return "FAILED";
}

function resultFor(
  batchId: string,
  lines: ImportLine[],
  status: string,
  approvalId: string | null,
  approvalStatus: string | null,
  chunkNumber: number,
  continueRequired = false,
): MergeImportBatchResult {
  return {
    batchId,
    status,
    lines: lines.map(resultLine),
    approvalId,
    approvalStatus,
    chunkNumber,
    continueRequired,
  };
}

async function findApproval(prisma: PrismaClient, shop: string, batchId: string, id: string) {
  return prisma.importMergeApproval.findFirst({ where: { id, shop, batchId } });
}

async function invalidateStaleRunningApproval(input: {
  prisma: PrismaClient;
  batch: ImportBatch;
  approval: ImportMergeApproval;
  staleAt: Date;
  now: () => Date;
}) {
  return input.prisma.$transaction(async (transaction) => {
    const invalidatedAt = input.now();
    const invalidated = await transaction.importBatch.updateMany({
      where: {
        id: input.batch.id,
        shop: input.approval.shop,
        status: "RUNNING",
        revision: input.approval.receiptRevision,
        activeMergeApprovalId: input.approval.id,
        // Match the exact lease observed by this request. If its owner renewed
        // while we waited, this compare-and-swap must fail closed.
        updatedAt: { equals: input.batch.updatedAt, lt: input.staleAt },
      },
      data: { status: "UNCERTAIN", updatedAt: invalidatedAt },
    });
    if (invalidated.count !== 1) return false;

    const stopped = await transaction.importMergeApproval.updateMany({
      where: {
        id: input.approval.id,
        shop: input.approval.shop,
        batchId: input.approval.batchId,
        status: "ACTIVE",
      },
      data: { status: "STOPPED", updatedAt: invalidatedAt },
    });
    if (stopped.count !== 1) {
      throw new MergeImportError(
        "The saved Merge approval changed while its expired worker lease was being invalidated. Refresh and explicitly resume to reconcile it.",
        "APPROVAL_CHANGED",
      );
    }
    return true;
  });
}

async function setApprovalState(
  prisma: PrismaClient,
  approval: ImportMergeApproval,
  nextStatus: string,
  processedCount = 0,
  incrementChunk = false,
) {
  const increments = {
    ...(incrementChunk ? { chunkNumber: { increment: 1 } } : {}),
    ...(processedCount ? { processedCount: { increment: processedCount } } : {}),
  };
  const allowedStatus = nextStatus === "ACTIVE"
    ? "ACTIVE"
    : { in: ["ACTIVE", "PAUSED"] };
  const update = await prisma.importMergeApproval.updateMany({
    where: { id: approval.id, shop: approval.shop, batchId: approval.batchId, status: allowedStatus },
    data: { ...increments, status: nextStatus },
  });
  if (update.count === 1) return findApproval(prisma, approval.shop, approval.batchId, approval.id);

  const current = await findApproval(prisma, approval.shop, approval.batchId, approval.id);
  if (current?.status === "PAUSED" && nextStatus === "ACTIVE") {
    await prisma.importMergeApproval.updateMany({
      where: { id: approval.id, shop: approval.shop, batchId: approval.batchId, status: "PAUSED" },
      data: increments,
    });
    return findApproval(prisma, approval.shop, approval.batchId, approval.id);
  }
  return current;
}

async function createAndClaimApproval(input: {
  batch: ImportBatch & { lines: ImportLine[] };
  shop: string;
  batchId: string;
  prisma: PrismaClient;
  now: () => Date;
  intent: "merge" | "resume";
  expectedRevision: number;
  snapshot: ApprovalSnapshot;
  snapshotJson: string;
  snapshotFingerprint: string;
}) {
  const approvalId = randomUUID();
  const claimAt = input.now();
  await input.prisma.$transaction(async (transaction) => {
    if (input.batch.activeMergeApprovalId) {
      const active = await transaction.importMergeApproval.findFirst({
        where: { id: input.batch.activeMergeApprovalId, shop: input.shop, batchId: input.batchId },
      });
      if (active && ["ACTIVE", "PAUSED"].includes(active.status)) {
        throw new MergeImportError("A saved Merge approval is still active. Continue or pause that approval before starting another.", "APPROVAL_ALREADY_ACTIVE");
      }
    }
    await transaction.importMergeApproval.create({
      data: {
        id: approvalId,
        shop: input.shop,
        batchId: input.batchId,
        mode: input.intent === "merge" ? "MERGE" : "RESUME",
        status: "ACTIVE",
        snapshotJson: input.snapshotJson,
        fingerprint: input.snapshotFingerprint,
        receiptRevision: input.expectedRevision,
        chunkNumber: 0,
        processedCount: 0,
      },
    });
    const claimed = await transaction.importBatch.updateMany({
      where: {
        id: input.batchId,
        shop: input.shop,
        status: input.batch.status,
        revision: input.expectedRevision,
        updatedAt: input.batch.updatedAt,
      },
      data: { status: "RUNNING", updatedAt: claimAt, activeMergeApprovalId: approvalId },
    });
    if (claimed.count !== 1) {
      throw new MergeImportError("This import changed after confirmation. Refresh, review the current eligible count, and confirm again.", "APPROVAL_STALE");
    }
  });
  return { approvalId, claimAt };
}

async function failClaimedApproval(
  worker: MergeWorkerInput,
  approval: ImportMergeApproval,
  lines: ImportLine[],
  now: () => Date,
  code: string,
  message: string,
): Promise<never> {
  await setApprovalState(worker.prisma, approval, "STOPPED");
  await saveBatchState(worker, batchStatusFromLines(lines), now, null);
  throw new MergeImportError(message, code);
}

export async function mergeImportBatch(input: MergeInput): Promise<MergeImportBatchResult> {
  const {
    shop,
    batchId,
    admin,
    prisma,
    now = () => new Date(),
    intent = "resume",
    confirmedLineIds = [],
    approvalId: requestedApprovalId,
  } = input;
  let batch = await prisma.importBatch.findFirst({
    where: { id: batchId, shop },
    include: { lines: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) throw new MergeImportError("Import batch was not found for this store.", "BATCH_NOT_FOUND");

  if (batch.status === "COMPLETED" && intent !== "continue") {
    const previous = batch.activeMergeApprovalId
      ? await findApproval(prisma, shop, batchId, batch.activeMergeApprovalId)
      : null;
    return resultFor(batchId, batch.lines, batch.status, previous?.id ?? null, previous?.status ?? null, previous?.chunkNumber ?? 0);
  }

  let approval: ImportMergeApproval | null = null;
  let leaseAt: Date;
  if (intent === "continue") {
    if (!requestedApprovalId || requestedApprovalId !== batch.activeMergeApprovalId) {
      throw new MergeImportError("This continuation does not match the receipt's active approval.", "APPROVAL_NOT_FOUND");
    }
    approval = await findApproval(prisma, shop, batchId, requestedApprovalId);
    if (!approval) throw new MergeImportError("The saved Merge approval was not found for this receipt.", "APPROVAL_NOT_FOUND");
    if (approval.status === "COMPLETED" || approval.status === "STOPPED") {
      return resultFor(batchId, batch.lines, batch.status, approval.id, approval.status, approval.chunkNumber);
    }
    if (approval.status !== "ACTIVE") {
      throw new MergeImportError("This approved Merge is paused. Explicitly resume the saved approval before continuing.", "APPROVAL_PAUSED");
    }
    if ((batch.revision ?? 0) !== approval.receiptRevision) {
      await setApprovalState(prisma, approval, "STOPPED");
      throw new MergeImportError("The receipt changed after approval. Review the current eligible rows and confirm again.", "APPROVAL_STALE");
    }
    const staleAt = new Date(now().getTime() - 15 * 60 * 1000);
    if (batch.status === "RUNNING") {
      if (batch.updatedAt >= staleAt) {
        throw new MergeImportError("This import is already being processed. Refresh before continuing.", "BATCH_ALREADY_RUNNING");
      }
      const invalidated = await invalidateStaleRunningApproval({ prisma, batch, approval, staleAt, now });
      if (!invalidated) {
        throw new MergeImportError("The previous Merge worker renewed its lease. Refresh before continuing.", "BATCH_ALREADY_RUNNING");
      }
      throw new MergeImportError(
        "The previous Merge worker's lease expired while Shopify work may still be in flight. Automatic continuation stopped; explicitly Resume to reconcile the outcome before any retry.",
        "RESUME_REQUIRED",
      );
    }
    leaseAt = now();
    const claim = await prisma.importBatch.updateMany({
      where: {
        id: batchId,
        shop,
        revision: approval.receiptRevision,
        activeMergeApprovalId: approval.id,
        status: { in: ["PREVIEWED", "PARTIAL", "FAILED", "UNCERTAIN"] },
      },
      data: { status: "RUNNING", updatedAt: leaseAt },
    });
    if (claim.count !== 1) {
      throw new MergeImportError("This import is already being processed. Refresh before continuing.", "BATCH_ALREADY_RUNNING");
    }
  } else {
    if (!confirmedLineIds.length) {
      throw new MergeImportError("Confirm at least one currently eligible row before processing this receipt.", "BATCH_EMPTY");
    }
    if (batch.status === "RUNNING") {
      throw new MergeImportError("This import is already being processed. Refresh before retrying.", "BATCH_ALREADY_RUNNING");
    }
    const expectedRevision = input.expectedRevision ?? batch.revision ?? 0;
    if ((batch.revision ?? 0) !== expectedRevision) {
      throw new MergeImportError("The receipt changed after confirmation. Review the current eligible rows and confirm again.", "APPROVAL_STALE");
    }
    const lineById = new Map(batch.lines.map((line) => [line.id, line]));
    const uniqueConfirmedIds = [...new Set(confirmedLineIds)];
    if (uniqueConfirmedIds.length !== confirmedLineIds.length) {
      throw new MergeImportError("The approved row set is invalid. Refresh and confirm again.", "APPROVAL_INVALID");
    }
    const eligible = intent === "merge"
      ? batch.lines.filter(isPreviewEligible)
      : batch.lines.filter(isResumeEligible);
    const eligibleIds = eligible.map((line) => line.id).sort();
    const confirmedEligibleIds = uniqueConfirmedIds.filter((id) => eligibleIds.includes(id)).sort();
    if (confirmedEligibleIds.length !== eligibleIds.length || eligibleIds.some((id, index) => id !== confirmedEligibleIds[index])) {
      throw new MergeImportError("The approved rows no longer match the receipt's current eligible rows. Refresh and confirm again.", "APPROVAL_STALE");
    }
    const selectedLines = confirmedEligibleIds.map((id) => lineById.get(id)!).sort((left, right) => left.rowNumber - right.rowNumber);
    const snapshot = makeApprovalSnapshot(selectedLines);
    const claimed = await createAndClaimApproval({
      batch,
      shop,
      batchId,
      prisma,
      now,
      intent,
      expectedRevision,
      snapshot: snapshot.snapshot,
      snapshotJson: snapshot.json,
      snapshotFingerprint: snapshot.fingerprint,
    });
    approval = await findApproval(prisma, shop, batchId, claimed.approvalId);
    if (!approval) throw new MergeImportError("The Merge approval could not be loaded after creation.", "APPROVAL_NOT_FOUND");
    leaseAt = claimed.claimAt;
  }

  const worker: MergeWorkerInput = { shop, batchId, admin, prisma, now, leaseAt };
  const claimedBatch = await prisma.importBatch.findFirst({
    where: { id: batchId, shop },
    include: { lines: { orderBy: { rowNumber: "asc" } } },
  });
  if (!claimedBatch) throw new MergeImportError("Import batch was not found for this store.", "BATCH_NOT_FOUND");
  batch = claimedBatch;
  const currentApproval = await findApproval(prisma, shop, batchId, approval!.id);
  if (!currentApproval) throw new MergeImportError("The saved Merge approval disappeared during processing.", "APPROVAL_NOT_FOUND");
  if (currentApproval.status === "PAUSED") {
    const state = batchStatusFromLines(batch.lines);
    await saveBatchState(worker, state, now, state === "COMPLETED" ? now() : null);
    return resultFor(batchId, batch.lines, state, currentApproval.id, currentApproval.status, currentApproval.chunkNumber);
  }

  let snapshot: ApprovalSnapshot;
  try { snapshot = readApprovalSnapshot(currentApproval); }
  catch (error) {
    return failClaimedApproval(worker, currentApproval, batch.lines, now,
      error instanceof MergeImportError ? error.code : "APPROVAL_SNAPSHOT_INVALID",
      error instanceof Error ? error.message : "The saved Merge approval snapshot is invalid.");
  }
  const linesById = new Map(batch.lines.map((line) => [line.id, line]));
  for (const saved of snapshot.lines) {
    const current = linesById.get(saved.id);
    if (!current || JSON.stringify(snapshotLine(current)) !== JSON.stringify(saved)) {
      return failClaimedApproval(worker, currentApproval, batch.lines, now, "APPROVAL_SNAPSHOT_CHANGED",
        "An approved row disappeared or changed after confirmation. No further Shopify work was started; review and confirm the current receipt.");
    }
  }

  const approvedIds = new Set(snapshot.lines.map((line) => line.id));
  const currentlyEligible = batch.lines.filter(currentApproval.mode === "MERGE" ? isPreviewEligible : isResumeEligible);
  const approvedPending = snapshot.lines
    .map((saved) => linesById.get(saved.id)!)
    .filter((line) => currentApproval.mode === "MERGE" ? line.status === "PREVIEWED" : isResumeEligible(line));
  if (currentlyEligible.some((line) => !approvedIds.has(line.id))
    || approvedPending.some((line) => !currentlyEligible.some((candidate) => candidate.id === line.id))) {
    return failClaimedApproval(worker, currentApproval, batch.lines, now, "APPROVAL_SNAPSHOT_CHANGED",
      "The receipt's current eligible rows no longer match the approved snapshot. No further Shopify work was started; confirm the current rows again.");
  }
  if (currentApproval.mode === "MERGE" && snapshot.lines.some((saved) => {
    const line = linesById.get(saved.id)!;
    return !["PREVIEWED", "SUCCEEDED", "BLOCKED"].includes(line.status);
  })) {
    return failClaimedApproval(worker, currentApproval, batch.lines, now, "RESUME_REQUIRED",
      "The approved Merge contains a failed or uncertain outcome. Automatic continuation stopped; use explicit Resume to reconcile it.");
  }

  const eligibleSnapshotLines = snapshot.lines
    .map((saved) => linesById.get(saved.id)!)
    .filter((line) => currentApproval.mode === "MERGE" ? isPreviewEligible(line) : isResumeEligible(line))
    .sort((left, right) => left.rowNumber - right.rowNumber);
  const selectedLines = eligibleSnapshotLines.slice(0, MAX_MERGE_LINES);
  if (!selectedLines.length) {
    const state = batchStatusFromLines(batch.lines);
    const finalApproval = await setApprovalState(prisma, currentApproval, "COMPLETED");
    await saveBatchState(worker, state, now, state === "COMPLETED" ? now() : null);
    return resultFor(batchId, batch.lines, state, currentApproval.id, finalApproval?.status ?? "COMPLETED", finalApproval?.chunkNumber ?? currentApproval.chunkNumber);
  }

  let verifiedLocation: { id: string; name: string; isActive: boolean } | undefined;
  try {
    verifiedLocation = (await readLocations(admin)).find((location) => location.id === batch.locationId);
  } catch (error) {
    await setApprovalState(prisma, currentApproval, "STOPPED");
    await saveBatchState(worker, "UNCERTAIN", now);
    throw new MergeImportError(error instanceof Error ? error.message : "Unable to verify the selected location.", "LOCATION_LOOKUP_FAILED");
  }
  if (!verifiedLocation || !verifiedLocation.isActive) {
    const detail = verifiedLocation
      ? "The selected Shopify location is inactive."
      : "The selected location is not available to this authenticated store.";
    for (const line of selectedLines) {
      const mayHaveReachedShopify = line.status === "UNCERTAIN"
        || (line.stage !== "PREPARED" && ["RUNNING", "FAILED"].includes(line.status));
      const reconciliationDetail = `${detail} Reconcile this line before retrying; its previous Shopify mutation outcome may be unknown.`;
      await markLine(worker, line.id, now, mayHaveReachedShopify
        ? {
            status: "UNCERTAIN",
            errorCode: line.errorCode ?? "LOCATION_RECONCILIATION_REQUIRED",
            errorDetail: line.errorDetail?.includes(reconciliationDetail)
              ? line.errorDetail
              : [line.errorDetail, reconciliationDetail].filter(Boolean).join(" "),
          }
        : {
            status: "BLOCKED",
            errorCode: "LOCATION_NOT_AUTHORIZED",
            errorDetail: `${detail} No mutation was attempted for this line.`,
          });
    }
  } else {
    for (const line of selectedLines) {
      try {
        await renewLease(worker, now);
        await runLine(worker, batch, line, now);
      } catch (error) {
        if (error instanceof MergeLeaseLostError) {
          const currentBatch = await prisma.importBatch.findFirst({
            where: { id: batchId, shop },
            include: { lines: { orderBy: { rowNumber: "asc" } } },
          });
          const liveApproval = await findApproval(prisma, shop, batchId, currentApproval.id);
          return resultFor(batchId, currentBatch?.lines ?? [], currentBatch?.status ?? "UNCERTAIN",
            currentApproval.id, liveApproval?.status ?? "STOPPED", liveApproval?.chunkNumber ?? currentApproval.chunkNumber);
        }
        await markLine(worker, line.id, now, {
          status: "UNCERTAIN",
          errorCode: "LINE_EXECUTION_UNCERTAIN",
          errorDetail: error instanceof Error ? error.message : "Line execution outcome is unknown.",
        });
      }
    }
  }

  const lines = await prisma.importLine.findMany({ where: { batchId }, orderBy: { rowNumber: "asc" } });
  const postChunkById = new Map(lines.map((line) => [line.id, line]));
  const snapshotLines = snapshot.lines.map((saved) => postChunkById.get(saved.id)).filter((line): line is ImportLine => Boolean(line));
  const chunkLines = selectedLines.map((line) => postChunkById.get(line.id)).filter((line): line is ImportLine => Boolean(line));
  const automaticStop = snapshotLines.some((line) => ["FAILED", "UNCERTAIN", "RUNNING"].includes(line.status))
    || chunkLines.length !== selectedLines.length;
  const pendingSnapshot = snapshotLines.filter((line) => currentApproval.mode === "MERGE"
    ? isPreviewEligible(line)
    : isResumeEligible(line));
  const outsideEligible = lines.some((line) => (currentApproval.mode === "MERGE" ? isPreviewEligible(line) : isResumeEligible(line)) && !approvedIds.has(line.id));
  const nextStatus = automaticStop || outsideEligible
    ? "STOPPED"
    : pendingSnapshot.length === 0
      ? "COMPLETED"
      : "ACTIVE";
  const savedApproval = await setApprovalState(
    prisma,
    currentApproval,
    nextStatus,
    selectedLines.length,
    true,
  );
  const status = batchStatusFromLines(lines);
  await saveBatchState(worker, status, now, status === "COMPLETED" ? now() : null);
  const approvalStatus = savedApproval?.status ?? nextStatus;
  const continueRequired = approvalStatus === "ACTIVE" && pendingSnapshot.length > 0 && !outsideEligible && !automaticStop;
  return resultFor(batchId, lines, status, currentApproval.id, approvalStatus,
    savedApproval?.chunkNumber ?? currentApproval.chunkNumber + 1, continueRequired);
}
