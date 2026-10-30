import {
  aggregateInventoryVariants,
  computeShopLocalDateWindow,
  type InventoryVariantInput,
  type SalesAggregation,
} from "./overview-analytics.shared";
import type {
  OverviewAnalytics,
  OverviewAnalyticsSection,
} from "./overview-analytics.server";

const DEMO_PATTERN = [2, 4, 1, 5, 3, 6, 2, 4, 3, 1, 5, 2, 6, 3];
const PRODUCT_WEIGHTS = [0.34, 0.28, 0.2, 0.13, 0.05];
const SAMPLE_CURRENCY = "USD";

const PRODUCTS = [
  {
    id: "sample-product-tote",
    title: "Field Canvas Tote",
    variants: [
      { id: "sample-variant-tote-natural", title: "Natural / Small", sku: "DEMO-TOTE-NAT-S", weight: 0.6 },
      { id: "sample-variant-tote-forest", title: "Forest / Medium", sku: "DEMO-TOTE-FOR-M", weight: 0.4 },
    ],
  },
  {
    id: "sample-product-bottle",
    title: "Trail Insulated Bottle",
    variants: [
      { id: "sample-variant-bottle-sage", title: "Sage Green / 24 oz", sku: "DEMO-BOTTLE-SGE", weight: 0.9 },
      { id: "sample-variant-bottle-blue", title: "Midnight Blue / 16 oz", sku: "DEMO-BOTTLE-BLU", weight: 0.1 },
    ],
  },
  {
    id: "sample-product-cap",
    title: "Weekend Cotton Cap",
    variants: [
      { id: "sample-variant-cap-clay", title: "Clay / One size", sku: "DEMO-CAP-CLAY", weight: 1 },
    ],
  },
  {
    id: "sample-product-tee",
    title: "Everyday Cotton Tee",
    variants: [
      { id: "sample-variant-tee-cream", title: "Cream / Small", sku: "DEMO-TEE-CRM-S", weight: 0.55 },
      { id: "sample-variant-tee-ink", title: "Ink / Medium", sku: "DEMO-TEE-INK-M", weight: 0.45 },
    ],
  },
  {
    id: "sample-product-pouch",
    title: "Travel Organizer Pouch",
    variants: [
      { id: "sample-variant-pouch-olive", title: "Olive / Compact", sku: "DEMO-POUCH-OLV", weight: 1 },
    ],
  },
] as const;

function splitTotal(total: number, weights: readonly number[]) {
  let assigned = 0;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return total - assigned;
    const value = Math.floor(total * weight);
    assigned += value;
    return value;
  });
}

function safeTimeZone(timeZone: string | null) {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return "UTC";
  }
}

function dateSeed(date: string) {
  return Array.from(date).reduce((seed, character) => (seed * 31 + character.charCodeAt(0)) >>> 0, 0);
}

function sampleInventoryVariants(): InventoryVariantInput[] {
  const product = (id: string, title: string) => ({ id, title });
  return [
    {
      id: "sample-variant-tote-natural",
      title: "Natural / Small",
      sku: "DEMO-TOTE-NAT-S",
      product: product("sample-product-tote", "Field Canvas Tote"),
      tracked: true,
      levels: [{ isActive: true, available: 18 }],
      levelsComplete: true,
    },
    {
      id: "sample-variant-bottle-sage",
      title: "Sage Green / 24 oz",
      sku: "DEMO-BOTTLE-SGE",
      product: product("sample-product-bottle", "Trail Insulated Bottle"),
      tracked: true,
      levels: [{ isActive: true, available: 3 }],
      levelsComplete: true,
    },
    {
      id: "sample-variant-cap-clay",
      title: "Clay / One size",
      sku: "DEMO-CAP-CLAY",
      product: product("sample-product-cap", "Weekend Cotton Cap"),
      tracked: true,
      levels: [{ isActive: true, available: 0 }],
      levelsComplete: true,
    },
    {
      id: "sample-variant-tee-cream",
      title: "Cream / Small",
      sku: "DEMO-TEE-CRM-S",
      product: product("sample-product-tee", "Everyday Cotton Tee"),
      tracked: true,
      levels: [{ isActive: true, available: 4 }],
      levelsComplete: true,
    },
    {
      id: "sample-variant-tote-forest",
      title: "Forest / Medium",
      sku: "DEMO-TOTE-FOR-M",
      product: product("sample-product-tote", "Field Canvas Tote"),
      tracked: true,
      levels: [{ isActive: true, available: 32 }],
      levelsComplete: true,
    },
    {
      id: "sample-variant-tee-ink",
      title: "Ink / Medium",
      sku: "DEMO-TEE-INK-M",
      product: product("sample-product-tee", "Everyday Cotton Tee"),
      tracked: null,
      levels: [],
      levelsComplete: false,
    },
    {
      id: "sample-variant-pouch-olive",
      title: "Olive / Compact",
      sku: "DEMO-POUCH-OLV",
      product: product("sample-product-pouch", "Travel Organizer Pouch"),
      tracked: false,
      levels: [],
      levelsComplete: true,
    },
    {
      id: "sample-inventory-gift-card",
      title: "Digital gift card",
      sku: "DEMO-GIFT-25",
      product: { id: "sample-product-gift-card", title: "Digital Gift Card", giftCard: true },
      tracked: true,
      levels: [{ isActive: true, available: 0 }],
      levelsComplete: true,
    },
  ];
}

/** Deterministic synthetic sales values for sample previews; never sourced from Shopify. */
export function createSampleSalesSection(
  range: 7 | 30,
  timeZone: string,
  now = new Date(),
): OverviewAnalyticsSection<SalesAggregation> {
  const { dates } = computeShopLocalDateWindow(now, range, timeZone);
  const daily = dates.map((date) => {
    const seed = dateSeed(date);
    const orders = DEMO_PATTERN[seed % DEMO_PATTERN.length];
    const units = orders * 2 + (seed % 3);
    const revenue = units * (22 + (seed % 5) * 4);
    return { date, revenue, orders, units };
  });
  const totals = daily.reduce((result, day) => ({
    revenue: result.revenue + (day.revenue ?? 0),
    orders: result.orders + day.orders,
    units: result.units + day.units,
  }), { revenue: 0, orders: 0, units: 0 });
  const productUnits = splitTotal(totals.units, PRODUCT_WEIGHTS);
  const productRevenue = splitTotal(totals.revenue, PRODUCT_WEIGHTS);
  const topProducts = PRODUCTS.map((product, index) => ({
    id: product.id,
    title: product.title,
    units: productUnits[index],
    revenue: productRevenue[index],
  })).sort((left, right) => right.units - left.units || left.title.localeCompare(right.title));

  const topVariants = PRODUCTS.flatMap((product, productIndex) => {
    const units = splitTotal(productUnits[productIndex], product.variants.map((variant) => variant.weight));
    const revenue = splitTotal(productRevenue[productIndex], product.variants.map((variant) => variant.weight));
    return product.variants.map((variant, variantIndex) => ({
      id: variant.id,
      productId: product.id,
      productTitle: product.title,
      title: variant.title,
      sku: variant.sku,
      units: units[variantIndex],
      revenue: revenue[variantIndex],
    }));
  }).filter((variant) => variant.units > 0)
    .sort((left, right) => right.units - left.units || left.title.localeCompare(right.title));

  return {
    status: "ready",
    data: {
      status: "ready",
      demandComplete: true,
      currencyCode: SAMPLE_CURRENCY,
      totals,
      daily,
      topProducts,
      topVariants,
      variantDemand: topVariants.map(({ id, units }) => ({ id, units })),
      currencyMismatch: false,
    },
    fetchedAt: now.toISOString(),
  };
}

/** A complete fictional Overview snapshot. Calling this performs no Shopify reads. */
export function createSampleOverviewAnalytics(
  range: 7 | 30,
  timeZone: string | null,
  now = new Date(),
): OverviewAnalytics {
  const zone = safeTimeZone(timeZone);
  const sales = createSampleSalesSection(range, zone, now);
  const inventoryData = aggregateInventoryVariants(sampleInventoryVariants(), { lowStockThreshold: 5 });
  const inventory = {
    ...inventoryData,
    // Unknown and untracked are intentional, fully represented demo states.
    status: "ready" as const,
    reason: undefined,
  };
  const fetchedAt = now.toISOString();

  return {
    range,
    timeZone: zone,
    currencyCode: SAMPLE_CURRENCY,
    scopesVerified: false,
    salesMissingScopes: [],
    inventoryMissingScopes: [],
    sales,
    inventory: { status: "ready", data: inventory, fetchedAt },
    fetchedAt,
  };
}
