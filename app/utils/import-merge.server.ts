import { randomUUID } from "node:crypto";
import type { PrismaClient, ImportBatch, ImportLine } from "@prisma/client";
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
  now?: () => Date;
};

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

async function markLine(
  prisma: PrismaClient,
  lineId: string,
  now: () => Date,
  data: Partial<ImportLine>,
) {
  return prisma.importLine.update({
    where: { id: lineId },
    data: { ...data, updatedAt: now() },
  });
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
  prisma: PrismaClient,
  batchId: string,
  status: string,
  now: () => Date,
  completedAt: Date | null = null,
) {
  await prisma.importBatch.update({
    where: { id: batchId },
    data: { status, updatedAt: now(), completedAt },
  });
}

function draftUserErrors(errors: ShopifyUserError[], stage: string) {
  return {
    status: "FAILED",
    errorCode: `${stage}_USER_ERROR`,
    errorDetail: errorText(errors),
  };
}

async function ensureDraftProduct(
  input: MergeInput,
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
      return markLine(input.prisma, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "PRODUCT_RECONCILE_FAILED",
        errorDetail: error instanceof Error ? error.message : "Unable to reconcile draft product.",
      });
    }
    if (products.length > 1) {
      return markLine(input.prisma, line.id, now, {
        status: isLegacyInventoryActivationFailure ? "UNCERTAIN" : "BLOCKED",
        errorCode: "DUPLICATE_PRODUCT_MARKER",
        errorDetail: "More than one Shopify product has this import operation marker.",
      });
    }
    if (products.length === 1) {
      const product = products[0];
      if (product.metafield?.value !== line.operationId) {
        return markLine(input.prisma, line.id, now, {
          status: isLegacyInventoryActivationFailure ? "UNCERTAIN" : "BLOCKED",
          productId: product.id,
          errorCode: "DRAFT_HANDLE_COLLISION",
          errorDetail: "A Shopify product already uses this recovery handle but does not contain this import operation marker.",
        });
      }
      if (product.status !== "DRAFT") {
        return markLine(input.prisma, line.id, now, {
          status: isLegacyInventoryActivationFailure ? "UNCERTAIN" : "BLOCKED",
          productId: product.id,
          errorCode: "DRAFT_STATUS_CHANGED",
          errorDetail: "The reconciled product is no longer Draft; no further changes were applied.",
        });
      }
      const variant = product.variants.nodes[0];
      if (!variant) {
        return markLine(input.prisma, line.id, now, {
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
          return markLine(input.prisma, line.id, now, {
            status: "UNCERTAIN",
            errorCode: "LEGACY_INVENTORY_ACTIVATION_RECONCILIATION_REQUIRED",
            errorDetail: "The legacy inventory activation could not be safely retried: the marked Draft, SKU, inventory item, or location-level inventory did not match the saved operation, or inventory already exists. No mutation was attempted.",
          });
        }
        // Shopify definitively rejected the old input. Persist a new key before
        // retrying with changed mutation parameters to avoid idempotency replay.
        current = await markLine(input.prisma, line.id, now, {
          idempotencyKey: randomUUID(),
        });
      }
      current = await markLine(input.prisma, line.id, now, {
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
      return markLine(input.prisma, line.id, now, {
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
    current = await markLine(input.prisma, line.id, now, {
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
      return markLine(input.prisma, line.id, now, {
        status: "BLOCKED",
        errorCode: incomplete ? "SKU_LOOKUP_INCOMPLETE" : "SKU_NO_LONGER_UNMATCHED",
        errorDetail: incomplete
          ? "Shopify could not confirm this SKU is unmatched; upload a new preview before retrying."
          : "This SKU now exists in Shopify; no new product was created. Upload a new preview to classify it safely.",
      });
    }
    if (!line.title || !line.price || line.quantity === null) {
      return markLine(input.prisma, line.id, now, {
        status: "BLOCKED",
        errorCode: "NEW_PRODUCT_FIELDS_MISSING",
        errorDetail: "A new SKU requires a title, valid price, and positive quantity.",
      });
    }
    current = await markLine(input.prisma, line.id, now, {
      status: "RUNNING",
      stage: "PRODUCT_CREATING",
      errorCode: null,
      errorDetail: null,
    });
  }

  if (current.stage === "PRODUCT_CREATING" && current.status === "RUNNING") {
    if (!current.title || !current.price || current.quantity === null) {
      return markLine(input.prisma, line.id, now, {
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
      return markLine(input.prisma, line.id, now, {
        status: "FAILED",
        errorCode: "SKU_RECHECK_FAILED",
        errorDetail: error instanceof Error ? error.message : "SKU could not be rechecked before product creation.",
      });
    }
    if (latestMatches.incomplete || latestMatches.matches.length !== 0) {
      return markLine(input.prisma, line.id, now, {
        status: "BLOCKED",
        errorCode: latestMatches.incomplete ? "SKU_LOOKUP_INCOMPLETE" : "SKU_NO_LONGER_UNMATCHED",
        errorDetail: latestMatches.incomplete
          ? "Shopify could not confirm this SKU is unmatched immediately before creation."
          : "This SKU now exists in Shopify; no new product was created.",
      });
    }
    try {
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
          return markLine(input.prisma, line.id, now, {
            status: "UNCERTAIN",
            stage: "PRODUCT_CREATING",
            productId: payload.product.id,
            errorCode: "PRODUCT_CREATE_PARTIAL_RESPONSE",
            errorDetail: errorText(payload.userErrors),
          });
        }
        return markLine(input.prisma, line.id, now, {
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
        return markLine(input.prisma, line.id, now, {
          status: "UNCERTAIN",
          productId: product?.id ?? null,
          variantId: variant?.id ?? null,
          inventoryItemId: variant?.inventoryItem?.id ?? null,
          errorCode: "PRODUCT_CREATE_INCOMPLETE_RESPONSE",
          errorDetail: "Shopify did not return the Draft and initial variant IDs; reconciliation is required.",
        });
      }
      current = await markLine(input.prisma, line.id, now, {
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
      return markLine(input.prisma, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "PRODUCT_CREATE_UNCERTAIN",
        errorDetail: error instanceof Error ? error.message : "Shopify product creation outcome is unknown.",
      });
    }
  }

  if (!current.productId || !current.variantId || !current.inventoryItemId) {
    return markLine(input.prisma, line.id, now, {
      status: "UNCERTAIN",
      errorCode: "DRAFT_IDS_MISSING",
      errorDetail: "The saved Draft product identifiers are incomplete; reconcile before retrying.",
    });
  }

  if (current.stage === "PRODUCT_CREATED" || current.stage === "INVENTORY_ITEM_CONFIGURING") {
    current = await markLine(input.prisma, line.id, now, {
      status: "RUNNING",
      stage: "INVENTORY_ITEM_CONFIGURING",
    });
    try {
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
        return markLine(input.prisma, line.id, now, {
          ...draftUserErrors(payload.userErrors, "INVENTORY_ITEM_SETUP"),
          stage: "INVENTORY_ITEM_CONFIGURING",
        });
      }
      const inventoryItem = payload.inventoryItem;
      if (!inventoryItem || inventoryItem.sku !== current.sku || !inventoryItem.tracked) {
        return markLine(input.prisma, line.id, now, {
          status: "UNCERTAIN",
          errorCode: "INVENTORY_ITEM_SETUP_UNCONFIRMED",
          errorDetail: "Shopify did not confirm the Draft inventory item SKU and tracking state.",
        });
      }
      current = await markLine(input.prisma, line.id, now, {
        status: "RUNNING",
        stage: "INVENTORY_ITEM_CONFIGURED",
        inventoryItemId: inventoryItem.id,
        errorCode: null,
        errorDetail: null,
      });
    } catch (error) {
      return markLine(input.prisma, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "INVENTORY_ITEM_SETUP_UNCERTAIN",
        errorDetail: error instanceof Error ? error.message : "Draft inventory item setup outcome is unknown.",
      });
    }
  }

  if (current.stage === "INVENTORY_ITEM_CONFIGURED" || current.stage === "VARIANT_PRICE_CONFIGURING") {
    if (!current.price) {
      return markLine(input.prisma, line.id, now, {
        status: "BLOCKED",
        errorCode: "NEW_PRODUCT_PRICE_MISSING",
        errorDetail: "The Draft product price is missing; inventory was not activated.",
      });
    }
    current = await markLine(input.prisma, line.id, now, {
      status: "RUNNING",
      stage: "VARIANT_PRICE_CONFIGURING",
    });
    try {
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
        return markLine(input.prisma, line.id, now, {
          ...draftUserErrors(payload.userErrors, "VARIANT_PRICE"),
          stage: "VARIANT_PRICE_CONFIGURING",
        });
      }
      const variant = payload.productVariants.find((item) => item.id === current.variantId);
      if (!variant || Number(variant.price) !== Number(current.price)) {
        return markLine(input.prisma, line.id, now, {
          status: "UNCERTAIN",
          errorCode: "VARIANT_PRICE_UNCONFIRMED",
          errorDetail: "Shopify did not confirm the Draft variant price.",
        });
      }
      current = await markLine(input.prisma, line.id, now, {
        status: "RUNNING",
        stage: "VARIANT_PRICE_CONFIGURED",
        errorCode: null,
        errorDetail: null,
      });
    } catch (error) {
      return markLine(input.prisma, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "VARIANT_PRICE_UNCERTAIN",
        errorDetail: error instanceof Error ? error.message : "Draft variant price outcome is unknown.",
      });
    }
  }

  if (current.stage === "VARIANT_PRICE_CONFIGURED" || current.stage === "INVENTORY_ACTIVATING") {
    current = await markLine(input.prisma, line.id, now, {
      status: "RUNNING",
      stage: "INVENTORY_ACTIVATING",
    });
    try {
      if (current.quantity === null) {
        return markLine(input.prisma, line.id, now, {
          status: "BLOCKED",
          errorCode: "INVALID_INCOMING_QUANTITY",
          errorDetail: "New product quantity is missing; inventory was not activated.",
        });
      }
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
        return markLine(input.prisma, line.id, now, {
          ...draftUserErrors(payload.userErrors, "INVENTORY_ACTIVATE"),
          stage: "INVENTORY_ACTIVATING",
        });
      }
      if (!payload.inventoryLevel?.id) {
        return markLine(input.prisma, line.id, now, {
          status: "UNCERTAIN",
          errorCode: "INVENTORY_ACTIVATE_UNCONFIRMED",
          errorDetail: "Shopify did not confirm inventory activation; retry will reuse its idempotency key.",
        });
      }
      current = await markLine(input.prisma, line.id, now, {
        status: "RUNNING",
        stage: "INVENTORY_ACTIVE",
        errorCode: null,
        errorDetail: null,
      });
    } catch (error) {
      return markLine(input.prisma, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "INVENTORY_ACTIVATE_UNCERTAIN",
        errorDetail: error instanceof Error ? error.message : "Inventory activation outcome is unknown.",
      });
    }
  }

  return markLine(input.prisma, line.id, now, {
    status: "SUCCEEDED",
    stage: "COMPLETED",
    completedAt: now(),
    errorCode: null,
    errorDetail: null,
  });
}

async function runLine(
  input: MergeInput,
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
    return markLine(input.prisma, line.id, now, {
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
    return markLine(input.prisma, line.id, now, {
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
      return markLine(input.prisma, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "INVENTORY_ADJUST_RECONCILIATION_REQUIRED",
        errorDetail: "The Shopify adjustment idempotency window cannot be proven safe for an automatic retry. Reconcile this receipt and inventory change manually before any further stock adjustment.",
      });
    }
  }
  const level = variant.inventoryItem.inventoryLevel;
  if (!variant.inventoryItem.tracked || !level) {
    return markLine(input.prisma, line.id, now, {
      status: isReconciliationRetry ? "UNCERTAIN" : "BLOCKED",
      errorCode: !variant.inventoryItem.tracked ? "INVENTORY_NOT_TRACKED" : "LOCATION_NOT_STOCKED",
      errorDetail: !variant.inventoryItem.tracked
        ? "Inventory tracking is disabled for this variant; no stock was adjusted."
        : "The variant is not stocked at the selected location; no stock was activated automatically.",
    });
  }
  if (line.quantity === null || line.quantity <= 0) {
    return markLine(input.prisma, line.id, now, {
      status: isReconciliationRetry ? "UNCERTAIN" : "BLOCKED",
      errorCode: "INVALID_INCOMING_QUANTITY",
      errorDetail: "Incoming quantity must be a positive whole number.",
    });
  }

  const currentAvailable = level.quantities.find(
    (quantity: { name: string; quantity: number }) => quantity.name === "available",
  )?.quantity;
  if (line.expectedQuantity === null || currentAvailable === undefined) {
    return markLine(input.prisma, line.id, now, {
      status: isReconciliationRetry ? "UNCERTAIN" : "BLOCKED",
      errorCode: "AVAILABLE_QUANTITY_UNAVAILABLE",
      errorDetail: "Shopify did not return the selected location's available quantity; no adjustment was attempted.",
    });
  }
  if (!isReconciliationRetry && currentAvailable !== line.expectedQuantity) {
    return markLine(input.prisma, line.id, now, {
      status: "BLOCKED",
      errorCode: "INVENTORY_CHANGED_SINCE_PREVIEW",
      errorDetail: "Available inventory changed after preview. Upload a fresh preview with a new receipt before merging.",
    });
  }
  const targetUrl = adminProductUrl(input.shop, variant.product.id);
  await markLine(input.prisma, line.id, now, {
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
      return markLine(input.prisma, line.id, now, {
        ...draftUserErrors(payload.userErrors, "INVENTORY_ADJUST"),
        stage: "INVENTORY_ADJUSTING",
        productId: variant.product.id,
        variantId: variant.id,
        inventoryItemId: variant.inventoryItem.id,
        shopifyProductUrl: targetUrl,
      });
    }
    if (!payload.inventoryAdjustmentGroup?.id) {
      return markLine(input.prisma, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "INVENTORY_ADJUST_UNCONFIRMED",
        errorDetail: "Shopify returned no adjustment ID; retry will reuse the persisted idempotency key.",
        productId: variant.product.id,
        variantId: variant.id,
        inventoryItemId: variant.inventoryItem.id,
        shopifyProductUrl: targetUrl,
      });
    }
    return markLine(input.prisma, line.id, now, {
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
    return markLine(input.prisma, line.id, now, {
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

export async function mergeImportBatch({
  shop,
  batchId,
  admin,
  prisma,
  now = () => new Date(),
}: MergeInput): Promise<MergeImportBatchResult> {
  let batch = await prisma.importBatch.findFirst({
    where: { id: batchId, shop },
    include: { lines: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) throw new MergeImportError("Import batch was not found for this store.", "BATCH_NOT_FOUND");
  if (batch.lines.length === 0 || batch.lines.length > MAX_MERGE_LINES) {
    throw new MergeImportError(
      `A merge must contain between 1 and ${MAX_MERGE_LINES} rows. Split larger CSV files.`,
      "BATCH_LIMIT",
    );
  }
  if (batch.status === "COMPLETED") {
    return {
      batchId,
      status: batch.status,
      lines: batch.lines.map(resultLine),
    };
  }

  const staleAt = new Date(now().getTime() - 15 * 60 * 1000);
  const claim = await prisma.importBatch.updateMany({
    where: {
      id: batchId,
      shop,
      OR: [
        { status: { in: ["PREVIEWED", "PARTIAL", "FAILED", "UNCERTAIN"] } },
        { status: "RUNNING", updatedAt: { lt: staleAt } },
      ],
    },
    data: { status: "RUNNING", updatedAt: now() },
  });
  if (claim.count !== 1) {
    throw new MergeImportError("This import is already being processed. Refresh before retrying.", "BATCH_ALREADY_RUNNING");
  }

  const claimedBatch = await prisma.importBatch.findFirst({
    where: { id: batchId, shop },
    include: { lines: { orderBy: { rowNumber: "asc" } } },
  });
  if (!claimedBatch) {
    throw new MergeImportError("Import batch was not found for this store.", "BATCH_NOT_FOUND");
  }
  batch = claimedBatch;
  let lines = batch.lines;
  if (lines.length === 0 || lines.length > MAX_MERGE_LINES) {
    await saveBatchState(prisma, batchId, "FAILED", now);
    throw new MergeImportError(
      `A merge must contain between 1 and ${MAX_MERGE_LINES} rows. Split larger CSV files.`,
      "BATCH_LIMIT",
    );
  }
  if (
    lines.some((line) => line.status === "BLOCKED" || line.operationType === "BLOCKED") &&
    lines.every((line) => line.status === "PREVIEWED" || line.status === "BLOCKED")
  ) {
    await saveBatchState(prisma, batchId, "FAILED", now);
    return { batchId, status: "FAILED", lines: lines.map(resultLine) };
  }

  let verifiedLocation: { id: string; name: string; isActive: boolean } | undefined;
  try {
    verifiedLocation = (await readLocations(admin)).find(
      (location) => location.id === batch.locationId,
    );
  } catch (error) {
    await saveBatchState(prisma, batchId, "UNCERTAIN", now);
    throw new MergeImportError(
      error instanceof Error ? error.message : "Unable to verify the selected location.",
      "LOCATION_LOOKUP_FAILED",
    );
  }
  if (!verifiedLocation || !verifiedLocation.isActive) {
    const detail = verifiedLocation
      ? "The selected Shopify location is inactive."
      : "The selected location is not available to this authenticated store.";
    for (const line of lines) {
      if (line.status === "SUCCEEDED" || line.status === "BLOCKED") continue;
      const mayHaveReachedShopify =
        line.status === "UNCERTAIN" ||
        (line.stage !== "PREPARED" && ["RUNNING", "FAILED"].includes(line.status));
      const reconciliationDetail = `${detail} Reconcile this line before retrying; its previous Shopify mutation outcome may be unknown.`;
      await markLine(prisma, line.id, now, mayHaveReachedShopify
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
    lines = await prisma.importLine.findMany({ where: { batchId }, orderBy: { rowNumber: "asc" } });
    const successful = lines.some((line) => line.status === "SUCCEEDED");
    const uncertain = lines.some((line) => line.status === "UNCERTAIN");
    const status = successful ? "PARTIAL" : uncertain ? "UNCERTAIN" : "FAILED";
    await saveBatchState(prisma, batchId, status, now);
    return { batchId, status, lines: lines.map(resultLine) };
  }

  for (const line of lines) {
    if (line.status === "SUCCEEDED" || line.status === "BLOCKED") continue;
    try {
      await prisma.importBatch.update({
        where: { id: batchId },
        data: { updatedAt: now() },
      });
      await runLine({ shop, batchId, admin, prisma, now }, batch, line, now);
    } catch (error) {
      await markLine(prisma, line.id, now, {
        status: "UNCERTAIN",
        errorCode: "LINE_EXECUTION_UNCERTAIN",
        errorDetail: error instanceof Error ? error.message : "Line execution outcome is unknown.",
      });
    }
  }

  lines = await prisma.importLine.findMany({
    where: { batchId },
    orderBy: { rowNumber: "asc" },
  });
  const successful = lines.filter((line) => line.status === "SUCCEEDED").length;
  const hasUnresolvedOutcome = lines.some((line) =>
    ["PREVIEWED", "RUNNING", "UNCERTAIN"].includes(line.status),
  );
  const status = hasUnresolvedOutcome
    ? "UNCERTAIN"
    : successful === lines.length
      ? "COMPLETED"
      : successful > 0
        ? "PARTIAL"
        : "FAILED";
  await saveBatchState(
    prisma,
    batchId,
    status,
    now,
    hasUnresolvedOutcome ? null : now(),
  );
  return { batchId, status, lines: lines.map(resultLine) };
}
