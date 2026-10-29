import type { ShopifyScopesApi } from "./shopify-scopes.server";
import { missingScopesForGrant, queryGrantedScopes } from "./shopify-scopes.server";
import { computeShopLocalDateWindow, type InventoryAggregation, type SalesAggregation } from "./overview-analytics.shared";
import { readSalesOrders } from "./overview-analytics-sales.server";
import { readInventoryVariants } from "./overview-analytics-inventory.server";
import { INVENTORY_LEVELS_QUERY, INVENTORY_VARIANTS_QUERY, ORDER_LINE_ITEMS_QUERY, SALES_ORDERS_QUERY, type AdminGraphQL } from "./overview-analytics-graphql.server";

const SALES_SCOPES = ["read_orders", "read_products"] as const;
const INVENTORY_SCOPES = ["read_products", "read_inventory"] as const;
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 100;

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
type CacheEntry = { sales?: CacheValue<SalesAggregation>; inventory?: CacheValue<InventoryAggregation> };
const analyticsCache = new Map<string, CacheEntry>();

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
