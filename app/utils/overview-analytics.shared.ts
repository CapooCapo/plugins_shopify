export type SalesOrderLine = {
  id?: string | null;
  currentQuantity?: number | null;
  priceAfterAllDiscountsBeforeTaxesSet?: {
    shopMoney?: { amount?: string | number | null; currencyCode?: string | null } | null;
  } | null;
  product?: {
    id?: string | null;
    title?: string | null;
    legacyResourceId?: string | number | null;
    featuredImage?: { url?: string | null } | null;
  } | null;
  variant?: {
    id?: string | null;
    title?: string | null;
    sku?: string | null;
    legacyResourceId?: string | number | null;
  } | null;
};

export type SalesOrder = {
  id?: string | null;
  createdAt?: string | null;
  cancelledAt?: string | null;
  /** Shopify's test flag is required to distinguish development transactions from sales. */
  test?: boolean | null;
  lineItems?: SalesOrderLine[] | { nodes?: SalesOrderLine[]; pageInfo?: { hasNextPage?: boolean } } | null;
};

export type SalesAggregationOptions = {
  currencyCode: string;
  timeZone: string;
  dates: string[];
  /** True when the API adapter could not retrieve all pages. */
  partial?: boolean;
};

export type SalesRankingProduct = {
  id: string;
  title: string;
  legacyResourceId?: string;
  imageUrl?: string;
  units: number;
  revenue: number | null;
};

export type SalesRankingVariant = {
  id: string;
  productId: string;
  productTitle: string;
  legacyResourceId?: string;
  title: string;
  sku?: string;
  units: number;
  revenue: number | null;
};

export type SalesAggregation = {
  status: "ready" | "partial" | "unavailable";
  reason?: string;
  currencyCode: string | null;
  totals: { revenue: number | null; orders: number; units: number };
  daily: Array<{ date: string; revenue: number | null; orders: number; units: number }>;
  topProducts: SalesRankingProduct[];
  topVariants: SalesRankingVariant[];
  currencyMismatch: boolean;
};

export type InventoryVariantInput = {
  id: string;
  title: string;
  sku?: string | null;
  product: {
    id: string;
    title: string;
    legacyResourceId?: string | number | null;
    imageUrl?: string | null;
  };
  tracked: boolean | null;
  levels: Array<{ isActive: boolean; available: number | null }>;
  /** False when a location-level page could not be completed. */
  levelsComplete?: boolean;
};

export type InventoryAggregationOptions = {
  lowStockThreshold?: number;
  partial?: boolean;
};

export type InventoryVariantSummary = {
  id: string;
  title: string;
  sku: string | null;
  product: { id: string; title: string; legacyResourceId?: string; imageUrl?: string };
  available: number;
  variantCount?: number;
};

export type InventoryAggregation = {
  status: "ready" | "partial" | "unavailable";
  reason?: string;
  threshold: number;
  lowStockSkuCount: number;
  outOfStockSkuCount: number;
  lowStockVariants: InventoryVariantSummary[];
  outOfStockVariants: InventoryVariantSummary[];
  unknownCount: number;
  untrackedCount: number;
  totalTrackedKnown: number;
};

function datePartsInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  if (!values.year || !values.month || !values.day) {
    throw new Error("Could not read the shop-local calendar date.");
  }
  return `${values.year}-${values.month}-${values.day}`;
}

function addCalendarDays(date: string, amount: number) {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + amount));
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, "0")}-${String(result.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Finds the first UTC millisecond belonging to a shop-local calendar date. A
 * lower-bound search handles 23/25-hour DST days and zones that shift at midnight.
 */
function localDateStartUtc(date: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const estimate = Date.UTC(year, month - 1, day);
  let low = estimate - 48 * 60 * 60 * 1000;
  let high = estimate + 48 * 60 * 60 * 1000;

  if (datePartsInZone(new Date(low), timeZone) >= date || datePartsInZone(new Date(high), timeZone) < date) {
    throw new Error("Could not resolve the shop-local day boundary.");
  }

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (datePartsInZone(new Date(middle), timeZone) >= date) high = middle;
    else low = middle;
  }
  return new Date(high).toISOString();
}

/** A half-open UTC range for the last N shop-local calendar days, including today. */
export function computeShopLocalDateWindow(
  now: Date | string,
  dayCount: 7 | 30,
  timeZone: string,
): { startUtc: string; endExclusiveUtc: string; dates: string[] } {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error("A valid current time is required.");
  if (dayCount !== 7 && dayCount !== 30) throw new Error("The date range must be 7 or 30 days.");

  const today = datePartsInZone(instant, timeZone);
  const dates = Array.from({ length: dayCount }, (_, index) => addCalendarDays(today, index - dayCount + 1));
  return {
    startUtc: localDateStartUtc(dates[0], timeZone),
    endExclusiveUtc: localDateStartUtc(addCalendarDays(today, 1), timeZone),
    dates,
  };
}

function lineItemsForOrder(order: SalesOrder) {
  if (Array.isArray(order.lineItems)) return { lines: order.lineItems, hasMore: false };
  if (order.lineItems && typeof order.lineItems === "object") {
    const connection = order.lineItems;
    return {
      lines: Array.isArray(connection.nodes) ? connection.nodes : [],
      hasMore: connection.pageInfo?.hasNextPage === true,
    };
  }
  return { lines: [], hasMore: false };
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
  let missingTestFlag = false;

  for (const order of orders) {
    if (typeof order.id !== "string" || !order.id) {
      partial = true;
      continue;
    }
    if (seenOrders.has(order.id)) continue;
    seenOrders.add(order.id);
    if (order.cancelledAt) continue;
    const createdAt = order.createdAt ? new Date(order.createdAt) : null;
    if (!createdAt || !Number.isFinite(createdAt.getTime())) {
      partial = true;
      continue;
    }
    const date = datePartsInZone(createdAt, options.timeZone);
    if (!dateSet.has(date)) continue;
    if (typeof order.test !== "boolean") {
      partial = true;
      missingTestFlag = true;
      continue;
    }
    if (order.test) continue;
    const day = daily.get(date)!;
    orderCount += 1;
    day.orders += 1;

    const { lines, hasMore } = lineItemsForOrder(order);
    if (hasMore) partial = true;
    const perOrderSeen = new Set<string>();
    for (const line of lines) {
      if (typeof line.id !== "string" || !line.id) {
        partial = true;
        continue;
      }
      if (perOrderSeen.has(line.id)) continue;
      perOrderSeen.add(line.id);
      const lineKey = `${order.id}:${line.id}`;
      if (seenLines.has(lineKey)) continue;
      seenLines.add(lineKey);
      if (typeof line.currentQuantity !== "number" || !Number.isFinite(line.currentQuantity) || line.currentQuantity < 0) {
        partial = true;
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
        }
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

  return {
    status: partial ? "partial" : "ready",
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
    currencyMismatch,
  };
}

/**
 * Inventory available is summed only for known active locations. Missing,
 * untracked, or incomplete levels stay unknown and never become zero stock.
 * Duplicate nonempty SKUs are summed across their variants; if any member is
 * unknown or untracked, that SKU is excluded from low/out-of-stock totals.
 */
export function aggregateInventoryVariants(
  variants: InventoryVariantInput[],
  options: InventoryAggregationOptions = {},
): InventoryAggregation {
  const threshold = options.lowStockThreshold ?? 5;
  const lowStockVariants: InventoryVariantSummary[] = [];
  const outOfStockVariants: InventoryVariantSummary[] = [];
  let unknownCount = 0;
  let untrackedCount = 0;
  let totalTrackedKnown = 0;
  const skuAvailability = new Map<string, { available: number; unknown: boolean }>();
  const knownVariantsBySku = new Map<string, InventoryVariantSummary[]>();

  for (const variant of variants) {
    const sku = variant.sku?.trim();
    if (variant.tracked === false) {
      untrackedCount += 1;
      if (sku) {
        const current = skuAvailability.get(sku) ?? { available: 0, unknown: false };
        current.unknown = true;
        skuAvailability.set(sku, current);
      }
      continue;
    }
    if (variant.tracked !== true || variant.levelsComplete === false) {
      unknownCount += 1;
      if (sku) {
        const current = skuAvailability.get(sku) ?? { available: 0, unknown: false };
        current.unknown = true;
        skuAvailability.set(sku, current);
      }
      continue;
    }
    const activeLevels = variant.levels.filter((level) => level.isActive);
    if (!activeLevels.length || activeLevels.some((level) => !Number.isFinite(level.available))) {
      unknownCount += 1;
      if (sku) {
        const current = skuAvailability.get(sku) ?? { available: 0, unknown: false };
        current.unknown = true;
        skuAvailability.set(sku, current);
      }
      continue;
    }
    const available = activeLevels.reduce((total, level) => total + (level.available as number), 0);
    totalTrackedKnown += available;
    if (sku) {
      const current = skuAvailability.get(sku) ?? { available: 0, unknown: false };
      current.available += available;
      skuAvailability.set(sku, current);
    }
    const summary: InventoryVariantSummary = {
      id: variant.id,
      title: variant.title,
      sku: variant.sku ?? null,
      product: {
        id: variant.product.id,
        title: variant.product.title,
        ...(resourceId(variant.product.legacyResourceId) ? { legacyResourceId: resourceId(variant.product.legacyResourceId) } : {}),
        ...(variant.product.imageUrl ? { imageUrl: variant.product.imageUrl } : {}),
      },
      available,
    };
    if (sku) {
      knownVariantsBySku.set(sku, [...(knownVariantsBySku.get(sku) ?? []), summary]);
    } else if (available <= 0) {
      outOfStockVariants.push(summary);
    } else if (available <= threshold) {
      lowStockVariants.push(summary);
    }
  }

  for (const [sku, availability] of skuAvailability) {
    if (availability.unknown) continue;
    const members = knownVariantsBySku.get(sku) ?? [];
    const first = members[0];
    if (!first) continue;
    const summary: InventoryVariantSummary = {
      ...first,
      available: availability.available,
      ...(members.length > 1 ? { variantCount: members.length } : {}),
    };
    if (availability.available <= 0) outOfStockVariants.push(summary);
    else if (availability.available <= threshold) lowStockVariants.push(summary);
  }

  const sortVariants = (left: InventoryVariantSummary, right: InventoryVariantSummary) =>
    left.available - right.available || left.product.title.localeCompare(right.product.title) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  lowStockVariants.sort(sortVariants);
  outOfStockVariants.sort(sortVariants);
  const partial = options.partial === true || unknownCount > 0 || untrackedCount > 0;
  const knownSkuGroups = [...skuAvailability.values()].filter((sku) => !sku.unknown);

  return {
    status: partial ? "partial" : "ready",
    ...(partial ? { reason: "Some inventory is unknown, untracked, or could not be fully read; totals include only variants with complete active-location availability." } : {}),
    threshold,
    lowStockSkuCount: knownSkuGroups.filter((sku) => sku.available > 0 && sku.available <= threshold).length,
    outOfStockSkuCount: knownSkuGroups.filter((sku) => sku.available <= 0).length,
    lowStockVariants,
    outOfStockVariants,
    unknownCount,
    untrackedCount,
    totalTrackedKnown,
  };
}
