import { aggregateSalesOrders, type SalesOrder, type SalesAggregation } from "./overview-analytics.shared";
import { appendPartialReasons, connection, queryData, OverviewAnalyticsReadError, RequestBudgetExceededError, SALES_ORDERS_QUERY, ORDER_LINE_ITEMS_QUERY, type AdminGraphQL, type RequestBudget } from "./overview-analytics-graphql.server";
import { computeShopLocalDateWindow } from "./overview-analytics.shared";
import { datePartsInZone } from "./overview-analytics-dates.shared";

const ORDERS_PER_PAGE = 25;
const ORDER_LINES_PER_PAGE = 10;
const CONTINUATION_PAGE_SIZE = 100;
const MAX_ORDER_PAGES = 40;
const MAX_LINE_ITEM_PAGES = 100;
const MAX_LINE_ITEM_CONTINUATION_REQUESTS = 100;
const MAX_ORDERS = ORDERS_PER_PAGE * MAX_ORDER_PAGES;
const MAX_ORDER_LINE_ITEMS = ORDER_LINES_PER_PAGE + (MAX_LINE_ITEM_PAGES - 1) * CONTINUATION_PAGE_SIZE;
const MAX_FX_CACHE_ENTRIES = 100;
const FX_CACHE_TTL_MS = 60 * 60 * 1_000;
const FX_EMPTY_CACHE_TTL_MS = 30 * 1_000;
const usdRatesCache = new Map<string, { rates: Map<string, Record<string, number>>; expiresAt: number }>();
const usdRatesInFlight = new Map<string, Promise<Map<string, Record<string, number>>>>();

function salesSearch(startUtc: string, endExclusiveUtc: string) {
  return `created_at:>=${startUtc} created_at:<${endExclusiveUtc}`;
}

function shiftDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function hasNonZeroStoreRevenue(orders: SalesOrder[], currencyCode: string, timeZone: string, dates: string[]) {
  const dateSet = new Set(dates);
  return orders.some((order) => {
    if (order.cancelledAt || order.test !== false || !order.createdAt) return false;
    const createdAt = new Date(order.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || !dateSet.has(datePartsInZone(createdAt, timeZone))) return false;
    const lines = Array.isArray(order.lineItems) ? order.lineItems
      : order.lineItems && typeof order.lineItems === "object" && Array.isArray(order.lineItems.nodes) ? order.lineItems.nodes : [];
    return lines.some((line) => {
      const money = line.priceAfterAllDiscountsBeforeTaxesSet?.shopMoney;
      const rawAmount = money?.amount;
      const amount = typeof rawAmount === "number" ? rawAmount : typeof rawAmount === "string" ? Number(rawAmount) : Number.NaN;
      return money?.currencyCode === currencyCode && Number.isFinite(amount) && amount !== 0;
    });
  });
}

async function fetchUsdReferenceRates(
  currencyCode: string,
  dates: string[],
): Promise<Map<string, Record<string, number>>> {
  const firstDate = dates[0];
  const lastDate = dates.at(-1);
  if (!firstDate || !lastDate) return new Map();

  const from = shiftDate(firstDate, -14);
  const url = new URL("https://api.frankfurter.dev/v2/rates");
  url.searchParams.set("from", from);
  url.searchParams.set("to", lastDate);
  url.searchParams.set("base", currencyCode);
  url.searchParams.set("quotes", "USD");
  const cacheKey = JSON.stringify([currencyCode, from, lastDate]);
  const now = Date.now();
  const cached = usdRatesCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    usdRatesCache.delete(cacheKey);
    usdRatesCache.set(cacheKey, cached);
    return new Map(cached.rates);
  }
  if (cached) usdRatesCache.delete(cacheKey);

  const inFlight = usdRatesInFlight.get(cacheKey);
  if (inFlight) return new Map(await inFlight);

  const request = (async () => {
    const rates = new Map<string, Record<string, number>>();
    try {
      const timeout = AbortSignal.timeout(5_000);
      const response = await fetch(url, { signal: timeout, headers: { accept: "application/json" } });
      if (response.ok) {
        const payload: unknown = await response.json();
        if (Array.isArray(payload)) {
          for (const entry of payload) {
            if (typeof entry !== "object" || entry === null) continue;
            const row = entry as { date?: unknown; base?: unknown; quote?: unknown; rate?: unknown };
            if (typeof row.date !== "string" || row.base !== currencyCode || row.quote !== "USD" || typeof row.rate !== "number" || !Number.isFinite(row.rate) || row.rate <= 0) continue;
            rates.set(row.date, { [currencyCode]: row.rate });
          }
        }
      }
    } catch {
      // A missing public reference rate is reflected as partial/unavailable
      // revenue by the aggregator; it must never trigger a native-currency fallback.
    }

    if (usdRatesCache.size >= MAX_FX_CACHE_ENTRIES && !usdRatesCache.has(cacheKey)) {
      const oldestKey = usdRatesCache.keys().next().value;
      if (oldestKey) usdRatesCache.delete(oldestKey);
    }
    usdRatesCache.set(cacheKey, {
      rates,
      expiresAt: Date.now() + (rates.size > 0 ? FX_CACHE_TTL_MS : FX_EMPTY_CACHE_TTL_MS),
    });
    return rates;
  })();
  usdRatesInFlight.set(cacheKey, request);
  try {
    return new Map(await request);
  } finally {
    if (usdRatesInFlight.get(cacheKey) === request) usdRatesInFlight.delete(cacheKey);
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

export async function readSalesOrders(
  admin: AdminGraphQL,
  window: ReturnType<typeof computeShopLocalDateWindow>,
  timeZone: string,
  currencyCode: string,
  signal?: AbortSignal,
  options: { includeVariantDetails?: boolean; convertToUsd?: boolean } = {},
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
  const usdRatesByDate = options.convertToUsd && currencyCode !== "USD"
    ? await fetchUsdReferenceRates(currencyCode, hasNonZeroStoreRevenue(orders, currencyCode, timeZone, window.dates) ? window.dates : [])
    : undefined;
  const aggregation = aggregateSalesOrders(orders, {
    currencyCode, timeZone, dates: window.dates, partial,
    ...(options.convertToUsd && currencyCode !== "USD" ? { usdRatesByDate: usdRatesByDate ?? new Map() } : {}),
    includeVariantDetails: options.includeVariantDetails,
  });
  return appendPartialReasons(aggregation, partialReasons);
}
