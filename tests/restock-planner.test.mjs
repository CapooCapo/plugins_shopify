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

const calculate = await vite.ssrLoadModule("/app/utils/restock/restock-calculate.ts");
const settings = await vite.ssrLoadModule("/app/utils/restock/restock-settings.ts");
const fixtures = await vite.ssrLoadModule("/app/utils/restock/restock-fixtures.ts");
const csvExport = await vite.ssrLoadModule("/app/utils/restock/restock-export.shared.ts");
const windows = await vite.ssrLoadModule("/app/utils/overview-analytics-dates.shared.ts");
const service = await vite.ssrLoadModule("/app/utils/restock/restock.server.ts");

const baseRow = (overrides = {}) => ({
  variantId: "gid://shopify/ProductVariant/1",
  productId: "gid://shopify/Product/1",
  productTitle: "Sample Tee",
  variantTitle: "Blue / M",
  sku: "TEE-BLU-M",
  createdAt: "2025-01-01T00:00:00.000Z",
  unitsSold: 42,
  available: 3,
  inventoryStatus: "known",
  ...overrides,
});
const context = (overrides = {}) => ({
  periodStartUtc: "2026-10-01T04:00:00.000Z",
  timeZone: "America/New_York",
  analysisDays: 28,
  settings: { leadTimeDays: 5, coverageDays: 7, safetyBufferDays: 2 },
  salesComplete: true,
  ...overrides,
});

test("Restock windows cover 28 or 56 complete shop-local days including DST-safe UTC boundaries", () => {
  const now = new Date("2026-11-02T17:00:00.000Z");
  const twentyEight = windows.computeCompleteShopLocalDateWindow(now, 28, "America/New_York");
  const fiftySix = windows.computeCompleteShopLocalDateWindow(now, 56, "America/New_York");
  assert.equal(twentyEight.dates.length, 28);
  assert.equal(fiftySix.dates.length, 56);
  assert.equal(twentyEight.dates.at(-1), "2026-11-01");
  assert.equal(twentyEight.endExclusiveUtc, "2026-11-02T05:00:00.000Z");
  assert.equal(fiftySix.dates.at(-1), "2026-11-01");
});

test("calculation follows the documented ceil formula and distinguishes zero, negative and unknown inventory", () => {
  const calculatedRows = calculate.calculateRestockRecommendations([
    baseRow(),
    baseRow({ variantId: "zero", unitsSold: 0, available: 12 }),
    baseRow({ variantId: "negative", unitsSold: 0, available: -2 }),
    baseRow({ variantId: "unknown", inventoryStatus: "unknown", available: null }),
  ], context());
  const byId = new Map(calculatedRows.map((row) => [row.variantId, row]));
  const calculated = byId.get("gid://shopify/ProductVariant/1");
  const zeroSales = byId.get("zero");
  const negative = byId.get("negative");
  const unknown = byId.get("unknown");
  assert.equal(calculated.variantId, "gid://shopify/ProductVariant/1");
  assert.equal(calculated.targetUnits, 21);
  assert.equal(calculated.suggestedQuantity, 18);
  assert.equal(calculated.averageDailyUnits, 1.5);
  assert.equal(zeroSales.targetUnits, 0);
  assert.equal(zeroSales.suggestedQuantity, 0);
  assert.equal(zeroSales.coverageDays, null, "zero sales do not divide by zero");
  assert.equal(negative.suggestedQuantity, 2, "reported negative availability is used explicitly");
  assert.match(negative.explanation, /negative availability is included/);
  assert.equal(unknown.suggestedQuantity, null);
  assert.match(unknown.explanation, /unknown or incomplete/);
});

test("stockout bias, partial sales, insufficient history and absent settings withhold system quantities", () => {
  const reviewedRows = calculate.calculateRestockRecommendations([
    baseRow({ variantId: "stockout", available: 0 }),
    baseRow({ variantId: "partial", unitsSold: 10 }),
    baseRow({ variantId: "new", createdAt: "2026-10-10T00:00:00.000Z" }),
  ], context({ salesComplete: false }));
  const byId = new Map(reviewedRows.map((row) => [row.variantId, row]));
  const stockout = byId.get("stockout");
  const partialSales = byId.get("partial");
  const newVariant = byId.get("new");
  assert.equal(stockout.suggestedQuantity, null);
  assert.ok(stockout.qualityIssues.some((issue) => /stockout bias/i.test(issue)));
  assert.equal(partialSales.suggestedQuantity, null);
  assert.ok(partialSales.qualityIssues.some((issue) => /incomplete/i.test(issue)));
  assert.equal(newVariant.suggestedQuantity, null);
  assert.ok(newVariant.qualityIssues.some((issue) => /insufficient/i.test(issue)));
  const [noSettings] = calculate.calculateRestockRecommendations([baseRow()], context({
    settings: { leadTimeDays: null, coverageDays: null, safetyBufferDays: null },
  }));
  assert.equal(noSettings.status, "settings_required");
  assert.equal(noSettings.suggestedQuantity, null);
  const settingsMissingRows = calculate.calculateRestockRecommendations([
    baseRow({ variantId: "settings-only" }),
    baseRow({ variantId: "settings-and-quality", inventoryStatus: "unknown", available: null }),
  ], context({ settings: { leadTimeDays: null, coverageDays: null, safetyBufferDays: null } }));
  assert.equal(settingsMissingRows.find((row) => row.variantId === "settings-only").status, "settings_required");
  assert.equal(settingsMissingRows.find((row) => row.variantId === "settings-and-quality").status, "needs_review",
    "missing settings must not mask an independent inventory-quality issue");
  assert.equal(calculate.summarizeRestock(settingsMissingRows).manualReviewVariants, 1,
    "manual-review summary counts data-quality rows, not otherwise complete rows that only need planning settings");
  assert.equal(settings.parseOptionalInteger("-1"), Number.NaN);
  assert.equal(settings.parseOptionalInteger("1.5"), Number.NaN);
});

test("demo data covers the required quality cases, uses USD, and runs a complete period", () => {
  const demo = fixtures.createRestockDemo(28, new Date("2026-10-29T12:00:00.000Z"));
  const rows = calculate.calculateRestockRecommendations(demo.rows, {
    periodStartUtc: demo.periodStartUtc,
    timeZone: demo.timeZone,
    analysisDays: demo.analysisDays,
    settings: { leadTimeDays: 5, coverageDays: 14, safetyBufferDays: 3 },
    salesComplete: demo.salesStatus === "ready",
  });
  assert.equal(demo.currencyCode, "USD");
  assert.equal(demo.periodStartDate, "2026-10-01");
  assert.equal(rows.length, 9);
  assert.ok(rows.some((row) => row.status === "calculated" && row.suggestedQuantity > 0), "bestseller with low stock");
  assert.ok(rows.some((row) => row.status === "calculated" && row.suggestedQuantity === 0), "sufficient or excess stock");
  assert.ok(rows.some((row) => row.inventoryStatus === "untracked" && row.suggestedQuantity === null));
  assert.ok(rows.some((row) => row.inventoryStatus === "unknown" && row.suggestedQuantity === null));
  assert.ok(rows.some((row) => row.qualityIssues.some((issue) => /insufficient/i.test(issue))));
  assert.ok(rows.some((row) => row.qualityIssues.some((issue) => /stockout bias/i.test(issue))));
  assert.equal(new Set(demo.rows.filter((row) => row.sku === "DUPLICATE-SKU").map((row) => row.variantId)).size, 2,
    "same-SKU variants remain distinct by Shopify Variant GID");
});

test("CSV prefixes spreadsheet formulas in Shopify text fields while retaining numeric values and manual quantity source", () => {
  const [row] = calculate.calculateRestockRecommendations([baseRow({
    productTitle: '=HYPERLINK("https://example.test","product")',
    variantTitle: "\t=SUM(A1:A2)", sku: "-SKU", available: -2,
    unitsSold: 0,
  })], context());
  row.explanation = "@SUM(A1:A2)";
  const csv = csvExport.buildRestockCsv([row], { [row.variantId]: "5" });
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test"",""product""\)"/);
  assert.ok(csv.includes("\"'\t=SUM(A1:A2)\""), "leading tabs are also forced to text");
  assert.ok(csv.includes("\"'-SKU\""));
  assert.equal(csv.includes("\"@SUM(A1:A2)\""), false, "leading @ formulas are prefixed");
  assert.ok(csv.includes("\"'@SUM(A1:A2)\""));
  assert.match(csv, /,"-2",/,
    "numeric negative availability stays numeric rather than receiving the text escape prefix");
  assert.match(csv, /,"5","Merchant-entered",/);
});

test("current-grant read_orders gate fails closed while inventory and demo remain independently usable", async () => {
  let salesReads = 0;
  let inventoryReads = 0;
  const dependencies = {
    readShop: async () => ({ shop: { name: "Example", ianaTimezone: "UTC", currencyCode: "CAD" } }),
    readSales: async () => { salesReads += 1; throw new Error("Orders must not be read"); },
    readInventory: async () => {
      inventoryReads += 1;
      return {
        status: "ready", threshold: 5, lowStockSkuCount: 0, outOfStockSkuCount: 0,
        lowStockVariants: [], outOfStockVariants: [], unknownCount: 0, untrackedCount: 0,
        nonPhysicalCount: 0, totalTrackedKnown: 3, catalogComplete: true,
        restockVariants: [{ id: "gid://shopify/ProductVariant/1", title: "Blue / M", sku: "TEE-BLU-M", createdAt: "2024-01-01T00:00:00Z", product: { id: "gid://shopify/Product/1", title: "Sample Tee" }, inventoryStatus: "known", available: 3 }],
      };
    },
  };
  const data = await service.loadRestockData({
    admin: { graphql: async () => { throw new Error("shop reader is injected"); } },
    scopes: { query: async () => ({ granted: ["read_products", "read_inventory"] }) },
    shop: "example.myshopify.com", period: 28, now: () => new Date("2026-10-29T12:00:00Z"),
  }, dependencies);
  assert.equal(data.salesStatus, "permission_required");
  assert.match(data.salesMessage, /read_orders/);
  assert.equal(data.rows[0].unitsSold, null);
  assert.equal(salesReads, 0, "the sales reader is not called when the current grant lacks read_orders");
  assert.equal(inventoryReads, 1, "independent inventory access remains usable");

  const unverified = await service.loadRestockData({
    admin: { graphql: async () => { throw new Error("must not query"); } },
    scopes: { query: async () => { throw new Error("grant unavailable"); } },
    shop: "example.myshopify.com", period: 28,
  }, dependencies);
  assert.equal(unverified.salesStatus, "unverified");
  assert.equal(unverified.inventoryStatus, "unverified");
  assert.equal(salesReads, 0);
  assert.equal(inventoryReads, 1);
});

test("live rows join sales and inventory by Variant GID and preserve sold-only variants as unknown inventory", async () => {
  let readerOptions;
  let observedWindow;
  const knownId = "gid://shopify/ProductVariant/known";
  const soldOnlyId = "gid://shopify/ProductVariant/sold-only";
  const data = await service.loadRestockData({
    admin: { graphql: async () => { throw new Error("shop reader is injected"); } },
    scopes: { query: async () => ({ granted: ["read_products", "read_inventory", "read_orders"] }) },
    shop: "example.myshopify.com", period: 56, now: () => new Date("2026-11-02T17:00:00Z"),
  }, {
    readShop: async () => ({ shop: { name: "Example", ianaTimezone: "America/New_York", currencyCode: "USD" } }),
    readSales: async (_admin, window, _zone, _currency, _signal, options) => {
      observedWindow = window;
      readerOptions = options;
      return { status: "ready", demandComplete: true, variantDemand: [
        { id: knownId, units: 30, productId: "gid://shopify/Product/known", productTitle: "Known Tee", title: "Blue / M", sku: "DUPLICATE" },
        { id: soldOnlyId, units: 8, productId: "gid://shopify/Product/removed", productTitle: "Removed Tee", title: "Red / S", sku: "DUPLICATE" },
      ] };
    },
    readInventory: async () => ({
      status: "ready", threshold: 5, lowStockSkuCount: 0, outOfStockSkuCount: 0,
      lowStockVariants: [], outOfStockVariants: [], unknownCount: 0, untrackedCount: 0,
      nonPhysicalCount: 0, totalTrackedKnown: 7, catalogComplete: true,
      restockVariants: [{ id: knownId, title: "Blue / M", sku: "DUPLICATE", createdAt: "2024-01-01T00:00:00Z", product: { id: "gid://shopify/Product/known", title: "Known Tee" }, inventoryStatus: "known", available: 7 }],
    }),
  });
  const rows = new Map(data.rows.map((row) => [row.variantId, row]));
  assert.equal(observedWindow.dates.length, 56);
  assert.equal(readerOptions.includeVariantDetails, true);
  assert.equal(data.periodStartDate, "2026-09-07");
  assert.equal(rows.get(knownId).unitsSold, 30);
  assert.equal(rows.get(knownId).available, 7);
  assert.equal(rows.get(soldOnlyId).inventoryStatus, "unknown");
  assert.equal(rows.get(soldOnlyId).available, null);
  assert.equal(rows.get(soldOnlyId).unitsSold, 8);
  assert.equal(rows.get(soldOnlyId).sku, "DUPLICATE",
    "duplicate SKUs do not collapse distinct Shopify variant identities");
});

test("incomplete per-variant demand is not presented as zero sales", async () => {
  const data = await service.loadRestockData({
    admin: { graphql: async () => { throw new Error("shop reader is injected"); } },
    scopes: { query: async () => ({ granted: ["read_products", "read_inventory", "read_orders"] }) },
    shop: "example.myshopify.com", period: 28,
  }, {
    readShop: async () => ({ shop: { name: "Example", ianaTimezone: "UTC", currencyCode: "USD" } }),
    readSales: async () => ({ status: "ready", demandComplete: false, variantDemand: [] }),
    readInventory: async () => ({
      status: "ready", threshold: 5, lowStockSkuCount: 0, outOfStockSkuCount: 0,
      lowStockVariants: [], outOfStockVariants: [], unknownCount: 0, untrackedCount: 0,
      nonPhysicalCount: 0, totalTrackedKnown: 4, catalogComplete: true,
      restockVariants: [{ id: "gid://shopify/ProductVariant/1", title: "Blue / M", sku: "TEE-BLU-M", createdAt: "2024-01-01T00:00:00Z", product: { id: "gid://shopify/Product/1", title: "Sample Tee" }, inventoryStatus: "known", available: 4 }],
    }),
  });
  assert.equal(data.salesStatus, "ready", "Overview's existing section status is preserved");
  assert.equal(data.salesDemandComplete, false);
  assert.equal(data.rows[0].unitsSold, null, "unknown demand is not fabricated as a zero-sales result");
});
