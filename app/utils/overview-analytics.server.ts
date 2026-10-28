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
const VARIANTS_PER_PAGE = 20;
const INVENTORY_LEVELS_PER_PAGE = 10;
const MAX_ORDER_PAGES = 40;
const MAX_LINE_ITEM_PAGES = 100;
const MAX_VARIANT_PAGES = 50;
const MAX_INVENTORY_LEVEL_PAGES = 25;
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
type GraphQLBody = { data?: unknown; errors?: GraphQLError[] };

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
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await admin.graphql(query, { variables, tries: 1, ...(signal ? { signal } : {}) });
    } catch {
      if (attempt < 2 && !signal?.aborted) {
        await wait(200 * (attempt + 1));
        continue;
      }
      throw new OverviewAnalyticsReadError();
    }

    let body: GraphQLBody;
    try {
      body = await response.json() as GraphQLBody;
    } catch {
      if ((response.status === 429 || !response.ok) && attempt < 2) {
        await wait(200 * (attempt + 1));
        continue;
      }
      throw new OverviewAnalyticsReadError("Shopify returned an invalid analytics response.");
    }
    const throttled = body.errors?.some((error) => error.extensions?.code === "THROTTLED") === true;
    if ((response.status === 429 || throttled) && attempt < 2 && !signal?.aborted) {
      await wait(250 * (attempt + 1));
      continue;
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

async function readOrderLineItems(
  admin: AdminGraphQL,
  order: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  const initial = connection<unknown>(order.lineItems);
  if (!initial) return false;
  const lineItems = [...initial.nodes];
  let cursor = initial.endCursor;
  let hasNext = initial.hasNextPage;
  if (!hasNext) {
    order.lineItems = { nodes: lineItems, pageInfo: { hasNextPage: false } };
    return true;
  }
  const orderId = typeof order.id === "string" ? order.id : null;
  if (!orderId || !cursor) {
    order.lineItems = { nodes: lineItems, pageInfo: { hasNextPage: true } };
    return false;
  }

  let pages = 1;
  while (hasNext && pages < MAX_LINE_ITEM_PAGES) {
    let data: { order?: { lineItems?: unknown } | null };
    try {
      data = await queryData(admin, ORDER_LINE_ITEMS_QUERY, { id: orderId, first: 100, after: cursor }, signal);
    } catch {
      order.lineItems = { nodes: lineItems, pageInfo: { hasNextPage: true } };
      return false;
    }
    const page = connection<unknown>(data.order?.lineItems);
    if (!page) {
      order.lineItems = { nodes: lineItems, pageInfo: { hasNextPage: true } };
      return false;
    }
    lineItems.push(...page.nodes);
    cursor = page.endCursor;
    hasNext = page.hasNextPage;
    pages += 1;
    if (hasNext && !cursor) break;
  }
  order.lineItems = { nodes: lineItems, pageInfo: { hasNextPage: hasNext } };
  return !hasNext;
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
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  let hasNext = true;
  let pages = 0;
  let partial = false;

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
      break;
    }
    const page = connection<Record<string, unknown>>(data.orders);
    if (!page) {
      if (pages === 0) throw new OverviewAnalyticsReadError("Shopify returned incomplete sales data.");
      partial = true;
      break;
    }
    for (const rawOrder of page.nodes) {
      const id = typeof rawOrder.id === "string" ? rawOrder.id : null;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      if (!await readOrderLineItems(admin, rawOrder, signal)) partial = true;
      orders.push(rawOrder as SalesOrder);
    }
    cursor = page.endCursor;
    hasNext = page.hasNextPage;
    pages += 1;
    if (hasNext && !cursor) {
      partial = true;
      break;
    }
  }
  if (hasNext) partial = true;
  return aggregateSalesOrders(orders, { currencyCode, timeZone, dates: window.dates, partial });
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
): Promise<{ levels: Array<{ isActive: boolean; available: number | null }>; complete: boolean }> {
  const first = connection<unknown>(inventoryItem.inventoryLevels);
  if (!first) return { levels: [], complete: false };
  const firstLevels = first.nodes.map(parseInventoryLevel);
  const levels = firstLevels.filter((level): level is NonNullable<typeof level> => level !== null);
  let complete = firstLevels.every((level) => level !== null);
  let hasNext = first.hasNextPage;
  let cursor = first.endCursor;
  let pages = 1;
  const itemId = typeof inventoryItem.id === "string" ? inventoryItem.id : null;
  while (hasNext && pages < MAX_INVENTORY_LEVEL_PAGES) {
    if (!itemId || !cursor) return { levels, complete: false };
    let data: { inventoryItem?: { inventoryLevels?: unknown } | null };
    try {
      data = await queryData(admin, INVENTORY_LEVELS_QUERY, { id: itemId, first: 100, after: cursor }, signal);
    } catch {
      return { levels, complete: false };
    }
    const page = connection<unknown>(data.inventoryItem?.inventoryLevels);
    if (!page) return { levels, complete: false };
    const parsed = page.nodes.map(parseInventoryLevel);
    levels.push(...parsed.filter((level): level is NonNullable<typeof level> => level !== null));
    if (parsed.some((level) => level === null)) complete = false;
    hasNext = page.hasNextPage;
    cursor = page.endCursor;
    pages += 1;
  }
  return { levels, complete: complete && !hasNext };
}

async function readInventoryVariants(admin: AdminGraphQL, signal?: AbortSignal): Promise<InventoryAggregation> {
  const variants: InventoryVariantInput[] = [];
  let cursor: string | null = null;
  let hasNext = true;
  let pages = 0;
  let partial = false;
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
      break;
    }
    const page = connection<Record<string, unknown>>(data.productVariants);
    if (!page) {
      if (pages === 0) throw new OverviewAnalyticsReadError("Shopify returned incomplete inventory data.");
      partial = true;
      break;
    }
    for (const row of page.nodes) {
      if (typeof row.id !== "string" || seen.has(row.id)) continue;
      seen.add(row.id);
      const product = record(row.product) ? row.product : null;
      if (!product || typeof product.id !== "string" || typeof product.title !== "string") {
        partial = true;
        continue;
      }
      const inventoryItem = record(row.inventoryItem) ? row.inventoryItem : null;
      let levels: Array<{ isActive: boolean; available: number | null }> = [];
      let levelsComplete = false;
      if (inventoryItem) {
        const read = await readAllInventoryLevels(admin, inventoryItem, signal);
        levels = read.levels;
        levelsComplete = read.complete;
        if (!read.complete) partial = true;
      } else {
        partial = true;
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
    cursor = page.endCursor;
    hasNext = page.hasNextPage;
    pages += 1;
    if (hasNext && !cursor) {
      partial = true;
      break;
    }
  }
  if (hasNext) partial = true;
  return aggregateInventoryVariants(variants, { lowStockThreshold: 5, partial });
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
