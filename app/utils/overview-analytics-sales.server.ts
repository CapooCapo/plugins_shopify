import { aggregateSalesOrders, type SalesOrder, type SalesAggregation } from "./overview-analytics.shared";
import { appendPartialReasons, connection, queryData, OverviewAnalyticsReadError, RequestBudgetExceededError, SALES_ORDERS_QUERY, ORDER_LINE_ITEMS_QUERY, type AdminGraphQL, type RequestBudget } from "./overview-analytics-graphql.server";
import { computeShopLocalDateWindow } from "./overview-analytics.shared";

const ORDERS_PER_PAGE = 25;
const ORDER_LINES_PER_PAGE = 10;
const CONTINUATION_PAGE_SIZE = 100;
const MAX_ORDER_PAGES = 40;
const MAX_LINE_ITEM_PAGES = 100;
const MAX_LINE_ITEM_CONTINUATION_REQUESTS = 100;
const MAX_ORDERS = ORDERS_PER_PAGE * MAX_ORDER_PAGES;
const MAX_ORDER_LINE_ITEMS = ORDER_LINES_PER_PAGE + (MAX_LINE_ITEM_PAGES - 1) * CONTINUATION_PAGE_SIZE;
function salesSearch(startUtc: string, endExclusiveUtc: string) {
  return `created_at:>=${startUtc} created_at:<${endExclusiveUtc}`;
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
