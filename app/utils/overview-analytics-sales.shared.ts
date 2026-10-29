import type { SalesAggregation, SalesAggregationOptions, SalesOrder, SalesRankingProduct, SalesRankingVariant } from "./overview-analytics.types";
import { datePartsInZone } from "./overview-analytics-dates.shared";

function lineItemsForOrder(order: SalesOrder) {
  if (Array.isArray(order.lineItems)) return { lines: order.lineItems, hasMore: false, complete: true };
  if (order.lineItems && typeof order.lineItems === "object") {
    const connection = order.lineItems;
    const lines = Array.isArray(connection.nodes) ? connection.nodes : [];
    const hasNodes = Array.isArray(connection.nodes);
    const hasPageInfo = typeof connection.pageInfo?.hasNextPage === "boolean";
    const hasMore = connection.pageInfo?.hasNextPage === true;
    return {
      lines,
      hasMore,
      complete: hasNodes && hasPageInfo && !hasMore,
    };
  }
  return { lines: [], hasMore: false, complete: false };
}

function resourceId(value: string | number | null | undefined) {
  return value == null ? undefined : String(value);
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

/**
 * Aggregates non-cancelled, non-test orders. Shopify currentQuantity and
 * priceAfterAllDiscountsBeforeTaxesSet already reflect returns/refunds and
 * exclude tax; missing test flags make the result partial rather than trusting
 * development transactions as merchant sales.
 */
export function aggregateSalesOrders(
  orders: SalesOrder[],
  options: SalesAggregationOptions,
): SalesAggregation {
  const dates = [...options.dates];
  const dateSet = new Set(dates);
  const daily = new Map(dates.map((date) => [date, { revenue: 0, orders: 0, units: 0 }]));
  const seenOrders = new Set<string>();
  const seenLines = new Set<string>();
  const products = new Map<string, SalesRankingProduct>();
  const variants = new Map<string, SalesRankingVariant>();
  let orderCount = 0;
  let unitCount = 0;
  let revenueTotal = 0;
  let currencyMismatch = false;
  let revenueIncomplete = false;
  let partial = options.partial === true;
  let demandComplete = options.partial !== true;
  let missingTestFlag = false;

  for (const order of orders) {
    if (typeof order.id !== "string" || !order.id) {
      partial = true;
      demandComplete = false;
      continue;
    }
    if (seenOrders.has(order.id)) continue;
    seenOrders.add(order.id);
    if (order.cancelledAt) continue;
    const createdAt = order.createdAt ? new Date(order.createdAt) : null;
    if (!createdAt || !Number.isFinite(createdAt.getTime())) {
      partial = true;
      demandComplete = false;
      continue;
    }
    const date = datePartsInZone(createdAt, options.timeZone);
    if (!dateSet.has(date)) continue;
    if (typeof order.test !== "boolean") {
      partial = true;
      missingTestFlag = true;
      demandComplete = false;
      continue;
    }
    if (order.test) continue;
    const day = daily.get(date)!;
    orderCount += 1;
    day.orders += 1;

    const { lines, hasMore, complete } = lineItemsForOrder(order);
    if (!complete) demandComplete = false;
    if (hasMore) { partial = true; demandComplete = false; }
    const perOrderSeen = new Set<string>();
    for (const line of lines) {
      if (typeof line.id !== "string" || !line.id) {
        partial = true;
        demandComplete = false;
        continue;
      }
      if (perOrderSeen.has(line.id)) continue;
      perOrderSeen.add(line.id);
      const lineKey = `${order.id}:${line.id}`;
      if (seenLines.has(lineKey)) continue;
      seenLines.add(lineKey);
      if (typeof line.currentQuantity !== "number" || !Number.isFinite(line.currentQuantity) || line.currentQuantity < 0) {
        partial = true;
        demandComplete = false;
        continue;
      }
      const units = line.currentQuantity;
      unitCount += units;
      day.units += units;

      const money = line.priceAfterAllDiscountsBeforeTaxesSet?.shopMoney;
      const amount = money?.amount;
      const numericAmount = typeof amount === "number" ? amount : typeof amount === "string" ? Number(amount) : Number.NaN;
      const lineCurrency = money?.currencyCode;
      if (!Number.isFinite(numericAmount) || typeof lineCurrency !== "string" || !lineCurrency) {
        revenueIncomplete = true;
        partial = true;
      } else if (lineCurrency !== options.currencyCode) {
        currencyMismatch = true;
        partial = true;
      } else {
        revenueTotal += numericAmount;
        day.revenue += numericAmount;
      }

      const product = line.product;
      if (product?.id && product.title) {
        const existing = products.get(product.id) ?? {
          id: product.id,
          title: product.title,
          ...(resourceId(product.legacyResourceId) ? { legacyResourceId: resourceId(product.legacyResourceId) } : {}),
          ...(product.featuredImage?.url ? { imageUrl: product.featuredImage.url } : {}),
          units: 0,
          revenue: 0,
        };
        existing.units += units;
        if (Number.isFinite(numericAmount) && lineCurrency === options.currencyCode) existing.revenue = (existing.revenue ?? 0) + numericAmount;
        products.set(product.id, existing);

        const variant = line.variant;
        if (variant?.id && variant.title) {
          const existingVariant = variants.get(variant.id) ?? {
            id: variant.id,
            productId: product.id,
            productTitle: product.title,
            ...(resourceId(variant.legacyResourceId) ? { legacyResourceId: resourceId(variant.legacyResourceId) } : {}),
            title: variant.title,
            ...(variant.sku ? { sku: variant.sku } : {}),
            units: 0,
            revenue: 0,
          };
          existingVariant.units += units;
          if (Number.isFinite(numericAmount) && lineCurrency === options.currencyCode) existingVariant.revenue = (existingVariant.revenue ?? 0) + numericAmount;
          variants.set(variant.id, existingVariant);
        } else {
          demandComplete = false;
        }
      } else {
        demandComplete = false;
      }
    }
  }

  const revenueAvailable = !currencyMismatch && !revenueIncomplete;
  const rank = <T extends { units: number; title: string; id: string }>(items: T[]) => items
    .sort((left, right) => right.units - left.units || left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
    .slice(0, 5);
  const topProducts = rank([...products.values()].filter((item) => item.units > 0)).map((item) => ({
    ...item,
    revenue: revenueAvailable ? roundMoney(item.revenue ?? 0) : null,
  }));
  const topVariants = rank([...variants.values()].filter((item) => item.units > 0)).map((item) => ({
    ...item,
    revenue: revenueAvailable ? roundMoney(item.revenue ?? 0) : null,
  }));
  const variantDemand = [...variants.values()]
    .filter((item) => item.units > 0)
    .map(({ id, units, productId, productTitle, title, sku }) => options.includeVariantDetails
      ? { id, units, productId, productTitle, title, ...(sku ? { sku } : {}) }
      : { id, units });

  return {
    status: partial ? "partial" : "ready",
    demandComplete,
    ...(currencyMismatch ? { reason: "Revenue is unavailable because Shopify returned mixed shop currencies; order and unit counts remain available without conversion." }
      : revenueIncomplete ? { reason: "Revenue is unavailable because Shopify returned incomplete line-item price data." }
        : missingTestFlag ? { reason: "Some orders lacked Shopify's test-order flag and were excluded from sales totals." }
          : partial ? { reason: "Some Shopify order or line-item pages could not be fully read; displayed totals are partial." } : {}),
    currencyCode: options.currencyCode || null,
    totals: {
      revenue: revenueAvailable ? roundMoney(revenueTotal) : null,
      orders: orderCount,
      units: unitCount,
    },
    daily: dates.map((date) => {
      const value = daily.get(date)!;
      return {
        date,
        revenue: revenueAvailable ? roundMoney(value.revenue) : null,
        orders: value.orders,
        units: value.units,
      };
    }),
    topProducts,
    topVariants,
    variantDemand,
    currencyMismatch,
  };
}
