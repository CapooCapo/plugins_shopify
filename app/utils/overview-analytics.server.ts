import type { ShopifyScopesApi } from "./shopify-scopes.server";
import { missingScopesForGrant, queryGrantedScopes } from "./shopify-scopes.server";
import {
  aggregateInventoryVariants,
  aggregateSalesOrders,
  computeShopLocalDateWindow,
  type InventoryAggregation,
  type InventoryVariantInput,
  type SalesAggregation,
  type SalesOrder,
} from "./overview-analytics.shared";

// Product/variant identity and titles are fetched from order lines for ranking.
const SALES_SCOPES = ["read_orders", "read_products"] as const;
// Location.isActive is readable with read_inventory; read_locations is not
// separately required for this InventoryLevel-scoped query.
const INVENTORY_SCOPES = ["read_products", "read_inventory"] as const;
const ORDERS_PER_PAGE = 25;
const ORDER_LINES_PER_PAGE = 10;
const CONTINUATION_PAGE_SIZE = 100;
const VARIANTS_PER_PAGE = 20;
const INVENTORY_LEVELS_PER_PAGE = 10;
const MAX_ORDER_PAGES = 40;
const MAX_LINE_ITEM_PAGES = 100;
// Bound the total number of line-item continuation HTTP attempts across one
// analytics load. At 100 rows/page this permits up to 10,000 additional lines,
// while preventing 1,000 orders from each consuming the per-order 100-page cap.
const MAX_LINE_ITEM_CONTINUATION_REQUESTS = 100;
const MAX_VARIANT_PAGES = 50;
const MAX_INVENTORY_LEVEL_PAGES = 25;
const MAX_ORDERS = ORDERS_PER_PAGE * MAX_ORDER_PAGES;
const MAX_ORDER_LINE_ITEMS = ORDER_LINES_PER_PAGE + (MAX_LINE_ITEM_PAGES - 1) * CONTINUATION_PAGE_SIZE;
const MAX_VARIANTS = VARIANTS_PER_PAGE * MAX_VARIANT_PAGES;
const MAX_INVENTORY_LEVELS_PER_VARIANT = INVENTORY_LEVELS_PER_PAGE + (MAX_INVENTORY_LEVEL_PAGES - 1) * CONTINUATION_PAGE_SIZE;
const MAX_QUERY_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;
const FALLBACK_RETRY_DELAY_MS = 300;
const RETRY_DELAY_BUFFER_MS = 100;
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 100;

const SALES_ORDERS_QUERY = `#graphql
  query StockHubOverviewOrders($first: Int!, $after: String, $query: String!, $lineItemsFirst: Int!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      nodes {
        id
        createdAt
        cancelledAt
        test
        lineItems(first: $lineItemsFirst) {
          nodes {
            id
            currentQuantity
            priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
            product { id title legacyResourceId featuredImage { url } }
            variant { id title sku legacyResourceId }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ORDER_LINE_ITEMS_QUERY = `#graphql
  query StockHubOverviewOrderLineItems($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      lineItems(first: $first, after: $after) {
        nodes {
          id
          currentQuantity
          priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
          product { id title legacyResourceId featuredImage { url } }
          variant { id title sku legacyResourceId }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const INVENTORY_VARIANTS_QUERY = `#graphql
  query StockHubOverviewInventoryVariants($first: Int!, $after: String, $levelsFirst: Int!) {
    productVariants(first: $first, after: $after) {
      nodes {
        id
        title
        sku
        legacyResourceId
        product { id title legacyResourceId featuredImage { url } }
        inventoryItem {
          id
          tracked
          inventoryLevels(first: $levelsFirst, includeInactive: false) {
            nodes {
              isActive
              location { id isActive }
              quantities(names: ["available"]) { name quantity }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const INVENTORY_LEVELS_QUERY = `#graphql
  query StockHubOverviewInventoryLevels($id: ID!, $first: Int!, $after: String) {
    inventoryItem(id: $id) {
      inventoryLevels(first: $first, after: $after, includeInactive: false) {
        nodes {
          isActive
          location { id isActive }
          quantities(names: ["available"]) { name quantity }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

type AdminGraphQL = {
  graphql: (query: string, options?: {
    variables?: Record<string, unknown>;
    tries?: number;
    signal?: AbortSignal;
  }) => Promise<Response>;
};

type GraphQLError = { message?: string; extensions?: { code?: string } };
type GraphQLBody = {
  data?: unknown;
  errors?: GraphQLError[];
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: {
        currentlyAvailable?: number;
        restoreRate?: number;
      };
    };
  };
};

export type OverviewAnalyticsSection<T> = {
  status: "ready" | "partial" | "unavailable" | "permission_required" | "unverified";
  data: T | null;
  message?: string;
  fetchedAt: string | null;
};

export type OverviewAnalytics = {
  range: 7 | 30;
  timeZone: string | null;
  currencyCode: string | null;
  scopesVerified: boolean;
  salesMissingScopes: string[];
  inventoryMissingScopes: string[];
  sales: OverviewAnalyticsSection<SalesAggregation>;
  inventory: OverviewAnalyticsSection<InventoryAggregation>;
  fetchedAt: string | null;
};

type CacheValue<T> = { data: T; fetchedAt: string; expiresAt: number };
type CacheEntry = {
  sales?: CacheValue<SalesAggregation>;
  inventory?: CacheValue<InventoryAggregation>;
};

const analyticsCache = new Map<string, CacheEntry>();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterHeaderMs(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * Shopify exposes the requested query cost, available bucket points, and
 * restore rate on GraphQL responses. Honor that signal when possible, but
 * never wait indefinitely: a delay above the cap fails closed instead of
 * sending another request before the bucket should be ready.
 */
function retryDelayMs(response: Response, body: GraphQLBody | null, retryIndex: number): number | null {
  const retryAfter = retryAfterHeaderMs(response);
  if (retryAfter !== null) return retryAfter <= MAX_RETRY_DELAY_MS ? retryAfter : null;

  const cost = body?.extensions?.cost;
  const requested = cost?.requestedQueryCost;
  const available = cost?.throttleStatus?.currentlyAvailable;
  const restoreRate = cost?.throttleStatus?.restoreRate;
  if ([requested, available, restoreRate].every((value) => typeof value === "number" && Number.isFinite(value))
    && requested! >= 0 && available! >= 0 && restoreRate! > 0) {
    const requiredMs = Math.max(0, requested! - available!) / restoreRate! * 1_000;
    // If metadata says the bucket already has room, retain a small fallback
    // delay because Shopify may still have rejected on a concurrent request.
    const delay = requiredMs > 0 ? Math.ceil(requiredMs + RETRY_DELAY_BUFFER_MS) : FALLBACK_RETRY_DELAY_MS * 2 ** retryIndex;
    return delay <= MAX_RETRY_DELAY_MS ? delay : null;
  }

  const fallback = FALLBACK_RETRY_DELAY_MS * 2 ** retryIndex;
  return fallback <= MAX_RETRY_DELAY_MS ? fallback : null;
}

export class OverviewAnalyticsReadError extends Error {
  constructor(message = "Shopify analytics could not be fully loaded.") {
    super(message);
    this.name = "OverviewAnalyticsReadError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function queryData<T>(
  admin: AdminGraphQL,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
  requestBudget?: RequestBudget,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_QUERY_ATTEMPTS; attempt += 1) {
    if (requestBudget) {
      if (requestBudget.remaining <= 0) throw new RequestBudgetExceededError();
      // Count every network attempt, including throttling/network retries.
      requestBudget.remaining -= 1;
    }
    let response: Response;
    try {
      response = await admin.graphql(query, { variables, tries: 1, ...(signal ? { signal } : {}) });
    } catch {
      if (attempt < MAX_QUERY_ATTEMPTS - 1 && !signal?.aborted) {
        await wait(FALLBACK_RETRY_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw new OverviewAnalyticsReadError();
    }

    let body: GraphQLBody;
    try {
      body = await response.json() as GraphQLBody;
    } catch {
      if ((response.status === 429 || !response.ok) && attempt < MAX_QUERY_ATTEMPTS - 1 && !signal?.aborted) {
        const delay = retryDelayMs(response, null, attempt);
        if (delay !== null) {
          await wait(delay);
          continue;
        }
      }
      throw new OverviewAnalyticsReadError("Shopify returned an invalid analytics response.");
    }
    const throttled = body.errors?.some((error) => error.extensions?.code === "THROTTLED") === true;
    if ((response.status === 429 || throttled) && attempt < MAX_QUERY_ATTEMPTS - 1 && !signal?.aborted) {
      const delay = retryDelayMs(response, body, attempt);
      if (delay !== null) {
        await wait(delay);
        continue;
      }
    }
    if (!response.ok || body.errors?.length || body.data == null) {
      throw new OverviewAnalyticsReadError();
    }
    return body.data as T;
  }
  throw new OverviewAnalyticsReadError();
}

function connection<T>(value: unknown): { nodes: T[]; hasNextPage: boolean; endCursor: string | null } | null {
  if (!record(value) || !record(value.pageInfo) || !Array.isArray(value.nodes) || typeof value.pageInfo.hasNextPage !== "boolean") return null;
  const cursor = value.pageInfo.endCursor;
  if (!(cursor === null || typeof cursor === "string")) return null;
  return { nodes: value.nodes as T[], hasNextPage: value.pageInfo.hasNextPage, endCursor: cursor };
}

function salesSearch(startUtc: string, endExclusiveUtc: string) {
  return `created_at:>=${startUtc} created_at:<${endExclusiveUtc}`;
}

function appendPartialReasons<T extends { status: "ready" | "partial" | "unavailable"; reason?: string }>(
  result: T,
  reasons: string[],
): T {
  const uniqueReasons = [...new Set(reasons.filter(Boolean))];
  if (!uniqueReasons.length) return result;
  const existing = result.reason ? [result.reason] : [];
  return {
    ...result,
    status: "partial",
    reason: [...new Set([...existing, ...uniqueReasons])].join(" "),
  };
}

type PageReadResult<T> = { values: T[]; complete: boolean; reason?: string };

type RequestBudget = { remaining: number };

class RequestBudgetExceededError extends Error {
  constructor() {
    super("The per-load Shopify request budget was exhausted.");
    this.name = "RequestBudgetExceededError";
  }
}

async function readOrderLineItems(
  admin: AdminGraphQL,
  order: Record<string, unknown>,
  continuationBudget: RequestBudget,
  signal?: AbortSignal,
): Promise<{ complete: boolean; reason?: string }> {
  const initial = connection<unknown>(order.lineItems);
  if (!initial) return { complete: false, reason: "Some order line-item pages were missing valid pagination data." };
  const lineItems = [...initial.nodes];
  let cursor = initial.endCursor;
  let hasNext = initial.hasNextPage;
  if (!hasNext) {
    order.lineItems = { nodes: lineItems, pageInfo: { hasNextPage: false } };
    return { complete: true };
  }
  const orderId = typeof order.id === "string" ? order.id : null;
  if (!orderId || !cursor) {
    order.lineItems = { nodes: lineItems, pageInfo: { hasNextPage: true } };
    return { complete: false, reason: "Some order line items could not be continued because Shopify returned no order ID or end cursor." };
  }
  if (continuationBudget.remaining <= 0) {
    order.lineItems = { nodes: lineItems, pageInfo: { hasNextPage: true } };
    return { complete: false, reason: "The Overview line-item continuation request budget was reached; displayed sales totals include only the order lines already read." };
  }

  let pages = 1;
  let reason: string | undefined;
  while (hasNext && pages < MAX_LINE_ITEM_PAGES) {
    let data: { order?: { lineItems?: unknown } | null };
    try {
      data = await queryData(
        admin,
        ORDER_LINE_ITEMS_QUERY,
        { id: orderId, first: CONTINUATION_PAGE_SIZE, after: cursor },
        signal,
        continuationBudget,
      );
    } catch (error) {
      order.lineItems = { nodes: lineItems, pageInfo: { hasNextPage: true } };
      if (error instanceof RequestBudgetExceededError) {
        return { complete: false, reason: "The Overview line-item continuation request budget was reached; displayed sales totals include only the order lines already read." };
      }
      return { complete: false, reason: "Some order line-item pages could not be loaded; order and sales totals are partial." };
    }
    const page = connection<unknown>(data.order?.lineItems);
    if (!page) {
      order.lineItems = { nodes: lineItems, pageInfo: { hasNextPage: true } };
      return { complete: false, reason: "Shopify returned incomplete pagination data for some order line items; totals are partial." };
    }
    lineItems.push(...page.nodes);
    if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) {
      hasNext = true;
      reason = "Shopify did not advance an order line-item cursor; remaining line items were not read.";
      break;
    }
    cursor = page.endCursor;
    hasNext = page.hasNextPage;
    pages += 1;
  }
  if (hasNext && !reason) {
    reason = `An order exceeded the ${MAX_ORDER_LINE_ITEMS.toLocaleString()} line-item pagination safety cap; some line items were not included.`;
  }
  order.lineItems = { nodes: lineItems, pageInfo: { hasNextPage: hasNext } };
  return { complete: !hasNext, ...(reason ? { reason } : {}) };
}

async function readSalesOrders(
  admin: AdminGraphQL,
  window: ReturnType<typeof computeShopLocalDateWindow>,
  timeZone: string,
  currencyCode: string,
  signal?: AbortSignal,
): Promise<SalesAggregation> {
  const search = salesSearch(window.startUtc, window.endExclusiveUtc);
  const orders: SalesOrder[] = [];
  const continuationBudget: RequestBudget = { remaining: MAX_LINE_ITEM_CONTINUATION_REQUESTS };
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  let hasNext = true;
  let pages = 0;
  let partial = false;
  const partialReasons: string[] = [];

  while (hasNext && pages < MAX_ORDER_PAGES) {
    let data: { orders?: unknown };
    try {
      data = await queryData(admin, SALES_ORDERS_QUERY, {
        first: ORDERS_PER_PAGE,
        after: cursor,
        query: search,
        lineItemsFirst: ORDER_LINES_PER_PAGE,
      }, signal);
    } catch {
      if (pages === 0) throw new OverviewAnalyticsReadError("Shopify sales data could not be loaded. Try again shortly.");
      partial = true;
      partialReasons.push("Some order pages could not be loaded; displayed sales totals include only the pages already read.");
      break;
    }
    const page = connection<Record<string, unknown>>(data.orders);
    if (!page) {
      if (pages === 0) throw new OverviewAnalyticsReadError("Shopify returned incomplete sales data.");
      partial = true;
      partialReasons.push("Shopify returned an incomplete order page; displayed sales totals include only the pages already read.");
      break;
    }
    for (const rawOrder of page.nodes) {
      const id = typeof rawOrder.id === "string" ? rawOrder.id : null;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      const lineItems = await readOrderLineItems(admin, rawOrder, continuationBudget, signal);
      if (!lineItems.complete) {
        partial = true;
        if (lineItems.reason) partialReasons.push(lineItems.reason);
      }
      orders.push(rawOrder as SalesOrder);
    }
    if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) {
      hasNext = true;
      partial = true;
      partialReasons.push("Shopify did not advance the order cursor; remaining orders were not read.");
      break;
    }
    cursor = page.endCursor;
    hasNext = page.hasNextPage;
    pages += 1;
  }
  if (hasNext) {
    partial = true;
    if (pages >= MAX_ORDER_PAGES) {
      partialReasons.push(`Only the first ${MAX_ORDERS.toLocaleString()} orders were read because the Overview safety cap was reached. Totals are partial; switch to 7 days to narrow the range, or review the full order set in Shopify Admin.`);
    } else if (!partialReasons.some((reason) => reason.includes("cursor"))) {
      partialReasons.push("Shopify returned no usable next-order cursor; remaining orders were not read.");
    }
  }
  const aggregation = aggregateSalesOrders(orders, { currencyCode, timeZone, dates: window.dates, partial });
  return appendPartialReasons(aggregation, partialReasons);
}

function parseInventoryLevel(value: unknown) {
  if (!record(value)) return null;
  const location = record(value.location) ? value.location : null;
  if (typeof value.isActive !== "boolean" || typeof location?.isActive !== "boolean" || !Array.isArray(value.quantities)) return null;
  const available = Array.isArray(value.quantities)
    ? value.quantities.find((quantity) => record(quantity) && quantity.name === "available")
    : null;
  return {
    isActive: value.isActive === true && location?.isActive === true,
    available: record(available) && typeof available.quantity === "number" && Number.isFinite(available.quantity)
      ? available.quantity : null,
  };
}

async function readAllInventoryLevels(
  admin: AdminGraphQL,
  inventoryItem: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PageReadResult<{ isActive: boolean; available: number | null }>> {
  const first = connection<unknown>(inventoryItem.inventoryLevels);
  if (!first) return { values: [], complete: false, reason: "Inventory-level data did not include valid pagination information." };
  const firstLevels = first.nodes.map(parseInventoryLevel);
  const levels = firstLevels.filter((level): level is NonNullable<typeof level> => level !== null);
  let complete = firstLevels.every((level) => level !== null);
  const reasons: string[] = [];
  if (!complete) reasons.push("Some inventory-level rows were incomplete and were excluded from stock totals.");
  let hasNext = first.hasNextPage;
  let cursor = first.endCursor;
  let pages = 1;
  const itemId = typeof inventoryItem.id === "string" ? inventoryItem.id : null;
  while (hasNext && pages < MAX_INVENTORY_LEVEL_PAGES) {
    if (!itemId || !cursor) {
      reasons.push("Inventory locations could not be fully read because Shopify returned no inventory-item ID or end cursor.");
      return { values: levels, complete: false, reason: reasons.join(" ") };
    }
    let data: { inventoryItem?: { inventoryLevels?: unknown } | null };
    try {
      data = await queryData(admin, INVENTORY_LEVELS_QUERY, { id: itemId, first: CONTINUATION_PAGE_SIZE, after: cursor }, signal);
    } catch {
      reasons.push("Some inventory-location pages could not be loaded; affected stock totals remain unknown.");
      return { values: levels, complete: false, reason: reasons.join(" ") };
    }
    const page = connection<unknown>(data.inventoryItem?.inventoryLevels);
    if (!page) {
      reasons.push("Shopify returned incomplete inventory-location pagination data; affected stock totals remain unknown.");
      return { values: levels, complete: false, reason: reasons.join(" ") };
    }
    const parsed = page.nodes.map(parseInventoryLevel);
    levels.push(...parsed.filter((level): level is NonNullable<typeof level> => level !== null));
    if (parsed.some((level) => level === null)) {
      complete = false;
      reasons.push("Some inventory-level rows were incomplete and were excluded from stock totals.");
    }
    if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) {
      complete = false;
      reasons.push("Shopify did not advance an inventory-location cursor; remaining locations were not read.");
      return { values: levels, complete, reason: [...new Set(reasons)].join(" ") };
    }
    hasNext = page.hasNextPage;
    cursor = page.endCursor;
    pages += 1;
  }
  if (hasNext && pages >= MAX_INVENTORY_LEVEL_PAGES) {
    complete = false;
    reasons.push(`A variant exceeded the ${MAX_INVENTORY_LEVELS_PER_VARIANT.toLocaleString()} inventory-level safety cap; remaining locations were not read, so its total is unknown.`);
  }
  return { values: levels, complete: complete && !hasNext, ...(reasons.length ? { reason: [...new Set(reasons)].join(" ") } : {}) };
}

async function readInventoryVariants(admin: AdminGraphQL, signal?: AbortSignal): Promise<InventoryAggregation> {
  const variants: InventoryVariantInput[] = [];
  let cursor: string | null = null;
  let hasNext = true;
  let pages = 0;
  let partial = false;
  const partialReasons: string[] = [];
  const seen = new Set<string>();

  while (hasNext && pages < MAX_VARIANT_PAGES) {
    let data: { productVariants?: unknown };
    try {
      data = await queryData(admin, INVENTORY_VARIANTS_QUERY, {
        first: VARIANTS_PER_PAGE,
        after: cursor,
        levelsFirst: INVENTORY_LEVELS_PER_PAGE,
      }, signal);
    } catch {
      if (pages === 0) throw new OverviewAnalyticsReadError("Shopify inventory data could not be loaded. Try again shortly.");
      partial = true;
      partialReasons.push("Some product-variant pages could not be loaded; inventory totals include only the pages already read.");
      break;
    }
    const page = connection<Record<string, unknown>>(data.productVariants);
    if (!page) {
      if (pages === 0) throw new OverviewAnalyticsReadError("Shopify returned incomplete inventory data.");
      partial = true;
      partialReasons.push("Shopify returned an incomplete product-variant page; inventory totals include only the pages already read.");
      break;
    }
    for (const row of page.nodes) {
      if (typeof row.id !== "string" || seen.has(row.id)) continue;
      seen.add(row.id);
      const product = record(row.product) ? row.product : null;
      if (!product || typeof product.id !== "string" || typeof product.title !== "string") {
        partial = true;
        partialReasons.push("Some variants were missing product identity and were excluded from inventory detail.");
        continue;
      }
      const inventoryItem = record(row.inventoryItem) ? row.inventoryItem : null;
      let levels: Array<{ isActive: boolean; available: number | null }> = [];
      let levelsComplete = false;
      if (inventoryItem) {
        const read = await readAllInventoryLevels(admin, inventoryItem, signal);
        levels = read.values;
        levelsComplete = read.complete;
        if (!read.complete) {
          partial = true;
          if (read.reason) partialReasons.push(read.reason);
        }
      } else {
        partial = true;
        partialReasons.push("Some variants were missing Shopify inventory-item data and remain unknown.");
      }
      variants.push({
        id: row.id,
        title: typeof row.title === "string" ? row.title : "Variant",
        sku: typeof row.sku === "string" ? row.sku : null,
        product: {
          id: product.id,
          title: product.title,
          legacyResourceId: typeof product.legacyResourceId === "string" || typeof product.legacyResourceId === "number"
            ? product.legacyResourceId : null,
          imageUrl: record(product.featuredImage) && typeof product.featuredImage.url === "string" ? product.featuredImage.url : null,
        },
        tracked: inventoryItem && typeof inventoryItem.tracked === "boolean" ? inventoryItem.tracked : null,
        levels,
        levelsComplete,
      });
    }
    if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) {
      hasNext = true;
      partial = true;
      partialReasons.push("Shopify did not advance the product-variant cursor; remaining variants were not read.");
      break;
    }
    cursor = page.endCursor;
    hasNext = page.hasNextPage;
    pages += 1;
  }
  if (hasNext) {
    partial = true;
    if (pages >= MAX_VARIANT_PAGES) {
      partialReasons.push(`Only the first ${MAX_VARIANTS.toLocaleString()} product variants were read because the Overview safety cap was reached. Inventory totals are partial; review the full catalog in Shopify Admin.`);
    } else if (!partialReasons.some((reason) => reason.includes("cursor"))) {
      partialReasons.push("Shopify returned no usable next-variant cursor; remaining variants were not read.");
    }
  }
  const aggregation = aggregateInventoryVariants(variants, { lowStockThreshold: 5, partial });
  return appendPartialReasons(aggregation, partialReasons);
}

function cacheKey(shop: string, range: 7 | 30, shopDate: string, timeZone: string, currencyCode: string) {
  return JSON.stringify([shop.trim().toLowerCase(), range, shopDate, timeZone, currencyCode]);
}

function readCache(key: string, now: number) {
  const entry = analyticsCache.get(key);
  if (!entry) return undefined;
  const sales = entry.sales && entry.sales.expiresAt > now ? entry.sales : undefined;
  const inventory = entry.inventory && entry.inventory.expiresAt > now ? entry.inventory : undefined;
  if (!sales && !inventory) {
    analyticsCache.delete(key);
    return undefined;
  }
  const valid: CacheEntry = {
    ...(sales ? { sales } : {}),
    ...(inventory ? { inventory } : {}),
  };
  analyticsCache.set(key, valid);
  return valid;
}

function writeCache(key: string, current: CacheEntry) {
  if (analyticsCache.size >= MAX_CACHE_ENTRIES && !analyticsCache.has(key)) {
    const oldestKey = analyticsCache.keys().next().value;
    if (oldestKey) analyticsCache.delete(oldestKey);
  }
  analyticsCache.set(key, current);
}

function section<T>(status: OverviewAnalyticsSection<T>["status"], data: T | null, message?: string, fetchedAt: string | null = null): OverviewAnalyticsSection<T> {
  return { status, data, ...(message ? { message } : {}), fetchedAt };
}

function notAvailableSections(status: "unverified" | "unavailable", message: string, range: 7 | 30, timeZone: string | null, currencyCode: string | null): OverviewAnalytics {
  return {
    range,
    timeZone,
    currencyCode,
    scopesVerified: false,
    salesMissingScopes: [],
    inventoryMissingScopes: [],
    sales: section<SalesAggregation>(status, null, message),
    inventory: section<InventoryAggregation>(status, null, message),
    fetchedAt: null,
  };
}

/**
 * Scope-gates all analytics against Shopify's live grant, then reads only
 * aggregate-safe order and inventory fields. No database writes or raw-order
 * caching occur here.
 */
export async function loadOverviewAnalytics(input: {
  admin: AdminGraphQL;
  scopes: ShopifyScopesApi;
  shop: string;
  range: 7 | 30;
  timeZone: string | null;
  currencyCode: string | null;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<OverviewAnalytics> {
  let granted: string[];
  try {
    granted = await queryGrantedScopes(input.scopes);
  } catch {
    return notAvailableSections(
      "unverified",
      "Could not verify this Shopify installation's current access. No sales or inventory analytics request was sent.",
      input.range,
      input.timeZone,
      input.currencyCode,
    );
  }

  const salesMissingScopes = missingScopesForGrant(granted, SALES_SCOPES);
  const inventoryMissingScopes = missingScopesForGrant(granted, INVENTORY_SCOPES);
  const zone = input.timeZone;
  const currencyCode = input.currencyCode;
  const requestTime = (input.now ?? (() => new Date()))();
  let window: ReturnType<typeof computeShopLocalDateWindow> | null = null;
  if (zone) {
    try {
      window = computeShopLocalDateWindow(requestTime, input.range, zone);
    } catch {
      window = null;
    }
  }
  const shopDate = window?.dates.at(-1) ?? null;
  const key = zone && currencyCode && shopDate ? cacheKey(input.shop, input.range, shopDate, zone, currencyCode) : null;
  const cached = key ? readCache(key, requestTime.getTime()) : undefined;
  const salesCacheHit = salesMissingScopes.length === 0 && Boolean(zone && currencyCode && window && cached?.sales?.data.status === "ready");
  const inventoryCacheHit = inventoryMissingScopes.length === 0 && cached?.inventory?.data.status === "ready";

  const salesPromise: Promise<OverviewAnalyticsSection<SalesAggregation>> = salesMissingScopes.length
    ? Promise.resolve(section<SalesAggregation>("permission_required", null,
      `Sales analytics require the ${salesMissingScopes.join(", ")} permission. Add the minimum missing scope to the Development App and reauthorize StockHub; no order data was requested.`))
    : !zone || !currencyCode || !window
      ? Promise.resolve(section<SalesAggregation>("unavailable", null, "Shop-local time zone or shop currency is unavailable, so sales metrics cannot be calculated safely."))
      : cached?.sales && cached.sales.data.status === "ready"
        ? Promise.resolve(section<SalesAggregation>("ready", cached.sales.data, undefined, cached.sales.fetchedAt))
      : readSalesOrders(input.admin, window, zone, currencyCode, input.signal)
          .then((data) => section<SalesAggregation>(data.status, data, data.reason))
          .catch((error: unknown) => section<SalesAggregation>("unavailable", null,
            error instanceof Error ? error.message : "Shopify sales data could not be loaded. Try again shortly."));

  const inventoryPromise: Promise<OverviewAnalyticsSection<InventoryAggregation>> = inventoryMissingScopes.length
    ? Promise.resolve(section<InventoryAggregation>("permission_required", null,
      `Inventory health requires ${inventoryMissingScopes.join(", ")}. No inventory analytics request was sent.`))
    : cached?.inventory && cached.inventory.data.status === "ready"
      ? Promise.resolve(section<InventoryAggregation>("ready", cached.inventory.data, undefined, cached.inventory.fetchedAt))
      : readInventoryVariants(input.admin, input.signal)
        .then((data) => section<InventoryAggregation>(data.status, data, data.reason))
        .catch((error: unknown) => section<InventoryAggregation>("unavailable", null,
          error instanceof Error ? error.message : "Shopify inventory data could not be loaded. Try again shortly."));

  const [sales, inventory] = await Promise.all([salesPromise, inventoryPromise]);
  const completedAt = (input.now ?? (() => new Date()))();
  if (sales.status === "ready" && sales.data && !salesCacheHit) sales.fetchedAt = completedAt.toISOString();
  if (inventory.status === "ready" && inventory.data && !inventoryCacheHit) inventory.fetchedAt = completedAt.toISOString();
  if (key && (sales.status === "ready" || inventory.status === "ready")) {
    const next: CacheEntry = { ...(cached ?? {}) };
    if (sales.status === "ready" && sales.data && sales.fetchedAt && !salesCacheHit) {
      next.sales = { data: sales.data, fetchedAt: sales.fetchedAt, expiresAt: completedAt.getTime() + CACHE_TTL_MS };
    }
    if (inventory.status === "ready" && inventory.data && inventory.fetchedAt && !inventoryCacheHit) {
      next.inventory = { data: inventory.data, fetchedAt: inventory.fetchedAt, expiresAt: completedAt.getTime() + CACHE_TTL_MS };
    }
    if (next.sales || next.inventory) writeCache(key, next);
  }

  const fetchedTimes = [sales.fetchedAt, inventory.fetchedAt].filter((value): value is string => Boolean(value)).sort();
  const fetchedAt = fetchedTimes.length ? fetchedTimes[0] : null;
  return {
    range: input.range,
    timeZone: zone,
    currencyCode,
    scopesVerified: true,
    salesMissingScopes,
    inventoryMissingScopes,
    sales,
    inventory,
    fetchedAt,
  };
}

export const overviewAnalyticsGraphQL = {
  salesOrders: SALES_ORDERS_QUERY,
  orderLineItems: ORDER_LINE_ITEMS_QUERY,
  inventoryVariants: INVENTORY_VARIANTS_QUERY,
  inventoryLevels: INVENTORY_LEVELS_QUERY,
};
