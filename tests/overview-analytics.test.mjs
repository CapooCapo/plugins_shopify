/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: "custom",
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [], entries: [] },
  logLevel: "error",
});
test.after(async () => vite.close());

async function loadAnalyticsHelpers() {
  const helpers = await vite.ssrLoadModule("/app/utils/overview-analytics.shared.ts");
  for (const name of ["computeShopLocalDateWindow", "aggregateSalesOrders", "aggregateInventoryVariants"]) {
    assert.equal(typeof helpers[name], "function", `${name} must be exported from the shared analytics module`);
  }
  return helpers;
}

async function loadSampleAnalyticsHelpers() {
  const helpers = await vite.ssrLoadModule("/app/utils/overview-analytics-demo.ts");
  assert.equal(typeof helpers.createSampleSalesSection, "function",
    "createSampleSalesSection must be exported from the sample analytics module");
  return helpers;
}

test("sales windows use shop-local calendar days, include today, and return UTC half-open boundaries across DST", async () => {
  const { computeShopLocalDateWindow } = await loadAnalyticsHelpers();

  const springForward = computeShopLocalDateWindow("2026-03-09T16:00:00.000Z", 7, "America/New_York");
  assert.deepEqual(springForward.dates, [
    "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09",
  ]);
  assert.equal(springForward.startUtc, "2026-03-03T05:00:00.000Z");
  assert.equal(springForward.endExclusiveUtc, "2026-03-10T04:00:00.000Z");
  assert.equal(Date.parse(springForward.endExclusiveUtc) - Date.parse(springForward.startUtc), 167 * 60 * 60 * 1000,
    "seven local calendar days crossing spring-forward span 167 UTC hours");

  const fallBack = computeShopLocalDateWindow("2025-11-02T17:00:00.000Z", 7, "America/New_York");
  assert.deepEqual(fallBack.dates, [
    "2025-10-27", "2025-10-28", "2025-10-29", "2025-10-30", "2025-10-31", "2025-11-01", "2025-11-02",
  ]);
  assert.equal(fallBack.startUtc, "2025-10-27T04:00:00.000Z");
  assert.equal(fallBack.endExclusiveUtc, "2025-11-03T05:00:00.000Z");
  assert.equal(Date.parse(fallBack.endExclusiveUtc) - Date.parse(fallBack.startUtc), 169 * 60 * 60 * 1000,
    "seven local calendar days crossing fall-back span 169 UTC hours");

  const thirtyDays = computeShopLocalDateWindow(new Date("2026-10-28T12:00:00.000Z"), 30, "Asia/Ho_Chi_Minh");
  assert.equal(thirtyDays.dates.length, 30);
  assert.equal(thirtyDays.dates[0], "2026-09-29");
  assert.equal(thirtyDays.dates.at(-1), "2026-10-28", "the selected local day includes today");
  assert.equal(thirtyDays.startUtc, "2026-09-28T17:00:00.000Z");
  assert.equal(thirtyDays.endExclusiveUtc, "2026-10-28T17:00:00.000Z");
});

test("sample daily sales metrics are stable across overlapping 7-day and 30-day shop-local windows", async () => {
  const { createSampleSalesSection } = await loadSampleAnalyticsHelpers();
  const timeZone = "Asia/Ho_Chi_Minh";
  const now = new Date("2026-10-28T16:30:00.000Z");
  const sevenDayDaily = createSampleSalesSection(7, timeZone, now).data.daily;
  const thirtyDayDaily = createSampleSalesSection(30, timeZone, now).data.daily;
  const thirtyDayByDate = new Map(thirtyDayDaily.map((day) => [day.date, day]));
  const overlappingDays = sevenDayDaily.filter(({ date }) => thirtyDayByDate.has(date));

  assert.equal(overlappingDays.length, sevenDayDaily.length,
    "the 30-day window must contain every shop-local date in the 7-day window");
  for (const { date, revenue, orders, units } of overlappingDays) {
    const thirtyDayEntry = thirtyDayByDate.get(date);
    assert.deepEqual(
      { revenue, orders, units },
      { revenue: thirtyDayEntry.revenue, orders: thirtyDayEntry.orders, units: thirtyDayEntry.units },
      `sample daily metrics must match for the overlapping shop-local date ${date}`,
    );
  }
});

const money = (amount, currencyCode = "USD") => ({ shopMoney: { amount: String(amount), currencyCode } });
const product = (id, title, legacyResourceId, url = `https://cdn.example.test/${id}.jpg`) => ({
  id,
  title,
  legacyResourceId,
  featuredImage: { url, altText: `${title} product image` },
});
const variant = (id, productId, productTitle, title, sku, legacyResourceId) => ({
  id,
  productId,
  productTitle,
  title,
  sku,
  legacyResourceId,
});
const lineItem = ({ id, currentQuantity, amount, currencyCode = "USD", itemProduct = null, itemVariant = null }) => ({
  id,
  currentQuantity,
  priceAfterAllDiscountsBeforeTaxesSet: money(amount, currencyCode),
  product: itemProduct,
  variant: itemVariant,
});
const order = ({ id, createdAt, cancelledAt = null, lineItems = [], test = false, ...extra }) => ({
  id,
  createdAt,
  cancelledAt,
  lineItems,
  test,
  ...extra,
});

test("sales aggregation deduplicates orders, excludes cancelled/out-of-window orders, and uses net line values", async () => {
  const { aggregateSalesOrders } = await loadAnalyticsHelpers();
  const alpha = product("gid://shopify/Product/1", "Alpha", "1");
  const beta = product("gid://shopify/Product/2", "Beta", "2");
  const alphaSmall = variant("gid://shopify/ProductVariant/11", alpha.id, alpha.title, "Small", "ALPHA-S", "11");
  const alphaLarge = variant("gid://shopify/ProductVariant/12", alpha.id, alpha.title, "Large", "ALPHA-L", "12");
  const betaDefault = variant("gid://shopify/ProductVariant/21", beta.id, beta.title, "Default", "BETA-1", "21");
  const includedAtLocalStart = order({
    id: "gid://shopify/Order/100",
    createdAt: "2026-10-27T17:00:00.000Z", // 2026-10-28 00:00 in Asia/Ho_Chi_Minh, inclusive.
    lineItems: [
      lineItem({ id: "li-1", currentQuantity: 3, amount: 30, itemProduct: alpha, itemVariant: alphaSmall }),
      lineItem({ id: "li-2", currentQuantity: 2, amount: 20, itemProduct: alpha, itemVariant: alphaLarge }),
      lineItem({ id: "li-3", currentQuantity: 4, amount: 40, itemProduct: beta, itemVariant: betaDefault }),
      lineItem({ id: "li-4", currentQuantity: 1, amount: 5 }), // Aggregate only; no product/variant identity.
    ],
    customer: { id: "gid://shopify/Customer/secret", email: "private@example.test", phone: "+10000000000" },
  });
  const includedAtLocalEnd = order({
    id: "gid://shopify/Order/101",
    createdAt: "2026-10-28T16:59:59.999Z", // Last millisecond of the selected local day.
    lineItems: [lineItem({ id: "li-5", currentQuantity: 2, amount: 20, itemProduct: beta, itemVariant: betaDefault })],
  });
  const emptyOrder = order({ id: "gid://shopify/Order/102", createdAt: "2026-10-28T12:00:00.000Z" });
  const cancelled = order({
    id: "gid://shopify/Order/103",
    createdAt: "2026-10-28T12:00:00.000Z",
    cancelledAt: "2026-10-28T13:00:00.000Z",
    lineItems: [lineItem({ id: "li-cancelled", currentQuantity: 100, amount: 1000, itemProduct: alpha, itemVariant: alphaSmall })],
  });
  const beforeLocalStart = order({
    id: "gid://shopify/Order/104",
    createdAt: "2026-10-27T16:59:59.999Z", // Still the prior local date.
    lineItems: [lineItem({ id: "li-outside", currentQuantity: 50, amount: 500, itemProduct: beta, itemVariant: betaDefault })],
  });
  const atNextLocalDay = order({
    id: "gid://shopify/Order/105",
    createdAt: "2026-10-28T17:00:00.000Z", // Exclusive end: 2026-10-29 00:00 local.
    lineItems: [lineItem({ id: "li-next-day", currentQuantity: 70, amount: 700, itemProduct: beta, itemVariant: betaDefault })],
  });

  const result = aggregateSalesOrders(
    [includedAtLocalStart, includedAtLocalEnd, emptyOrder, cancelled, beforeLocalStart, atNextLocalDay, includedAtLocalStart],
    { currencyCode: "USD", timeZone: "Asia/Ho_Chi_Minh", dates: ["2026-10-28"] },
  );

  assert.equal(result.status, "ready");
  assert.equal(result.currencyMismatch, false);
  assert.equal(result.currencyCode, "USD");
  assert.deepEqual(result.totals, { revenue: 115, orders: 3, units: 12 });
  assert.deepEqual(result.daily, [{ date: "2026-10-28", revenue: 115, orders: 3, units: 12 }]);
  assert.deepEqual(result.topProducts.map(({ id, units, revenue }) => ({ id, units, revenue })), [
    { id: beta.id, units: 6, revenue: 60 },
    { id: alpha.id, units: 5, revenue: 50 },
  ], "ranking sums net currentQuantity and discounted line amounts across variants");
  assert.deepEqual(result.topVariants.map(({ id, units, revenue }) => ({ id, units, revenue })), [
    { id: betaDefault.id, units: 6, revenue: 60 },
    { id: alphaSmall.id, units: 3, revenue: 30 },
    { id: alphaLarge.id, units: 2, revenue: 20 },
  ]);
  assert.ok(result.topProducts.every(({ id }) => [alpha.id, beta.id].includes(id)),
    "a line with no product identity contributes to aggregate totals but not top-product ranking");
  assert.equal(result.topProducts[0].imageUrl, beta.featuredImage.url);
  assert.equal(result.topProducts[0].legacyResourceId, beta.legacyResourceId);
  assert.equal(result.topVariants[0].sku, betaDefault.sku);

  const serialized = JSON.stringify(result);
  for (const privateValue of ["gid://shopify/Customer/secret", "private@example.test", "+10000000000"]) {
    assert.doesNotMatch(serialized, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "analytics output must not expose customer PII from an unexpected order field");
  }
  const outputKeys = [...serialized.matchAll(/"([^"]+)"\s*:/g)].map(([, key]) => key);
  assert.deepEqual(outputKeys.filter((key) => /customer|email|phone|address/i.test(key)), [],
    "analytics results contain no customer-identifying fields");
});

test("sales aggregation emits zero-filled shop-local daily buckets and marks mixed-currency revenue unavailable", async () => {
  const { aggregateSalesOrders } = await loadAnalyticsHelpers();
  const alpha = product("gid://shopify/Product/9", "Currency test", "9");
  const alphaVariant = variant("gid://shopify/ProductVariant/99", alpha.id, alpha.title, "Default", "FX-1", "99");
  const result = aggregateSalesOrders([
    order({ id: "one", createdAt: "2026-10-27T18:00:00.000Z", lineItems: [lineItem({ id: "usd", currentQuantity: 2, amount: 18.5, itemProduct: alpha, itemVariant: alphaVariant })] }),
    order({ id: "two", createdAt: "2026-10-28T00:00:00.000Z", lineItems: [lineItem({ id: "cad", currentQuantity: 1, amount: 9, currencyCode: "CAD", itemProduct: alpha, itemVariant: alphaVariant })] }),
  ], { currencyCode: "USD", timeZone: "UTC", dates: ["2026-10-27", "2026-10-28", "2026-10-29"] });

  assert.equal(result.status, "partial", "orders and unit counts remain available when revenue currency is mixed");
  assert.equal(result.currencyMismatch, true);
  assert.equal(typeof result.reason, "string");
  assert.deepEqual(result.totals, { revenue: null, orders: 2, units: 3 },
    "currency mismatch must not silently convert revenue or discard non-monetary totals");
  assert.deepEqual(result.daily, [
    { date: "2026-10-27", revenue: null, orders: 1, units: 2 },
    { date: "2026-10-28", revenue: null, orders: 1, units: 1 },
    { date: "2026-10-29", revenue: null, orders: 0, units: 0 },
  ]);
  assert.ok(result.topProducts.every(({ revenue }) => revenue === null));
  assert.ok(result.topVariants.every(({ revenue }) => revenue === null));
});

test("sales aggregation excludes test orders and treats a missing test flag as incomplete rather than live sales", async () => {
  const { aggregateSalesOrders } = await loadAnalyticsHelpers();
  const salesProduct = product("gid://shopify/Product/20", "Live sale", "20");
  const salesVariant = variant("gid://shopify/ProductVariant/200", salesProduct.id, salesProduct.title, "Default", "LIVE-20", "200");
  const testProduct = product("gid://shopify/Product/21", "Test sale", "21");
  const testVariant = variant("gid://shopify/ProductVariant/210", testProduct.id, testProduct.title, "Default", "TEST-21", "210");
  const liveOrder = order({
    id: "live-order",
    createdAt: "2026-10-28T12:00:00.000Z",
    lineItems: [lineItem({ id: "live-line", currentQuantity: 2, amount: 24, itemProduct: salesProduct, itemVariant: salesVariant })],
  });
  const testOrder = order({
    id: "test-order",
    createdAt: "2026-10-28T13:00:00.000Z",
    test: true,
    lineItems: [lineItem({ id: "test-line", currentQuantity: 50, amount: 500, itemProduct: testProduct, itemVariant: testVariant })],
  });
  const incompleteOrder = order({
    id: "missing-test-flag-order",
    createdAt: "2026-10-28T14:00:00.000Z",
    lineItems: [lineItem({ id: "unknown-line", currentQuantity: 70, amount: 700, itemProduct: testProduct, itemVariant: testVariant })],
  });
  delete incompleteOrder.test;

  const result = aggregateSalesOrders([liveOrder, testOrder, incompleteOrder], {
    currencyCode: "USD", timeZone: "UTC", dates: ["2026-10-28"],
  });

  assert.equal(result.status, "partial", "an order without Shopify's test flag makes the aggregate incomplete");
  assert.deepEqual(result.totals, { revenue: 24, orders: 1, units: 2 },
    "test and unknown-test-flag orders are excluded from all aggregate totals");
  assert.deepEqual(result.daily, [{ date: "2026-10-28", revenue: 24, orders: 1, units: 2 }]);
  assert.deepEqual(result.topProducts.map(({ id }) => id), [salesProduct.id],
    "test or unknown-test-flag products do not enter top-product rankings");
  assert.deepEqual(result.topVariants.map(({ id }) => id), [salesVariant.id],
    "test or unknown-test-flag variants do not enter top-variant rankings");
});

test("inventory aggregation sums active locations, applies the low-stock boundary, and keeps unknown distinct from zero", async () => {
  const { aggregateInventoryVariants } = await loadAnalyticsHelpers();
  const inventoryProduct = { id: "gid://shopify/Product/500", title: "Inventory product", legacyResourceId: "500", imageUrl: null };
  const variantRow = (id, sku, tracked, levels) => ({ id, title: sku, sku, product: inventoryProduct, tracked, levels });
  const variants = [
    variantRow("low-2", "LOW-2", true, [
      { isActive: true, available: 2 },
      { isActive: true, available: 0 },
      { isActive: false, available: 900 },
    ]),
    variantRow("low-5", "LOW-5", true, [
      { isActive: true, available: 2 },
      { isActive: true, available: 3 },
    ]),
    variantRow("out-0", "OUT-0", true, [
      { isActive: true, available: 0 },
      { isActive: true, available: 0 },
    ]),
    variantRow("normal-6", "NORMAL-6", true, [
      { isActive: true, available: 6 },
      { isActive: false, available: 700 },
    ]),
    variantRow("unknown-null", "UNKNOWN-NULL", true, [{ isActive: true, available: null }]),
    variantRow("unknown-level", "UNKNOWN-LEVEL", true, []),
    variantRow("untracked", "UNTRACKED", false, [{ isActive: true, available: 1 }]),
    variantRow("tracking-unknown", "TRACKING-UNKNOWN", null, [{ isActive: true, available: 0 }]),
  ];

  const result = aggregateInventoryVariants(variants, { lowStockThreshold: 5 });
  const lowIds = result.lowStockVariants.map(({ id }) => id);
  const outIds = result.outOfStockVariants.map(({ id }) => id);

  assert.equal(typeof result.status, "string", "inventory aggregation reports its data availability state");
  assert.ok(lowIds.includes("low-2"), "active-location availability of 2 is low stock");
  assert.ok(lowIds.includes("low-5"), "the configured threshold is inclusive at 5 across active locations");
  assert.ok(outIds.includes("out-0"), "known zero availability is out of stock");
  assert.equal(result.lowStockSkuCount, lowIds.length);
  assert.equal(result.outOfStockSkuCount, outIds.length);
  assert.equal(result.unknownCount, 3, "null availability, missing levels, and unknown tracking stay unknown");
  assert.equal(result.untrackedCount, 1, "untracked inventory is reported separately from unknown tracked levels");
  assert.equal(result.totalTrackedKnown, 13, "known tracked total sums only active-location available values");
  for (const unknownId of ["unknown-null", "unknown-level", "tracking-unknown", "untracked"]) {
    assert.equal(lowIds.includes(unknownId), false, `${unknownId} is not silently treated as low/zero inventory`);
    assert.equal(outIds.includes(unknownId), false, `${unknownId} is not silently treated as out of stock`);
  }
  assert.equal(lowIds.includes("normal-6"), false, "availability above the configured threshold is not low stock");
});

test("inventory aggregation classifies duplicate nonempty SKUs by their combined tracked availability", async () => {
  const { aggregateInventoryVariants } = await loadAnalyticsHelpers();
  const inventoryProduct = { id: "gid://shopify/Product/600", title: "Duplicate SKU product", legacyResourceId: "600", imageUrl: null };
  const variantRow = (id, sku, available) => ({
    id,
    title: id,
    sku,
    product: inventoryProduct,
    tracked: true,
    levels: [{ isActive: true, available }],
  });
  const result = aggregateInventoryVariants([
    variantRow("shared-low-a", "SHARED-LOW", 2),
    variantRow("shared-low-b", "SHARED-LOW", 3), // Combined SKU availability is exactly the low-stock threshold.
    variantRow("shared-out-a", "SHARED-OUT", 0),
    variantRow("shared-out-b", "SHARED-OUT", 0),
    variantRow("shared-unknown-known", "SHARED-UNKNOWN", 2),
    variantRow("shared-unknown-null", "SHARED-UNKNOWN", null),
  ], { lowStockThreshold: 5 });

  assert.equal(result.lowStockSkuCount, 1, "a duplicate low SKU is counted once after summing its variants");
  assert.equal(result.outOfStockSkuCount, 1, "a duplicate zero-stock SKU is counted once");
  assert.ok(result.lowStockVariants.some(({ sku }) => sku === "SHARED-LOW"),
    "the combined quantity of 2 + 3 is low stock, not two separate classifications");
  assert.ok(result.outOfStockVariants.some(({ sku }) => sku === "SHARED-OUT"),
    "all known zero quantities for a duplicate SKU remain out of stock");
  assert.equal(result.lowStockVariants.some(({ sku }) => sku === "SHARED-UNKNOWN"), false,
    "a duplicate SKU with any unknown variant is not classified from only the known quantity");
  assert.equal(result.outOfStockVariants.some(({ sku }) => sku === "SHARED-UNKNOWN"), false,
    "unknown duplicate-SKU availability is not treated as zero");
});

test("gift card variants are counted as non-physical and excluded from restock totals", async () => {
  const { aggregateInventoryVariants } = await loadAnalyticsHelpers();
  const result = aggregateInventoryVariants([{
    id: "gift-card-variant",
    title: "Digital gift card",
    sku: "GIFT-25",
    product: { id: "gift-card-product", title: "Digital Gift Card", giftCard: true },
    tracked: true,
    levels: [{ isActive: true, available: 0 }],
  }]);

  assert.equal(result.nonPhysicalCount, 1);
  assert.equal(result.outOfStockSkuCount, 0);
  assert.equal(result.lowStockSkuCount, 0);
  assert.equal(result.totalTrackedKnown, 0);
});
