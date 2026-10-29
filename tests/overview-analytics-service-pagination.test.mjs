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

const { loadOverviewAnalytics, overviewAnalyticsGraphQL } = await vite.ssrLoadModule("/app/utils/overview-analytics.server.ts");

const now = () => new Date("2026-10-28T12:00:00.000Z");
const granted = (items) => ({ query: async () => ({ granted: items }) });
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const connection = (nodes, { hasNextPage = false, endCursor = null } = {}) => ({
  nodes,
  pageInfo: { hasNextPage, endCursor },
});
const shopInput = (overrides = {}) => ({
  admin: { graphql: async () => { throw new Error("Unexpected Shopify GraphQL request"); } },
  scopes: granted([]),
  shop: `analytics-${crypto.randomUUID()}.myshopify.com`,
  range: 7,
  timeZone: "UTC",
  currencyCode: "USD",
  now,
  ...overrides,
});
const salesScopes = ["read_orders", "read_products"];
const inventoryScopes = ["read_products", "read_inventory"];

function orderNode({ id, lines = [], hasMoreLines = false, lineCursor = null, createdAt = "2026-10-28T10:00:00.000Z", test = false, extra = {} }) {
  return {
    id,
    createdAt,
    cancelledAt: null,
    test,
    lineItems: connection(lines, { hasNextPage: hasMoreLines, endCursor: lineCursor }),
    ...extra,
  };
}

function salesLine({ id, currentQuantity, amount, productId = "gid://shopify/Product/1", variantId = "gid://shopify/ProductVariant/1" }) {
  return {
    id,
    currentQuantity,
    priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount: String(amount), currencyCode: "USD" } },
    product: { id: productId, title: `Product ${productId.split("/").at(-1)}`, legacyResourceId: productId.split("/").at(-1) },
    variant: { id: variantId, title: "Default", sku: `SKU-${variantId.split("/").at(-1)}` },
  };
}

test("sales service marks the 9,910-line-item cap partial and preserves fetched totals", async () => {
  let lineItemCalls = 0;
  const admin = { graphql: async (query, { variables }) => {
    if (query.includes("StockHubOverviewOrderLineItems")) {
      lineItemCalls += 1;
      assert.equal(variables.first, 100);
      assert.equal(variables.after, `line-cursor-${lineItemCalls - 1}`);
      const lines = Array.from({ length: 100 }, (_, index) => salesLine({
        id: `line-page-${lineItemCalls}-${index}`,
        currentQuantity: 1,
        amount: 1,
      }));
      return response({ data: { order: { lineItems: connection(lines, {
        hasNextPage: true,
        endCursor: `line-cursor-${lineItemCalls}`,
      }) } } });
    }

    assert.match(query, /StockHubOverviewOrders/);
    return response({ data: { orders: connection([orderNode({
      id: "gid://shopify/Order/line-cap",
      lines: Array.from({ length: 10 }, (_, index) => salesLine({
        id: `line-initial-${index}`,
        currentQuantity: 1,
        amount: 1,
      })),
      hasMoreLines: true,
      lineCursor: "line-cursor-0",
    })]) } });
  } };

  const result = await loadOverviewAnalytics(shopInput({ scopes: granted(salesScopes), admin }));

  assert.equal(lineItemCalls, 99, "the initial 10 line items are followed by at most 99 pages of 100");
  assert.equal(result.sales.status, "partial", "an unread continuation at the line-item cap cannot appear complete");
  assert.match(result.sales.message, /line-item pagination safety cap/i);
  assert.deepEqual(result.sales.data.totals, { revenue: 9910, orders: 1, units: 9910 },
    "totals include all 9,910 fetched line items but do not invent the unread continuation");
});

test("sales service bounds line-item continuation requests across the whole analytics load", async () => {
  const continuationCalls = new Map();
  const admin = { graphql: async (query, { variables }) => {
    if (query.includes("StockHubOverviewOrderLineItems")) {
      const orderId = variables.id;
      const callCount = (continuationCalls.get(orderId) ?? 0) + 1;
      continuationCalls.set(orderId, callCount);
      return response({ data: { order: { lineItems: connection([
        salesLine({ id: `${orderId}-line-${callCount}`, currentQuantity: 1, amount: 1 }),
      ], { hasNextPage: true, endCursor: `${orderId}-cursor-${callCount}` }) } } });
    }

    assert.match(query, /StockHubOverviewOrders/);
    return response({ data: { orders: connection([
      orderNode({ id: "gid://shopify/Order/budget-1", lines: [salesLine({ id: "initial-1", currentQuantity: 1, amount: 1 })], hasMoreLines: true, lineCursor: "gid://shopify/Order/budget-1-cursor-0" }),
      orderNode({ id: "gid://shopify/Order/budget-2", lines: [salesLine({ id: "initial-2", currentQuantity: 1, amount: 1 })], hasMoreLines: true, lineCursor: "gid://shopify/Order/budget-2-cursor-0" }),
      orderNode({ id: "gid://shopify/Order/budget-3", lines: [salesLine({ id: "initial-3", currentQuantity: 1, amount: 1 })], hasMoreLines: true, lineCursor: "gid://shopify/Order/budget-3-cursor-0" }),
    ]) } });
  } };

  const result = await loadOverviewAnalytics(shopInput({ scopes: granted(salesScopes), admin }));
  const totalContinuations = [...continuationCalls.values()].reduce((total, count) => total + count, 0);

  assert.equal(totalContinuations, 100,
    "the 100-page line-item continuation budget is shared across orders, not multiplied by each order");
  assert.equal(result.sales.status, "partial");
  assert.match(result.sales.message, /line-item continuation request budget/i,
    "the merchant-facing partial reason identifies the aggregate continuation budget");
  assert.deepEqual(result.sales.data.totals, { revenue: 103, orders: 3, units: 103 },
    "totals include only the initial lines and continuation pages actually fetched");
});

test("inventory service marks the 2,410-level cap partial and keeps the variant unknown", async () => {
  let levelCalls = 0;
  const activeLevel = (index) => ({
    isActive: true,
    location: { id: `location-${index}`, isActive: true },
    quantities: [{ name: "available", quantity: 1 }],
  });
  const admin = { graphql: async (query, { variables }) => {
    if (query.includes("StockHubOverviewInventoryLevels")) {
      levelCalls += 1;
      assert.equal(variables.id, "inventory-item-level-cap");
      assert.equal(variables.first, 100);
      assert.equal(variables.after, `level-cursor-${levelCalls - 1}`);
      return response({ data: { inventoryItem: { inventoryLevels: connection(
        Array.from({ length: 100 }, (_, index) => activeLevel(levelCalls * 100 + index)),
        { hasNextPage: true, endCursor: `level-cursor-${levelCalls}` },
      ) } } });
    }

    assert.match(query, /StockHubOverviewInventoryVariants/);
    return response({ data: { productVariants: connection([{
      id: "gid://shopify/ProductVariant/level-cap",
      title: "Level Cap Variant",
      sku: "LEVEL-CAP",
      product: { id: "gid://shopify/Product/level-cap", title: "Level Cap Product", legacyResourceId: "level-cap", featuredImage: null },
      inventoryItem: {
        id: "inventory-item-level-cap",
        tracked: true,
        inventoryLevels: connection(Array.from({ length: 10 }, (_, index) => activeLevel(index)), {
          hasNextPage: true,
          endCursor: "level-cursor-0",
        }),
      },
    }]) } });
  } };

  const result = await loadOverviewAnalytics(shopInput({ scopes: granted(inventoryScopes), admin }));

  assert.equal(levelCalls, 24, "the initial 10 inventory levels are followed by at most 24 pages of 100");
  assert.equal(result.inventory.status, "partial", "an unread location continuation cannot appear complete");
  assert.match(result.inventory.message, /inventory-level safety cap/i);
  assert.equal(result.inventory.data.unknownCount, 1,
    "a variant with capped inventory locations remains unknown rather than presenting a partial stock sum as complete");
  assert.equal(result.inventory.data.totalTrackedKnown, 0,
    "known fetched levels are not misrepresented as the variant's complete availability");
});

test("partial inventory at the variant cap retains observed duplicate-SKU counts for explicit qualification", async () => {
  const makeVariant = (index) => {
    const sharedSku = index === 0 || index === 20 || index === 1000;
    return {
      id: `gid://shopify/ProductVariant/duplicate-cap-${index}`,
      title: `Variant ${index}`,
      sku: sharedSku ? "SHARED-ACROSS-PAGES" : `SKU-${index}`,
      product: { id: `gid://shopify/Product/duplicate-cap-${index}`, title: `Product ${index}`, legacyResourceId: String(index), featuredImage: null },
      inventoryItem: {
        id: `inventory-item-duplicate-cap-${index}`,
        tracked: true,
        inventoryLevels: connection([{
          isActive: true,
          location: { id: "location-1", isActive: true },
          quantities: [{ name: "available", quantity: sharedSku ? 2 : 10 }],
        }]),
      },
    };
  };
  const fetchedVariants = Array.from({ length: 1000 }, (_, index) => makeVariant(index));
  const admin = { graphql: async (_query, { variables }) => {
    const pageIndex = variables.after === null ? 0 : Number(variables.after.split("-").at(-1)) + 1;
    const nodes = fetchedVariants.slice(pageIndex * 20, pageIndex * 20 + 20);
    return response({ data: { productVariants: connection(nodes, {
      hasNextPage: true,
      endCursor: `variants-${pageIndex}`,
    }) } });
  } };

  const result = await loadOverviewAnalytics(shopInput({ scopes: granted(inventoryScopes), admin }));
  const { aggregateInventoryVariants } = await vite.ssrLoadModule("/app/utils/overview-analytics.shared.ts");
  const fullCatalog = aggregateInventoryVariants(Array.from({ length: 1001 }, (_, index) => ({
    id: `gid://shopify/ProductVariant/duplicate-cap-${index}`,
    title: `Variant ${index}`,
    sku: index === 0 || index === 20 || index === 1000 ? "SHARED-ACROSS-PAGES" : `SKU-${index}`,
    product: { id: `gid://shopify/Product/duplicate-cap-${index}`, title: `Product ${index}`, legacyResourceId: String(index) },
    tracked: true,
    levels: [{ isActive: true, available: index === 0 || index === 20 || index === 1000 ? 2 : 10 }],
    levelsComplete: true,
  })));

  assert.equal(result.inventory.status, "partial");
  assert.equal(result.inventory.data.lowStockSkuCount, 1,
    "the two observed variants sharing a SKU sum to four available units and are counted as low stock");
  assert.equal(result.inventory.data.lowStockVariants[0].variantCount, 2,
    "the duplicate SKU is grouped across fetched variant pages");
  assert.equal(fullCatalog.lowStockSkuCount, 0,
    "the unread third variant with the same SKU can push its aggregate above the low-stock threshold");
});

test("sales service uses Shopify cost metadata for bounded retry delay", async () => {
  let calls = 0;
  const scheduledDelays = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    scheduledDelays.push(delay);
    queueMicrotask(() => callback(...args));
    return 0;
  };

  try {
    const admin = { graphql: async () => {
      calls += 1;
      if (calls === 1) {
        return response({
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          extensions: { cost: { requestedQueryCost: 500, throttleStatus: { currentlyAvailable: 200, restoreRate: 100 } } },
        });
      }
      return response({ data: { orders: connection([]) } });
    } };

    const result = await loadOverviewAnalytics(shopInput({ scopes: granted(salesScopes), admin }));

    assert.equal(calls, 2, "the cost-metadata retry recovers on its second request");
    assert.deepEqual(scheduledDelays, [3100],
      "the service waits for the 300-point restore estimate plus its 100ms safety buffer");
    assert.equal(result.sales.status, "ready");
    assert.deepEqual(result.sales.data.totals, { revenue: 0, orders: 0, units: 0 });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
