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

test("live-scope gate sends no analytics GraphQL requests when the grant is missing", async () => {
  let calls = 0;
  const result = await loadOverviewAnalytics(shopInput({
    scopes: granted([]),
    admin: { graphql: async () => { calls += 1; return response({ data: {} }); } },
  }));

  assert.equal(calls, 0, "scope authorization is resolved before any sales or inventory request");
  assert.equal(result.scopesVerified, true);
  assert.equal(result.sales.status, "permission_required");
  assert.match(result.sales.message, /read_orders/);
  assert.equal(result.inventory.status, "permission_required");
  assert.match(result.inventory.message, /read_products.*read_inventory/);
  assert.doesNotMatch(result.inventory.message, /read_locations/, "no redundant location scope is requested for available inventory fields");
});

test("sales analytics require read_products and make no GraphQL request when it is missing", async () => {
  let calls = 0;
  const result = await loadOverviewAnalytics(shopInput({
    scopes: granted(["read_orders", "read_inventory"]),
    admin: { graphql: async () => { calls += 1; return response({ data: {} }); } },
  }));

  assert.equal(calls, 0, "missing product identity scope blocks both Orders and Product/Variant analytics queries");
  assert.equal(result.sales.status, "permission_required");
  assert.deepEqual(result.salesMissingScopes, ["read_products"]);
  assert.match(result.sales.message, /read_products/);
  assert.equal(result.inventory.status, "permission_required", "inventory also needs product identity");
  assert.ok(result.inventoryMissingScopes.includes("read_products"));
});

test("read_products and read_inventory alone permit inventory analytics without redundant read_locations", async () => {
  let calls = 0;
  const result = await loadOverviewAnalytics(shopInput({
    scopes: granted(["read_products", "read_inventory"]),
    admin: { graphql: async () => {
      calls += 1;
      return response({ data: { productVariants: connection([]) } });
    } },
  }));

  assert.equal(result.inventoryMissingScopes.length, 0,
    "the current inventory data access does not require a separate read_locations grant");
  assert.equal(result.inventory.status, "ready");
  assert.equal(calls, 1, "inventory GraphQL is requested after its actual minimum scopes are granted");
  assert.deepEqual(result.inventory.data.totalTrackedKnown, 0);
});

test("successful zero-order analytics are cached per shop without refreshing fetchedAt", async () => {
  let graphqlCalls = 0;
  let clock = new Date("2026-10-28T12:00:00.000Z");
  const admin = { graphql: async (query) => {
    graphqlCalls += 1;
    if (query.includes("StockHubOverviewInventoryVariants")) {
      return response({ data: { productVariants: connection([]) } });
    }
    assert.match(query, /StockHubOverviewOrders/);
    return response({ data: { orders: connection([]) } });
  } };
  const shop = `cache-${crypto.randomUUID()}.myshopify.com`;
  const input = () => shopInput({
    shop,
    scopes: granted([...salesScopes, "read_inventory"]),
    admin,
    now: () => new Date(clock),
  });

  const first = await loadOverviewAnalytics(input());
  assert.equal(first.sales.status, "ready");
  assert.deepEqual(first.sales.data.totals, { revenue: 0, orders: 0, units: 0 },
    "a successfully read empty Orders connection is a valid zero-sales state");
  assert.equal(first.inventory.status, "ready");
  assert.equal(graphqlCalls, 2, "initial read requests sales and inventory once each");
  const originalFetchedAt = first.fetchedAt;
  assert.ok(originalFetchedAt);

  clock = new Date("2026-10-28T12:00:10.000Z");
  const second = await loadOverviewAnalytics(input());

  assert.equal(graphqlCalls, 2, "same-shop, same-date read is served from the analytics cache");
  assert.equal(second.sales.fetchedAt, first.sales.fetchedAt,
    "the cached sales fetchedAt remains the original Shopify fetch time");
  assert.equal(second.inventory.fetchedAt, first.inventory.fetchedAt,
    "the cached inventory fetchedAt remains the original Shopify fetch time");
  assert.equal(second.fetchedAt, originalFetchedAt);
});

test("analytics cache keys isolate shops with the same range, date, timezone, and currency", async () => {
  let graphqlCalls = 0;
  const admin = { graphql: async (query) => {
    graphqlCalls += 1;
    if (query.includes("StockHubOverviewInventoryVariants")) {
      return response({ data: { productVariants: connection([]) } });
    }
    assert.match(query, /StockHubOverviewOrders/);
    return response({ data: { orders: connection([]) } });
  } };
  const scopes = granted([...salesScopes, "read_inventory"]);
  const common = { scopes, admin, now };
  const firstShop = await loadOverviewAnalytics(shopInput({ ...common, shop: "cache-a.myshopify.com" }));
  const secondShop = await loadOverviewAnalytics(shopInput({ ...common, shop: "cache-b.myshopify.com" }));

  assert.equal(firstShop.sales.status, "ready");
  assert.equal(secondShop.sales.status, "ready");
  assert.equal(graphqlCalls, 4, "each tenant independently requests sales and inventory instead of sharing a cached result");
});

test("sales service paginates Orders and nested lineItems, excludes no-PII query fields, and returns aggregates only", async () => {
  const calls = [];
  const admin = { graphql: async (query, { variables }) => {
    calls.push({ query, variables });
    if (query.includes("StockHubOverviewOrderLineItems")) {
      return response({ data: { order: { lineItems: connection([
        salesLine({ id: "line-2", currentQuantity: 3, amount: 30, productId: "gid://shopify/Product/2", variantId: "gid://shopify/ProductVariant/2" }),
      ]) } } });
    }
    assert.match(query, /StockHubOverviewOrders/);
    if (variables.after === null) {
      return response({ data: { orders: connection([
        orderNode({
          id: "gid://shopify/Order/1",
          lines: [salesLine({ id: "line-1", currentQuantity: 2, amount: 20 })],
          hasMoreLines: true,
          lineCursor: "line-cursor-1",
          extra: { customer: { email: "private@example.test", phone: "+10000000000" } },
        }),
      ], { hasNextPage: true, endCursor: "order-cursor-1" }) } });
    }
    return response({ data: { orders: connection([
      orderNode({ id: "gid://shopify/Order/2", lines: [salesLine({ id: "line-3", currentQuantity: 1, amount: 10 })] }),
    ]) } });
  } };

  const result = await loadOverviewAnalytics(shopInput({ scopes: granted(salesScopes), admin }));

  assert.equal(result.sales.status, "ready");
  assert.deepEqual(result.sales.data.totals, { revenue: 60, orders: 2, units: 6 });
  assert.equal(calls.length, 3, "one first Order page, one nested lineItems page, then the next Order page");
  assert.deepEqual(calls.map(({ query }) => query.includes("StockHubOverviewOrderLineItems") ? "lines" : "orders"), ["orders", "lines", "orders"]);
  assert.equal(calls[1].variables.id, "gid://shopify/Order/1");
  assert.equal(calls[1].variables.after, "line-cursor-1");
  assert.equal(calls[2].variables.after, "order-cursor-1");
  assert.ok(calls[0].query.includes("test"), "query selects Shopify's required Order.test flag");
  for (const { query } of Object.values(overviewAnalyticsGraphQL).map((query) => ({ query }))) {
    assert.doesNotMatch(query, /\b(customer|email|phone|address|firstName|lastName)\b/i,
      "analytics GraphQL must not request customer PII fields");
  }
  assert.doesNotMatch(JSON.stringify(result), /private@example\.test|\+10000000000|customer/i,
    "service output contains aggregates, not raw order or customer data");
});

test("sales service retries throttling a bounded number of times and recovers", async () => {
  let calls = 0;
  const admin = { graphql: async () => {
    calls += 1;
    if (calls < 3) return response({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
    return response({ data: { orders: connection([orderNode({
      id: "gid://shopify/Order/recovered",
      lines: [salesLine({ id: "recovered-line", currentQuantity: 1, amount: 7 })],
    })]) } });
  } };

  const result = await loadOverviewAnalytics(shopInput({ scopes: granted(salesScopes), admin }));

  assert.equal(calls, 3, "the service retries transient throttles at most twice before the successful attempt");
  assert.equal(result.sales.status, "ready");
  assert.deepEqual(result.sales.data.totals, { revenue: 7, orders: 1, units: 1 });
});

test("sales service marks later-page API failure partial and exhausted initial throttling unavailable", async (t) => {
  await t.test("later page failure preserves only the first page and labels it partial", async () => {
    let calls = 0;
    const admin = { graphql: async (_query, { variables }) => {
      calls += 1;
      if (variables.after !== null) throw new Error("temporary API outage");
      return response({ data: { orders: connection([orderNode({
        id: "gid://shopify/Order/partial",
        lines: [salesLine({ id: "partial-line", currentQuantity: 2, amount: 9 })],
      })], { hasNextPage: true, endCursor: "next-page" }) } });
    } };

    const result = await loadOverviewAnalytics(shopInput({ scopes: granted(salesScopes), admin }));

    assert.equal(calls, 4, "the failed second page gets the bounded request retries after one successful page");
    assert.equal(result.sales.status, "partial");
    assert.deepEqual(result.sales.data.totals, { revenue: 9, orders: 1, units: 2 });
    assert.match(result.sales.message, /partial|fully read/i);
  });

  await t.test("exhausted initial throttling yields unavailable without pretending totals are zero", async () => {
    let calls = 0;
    const admin = { graphql: async () => {
      calls += 1;
      return response({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
    } };

    const result = await loadOverviewAnalytics(shopInput({ scopes: granted(salesScopes), admin }));

    assert.equal(calls, 3, "the request is bounded to three attempts total");
    assert.equal(result.sales.status, "unavailable");
    assert.equal(result.sales.data, null);
    assert.match(result.sales.message, /could not be loaded/i);
  });
});

test("inventory service paginates variants and active inventory levels while retaining unknown as unknown", async () => {
  const calls = [];
  const activeLevel = (id, quantity, isActive = true) => ({
    isActive,
    location: { id, isActive },
    quantities: [{ name: "available", quantity }],
  });
  const variantNode = ({ id, sku, tracked = true, levels, hasMoreLevels = false, levelCursor = null }) => ({
    id,
    title: sku,
    sku,
    product: { id: "gid://shopify/Product/50", title: "Inventory", legacyResourceId: "50", featuredImage: null },
    inventoryItem: { id: `item-${id}`, tracked, inventoryLevels: connection(levels, { hasNextPage: hasMoreLevels, endCursor: levelCursor }) },
  });
  const admin = { graphql: async (query, { variables }) => {
    calls.push({ query, variables });
    if (query.includes("StockHubOverviewInventoryLevels")) {
      return response({ data: { inventoryItem: { inventoryLevels: connection([
        activeLevel("loc-2", 3),
        activeLevel("inactive-loc", 500, false),
      ]) } } });
    }
    assert.match(query, /StockHubOverviewInventoryVariants/);
    if (variables.after === null) {
      return response({ data: { productVariants: connection([
        variantNode({ id: "v-low-a", sku: "LOW-SHARED", levels: [activeLevel("loc-1", 2)], hasMoreLevels: true, levelCursor: "level-cursor" }),
      ], { hasNextPage: true, endCursor: "variant-cursor" }) } });
    }
    return response({ data: { productVariants: connection([
      variantNode({ id: "v-out", sku: "OUT", levels: [activeLevel("loc-1", 0)] }),
      variantNode({ id: "v-unknown", sku: "UNKNOWN", levels: [activeLevel("loc-1", null)] }),
    ]) } });
  } };

  const result = await loadOverviewAnalytics(shopInput({ scopes: granted(inventoryScopes), admin }));

  assert.equal(result.inventory.status, "partial", "a null available quantity is not converted to zero");
  assert.equal(result.inventory.data.totalTrackedKnown, 5, `active levels across pages sum; inactive 500 is excluded: ${JSON.stringify({ data: result.inventory.data, calls })}`);
  assert.equal(result.inventory.data.lowStockSkuCount, 1);
  assert.equal(result.inventory.data.outOfStockSkuCount, 1);
  assert.equal(result.inventory.data.unknownCount, 1);
  assert.equal(calls.length, 3, "first variant page, nested inventory-level page, second variant page");
  assert.deepEqual(calls.map(({ query }) => query.includes("StockHubOverviewInventoryLevels") ? "levels" : "variants"), ["variants", "levels", "variants"]);
  assert.equal(calls[1].variables.id, "item-v-low-a");
  assert.equal(calls[1].variables.after, "level-cursor");
  assert.equal(calls[2].variables.after, "variant-cursor");
});
