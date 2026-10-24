/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const databaseUrl = process.env.STOCKHUB_TEST_DATABASE_URL;

async function setup(t) {
  assert.ok(databaseUrl, "STOCKHUB_TEST_DATABASE_URL must point to a disposable PostgreSQL database");
  const parsed = new URL(databaseUrl);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/stockhub_regression");

  const { PrismaClient } = await import("../node_modules/.prisma/stockhub-pg-test-client/index.js");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  await prisma.$connect();
  const identity = await prisma.$queryRaw`SELECT current_database() AS database, current_user AS role, version() AS version`;
  assert.equal(identity[0].database, "stockhub_regression");
  assert.match(identity[0].version, /PostgreSQL 16/i);
  t.after(async () => prisma.$disconnect());

  globalThis.__stockhubHttpTest = { prisma, auth: null };
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [{
      name: "stockhub-http-action-test-mocks",
      enforce: "pre",
      resolveId(source) {
        if (source === "../shopify.server") return "\0stockhub-test-shopify.server";
        if (source === "../db.server") return "\0stockhub-test-db.server";
        return null;
      },
      load(id) {
        if (id === "\0stockhub-test-shopify.server") {
          return `export const authenticate = { admin: async (request) => globalThis.__stockhubHttpTest.auth(request) };`;
        }
        if (id === "\0stockhub-test-db.server") {
          return `const prisma = globalThis.__stockhubHttpTest.prisma; export default prisma;`;
        }
        return null;
      },
    }],
    server: { middlewareMode: true },
    ssr: { noExternal: ["@shopify/shopify-app-react-router"] },
    logLevel: "error",
  });
  t.after(async () => vite.close());

  const detailRoute = await vite.ssrLoadModule("/app/routes/app.imports.history.$batchId.tsx");
  assert.equal(typeof detailRoute.action, "function");
  return { prisma, identity: identity[0], action: detailRoute.action };
}

function response(data) {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function makeAdmin({ shop, scopes, locationActive = true, calls, skuBarrier }) {
  return {
    async graphql(query, options = {}) {
      const name = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "unknown";
      calls.push({ name, variables: options.variables ?? {} });
      switch (name) {
        case "DiagnoseStockHubLocations":
          return response({ shop: { myshopifyDomain: shop, currencyCode: "USD" },
            currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
            locations: { nodes: [{ id: "gid://shopify/Location/10", name: "Main warehouse", isActive: locationActive }],
              pageInfo: { hasNextPage: false, endCursor: null } } });
        case "StockHubValidateLocation":
          return response({ locations: { nodes: [{ id: "gid://shopify/Location/10", name: "Main warehouse", isActive: locationActive }], pageInfo: { hasNextPage: false, endCursor: null } } });
        case "StockHubRecheckSku":
          if (skuBarrier) return skuBarrier.wait();
          return response({ productVariants: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } });
        case "StockHubFindDraftMarker":
          return response({ productByIdentifier: null });
        case "StockHubCreateDraft": {
          const id = "gid://shopify/Product/300";
          return response({ productCreate: { product: { id, title: "Test product", status: "DRAFT",
            metafield: { value: options.variables.product.metafields?.[0]?.value ?? "operation-http-line" },
            variants: { nodes: [{ id: "gid://shopify/ProductVariant/300", sku: "", price: "10.00",
              inventoryItem: { id: "gid://shopify/InventoryItem/300", tracked: false } }] } }, userErrors: [] } });
        }
        case "StockHubUpdateDraftInventoryItem":
          return response({ inventoryItemUpdate: { inventoryItem: { id: options.variables.id, sku: options.variables.input.sku, tracked: true }, userErrors: [] } });
        case "StockHubSetDraftPrice":
          return response({ productVariantsBulkUpdate: { productVariants: [{ id: options.variables.variantId, price: options.variables.price }], userErrors: [] } });
        case "StockHubActivateDraftInventory":
          return response({ inventoryActivate: { inventoryLevel: { id: "gid://shopify/InventoryLevel/300", quantities: [{ name: "available", quantity: options.variables.quantity }] }, userErrors: [] } });
        default:
          throw new Error(`Unexpected mocked Admin GraphQL operation ${name}`);
      }
    },
  };
}

function mergeRequest(batchId, intent = "merge", confirmed = "yes") {
  const form = new URLSearchParams({ intent, batchId, confirmed });
  return new Request(`http://localhost/app/imports/history/${batchId}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Request": crypto.randomUUID() },
    body: form,
  });
}

test("actual Import History route action serializes concurrent Merge POSTs on isolated PostgreSQL", { skip: !databaseUrl }, async (t) => {
  const { prisma, action, identity } = await setup(t);
  const shop = "http-action-race.myshopify.com";
  const batchId = "http-action-race-batch";
  const lineId = "http-action-race-line";
  const operationId = "operation-http-line";
  const allScopes = ["read_products", "read_inventory", "read_locations", "write_inventory", "write_products"];
  await prisma.importBatch.deleteMany({ where: { shop } });
  await prisma.importBatch.create({ data: {
    id: batchId, shop, submissionId: `http-${crypto.randomUUID()}`, receiptCode: "IMP-HTTP-RACE",
    fileChecksum: "http-race-checksum", fileName: "http.csv", locationId: "gid://shopify/Location/10",
    locationName: "Main warehouse", currencyCode: "USD", status: "PREVIEWED",
    createdAt: new Date(), updatedAt: new Date(),
    lines: { create: [{ id: lineId, rowNumber: 2, sku: "HTTP-SKU", title: "Test product", description: "HTTP concurrency",
      price: "10.00", quantity: 3, operationType: "CREATE_DRAFT", status: "PREVIEWED", stage: "PREPARED",
      operationId, idempotencyKey: `http-idempotency-${lineId}`, createdAt: new Date(), updatedAt: new Date() }] },
  } });

  let releaseA;
  let startedA;
  const started = new Promise((resolve) => { startedA = resolve; });
  const delayed = new Promise((resolve) => { releaseA = resolve; });
  let skuLookups = 0;
  const mutationCalls = [];
  const admin = makeAdmin({ shop, scopes: allScopes, calls: mutationCalls, skuBarrier: {
    wait() {
      skuLookups += 1;
      if (skuLookups === 1) { startedA(); return delayed; }
      return response({ productVariants: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    },
  } });
  const authenticatedRequests = [];
  globalThis.__stockhubHttpTest.auth = async (request) => {
    authenticatedRequests.push(request);
    return { session: { shop, userId: 7n, firstName: "Test", lastName: "Merchant", email: "test@example.invalid", accountOwner: true },
      admin, scopes: { query: async () => ({ granted: allScopes }) } };
  };

  // Each invocation is an independent URL-encoded HTTP Request passed through
  // the real action exported by app.imports.history.$batchId.tsx.
  const requestA = mergeRequest(batchId);
  const requestB = mergeRequest(batchId);
  const responseAWait = action({ request: requestA, params: { batchId }, context: {} });
  await started;
  // Two HTTP action requests overlap. Expire only this isolated test receipt's
  // lease to model a timed-out worker, then let request B take ownership.
  await prisma.importBatch.update({ where: { id: batchId }, data: { updatedAt: new Date(Date.now() - 16 * 60_000) } });
  const responseBWait = action({ request: requestB, params: { batchId }, context: {} });
  const responseB = await responseBWait;
  releaseA(response({ productVariants: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } }));
  const responseA = await responseAWait;

  assert.equal(authenticatedRequests.length, 2, "both HTTP actions use authentication");
  assert.ok(responseA instanceof Response);
  assert.ok(responseB instanceof Response);
  assert.equal(responseA.status, 302);
  assert.equal(responseB.status, 302);
  assert.equal(responseA.headers.get("Location"), `/app/imports/history/${batchId}`);
  assert.equal(responseB.headers.get("Location"), `/app/imports/history/${batchId}`);

  const finalBatch = await prisma.importBatch.findFirstOrThrow({ where: { id: batchId, shop }, include: { lines: true } });
  assert.equal(finalBatch.status, "COMPLETED");
  assert.equal(finalBatch.lines[0].status, "SUCCEEDED");
  assert.equal(finalBatch.lines[0].stage, "COMPLETED");
  assert.equal(finalBatch.lines[0].operationId, operationId);
  assert.deepEqual(mutationCalls.filter(({ name }) => name === "StockHubCreateDraft").length, 1);
  assert.deepEqual(mutationCalls.filter(({ name }) => name === "StockHubActivateDraftInventory").length, 1);
  assert.equal(identity.database, "stockhub_regression");

  // A third HTTP Resume through the same action must observe completion and
  // perform no repeated create or activation.
  const beforeResume = mutationCalls.filter(({ name }) => ["StockHubCreateDraft", "StockHubActivateDraftInventory"].includes(name)).length;
  const resumeResponse = await action({ request: mergeRequest(batchId, "resume"), params: { batchId }, context: {} });
  const afterResume = mutationCalls.filter(({ name }) => ["StockHubCreateDraft", "StockHubActivateDraftInventory"].includes(name)).length;
  assert.equal(resumeResponse.status, 302);
  assert.equal(afterResume, beforeResume);
});

test("actual Import History action rejects unconfirmed and cross-tenant Merge POSTs", { skip: !databaseUrl }, async (t) => {
  const { prisma, action } = await setup(t);
  const shop = "http-action-security.myshopify.com";
  const batchId = "http-action-security-batch";
  const scopes = ["read_products", "read_inventory", "read_locations", "write_inventory", "write_products"];
  await prisma.importBatch.deleteMany({ where: { shop } });
  await prisma.importBatch.create({ data: { id: batchId, shop, submissionId: `sec-${crypto.randomUUID()}`, receiptCode: "IMP-HTTP-SEC",
    fileChecksum: "security-checksum", fileName: "security.csv", locationId: "gid://shopify/Location/10", locationName: "Main warehouse",
    currencyCode: "USD", status: "PREVIEWED", lines: { create: [{ id: `${batchId}-line`, rowNumber: 2, sku: "SEC-SKU", title: "Sec",
      description: "security", price: "1.00", quantity: 1, operationType: "CREATE_DRAFT", status: "PREVIEWED", stage: "PREPARED",
      operationId: "security-operation", idempotencyKey: "security-key" }] } } });
  const calls = [];
  const admin = makeAdmin({ shop, scopes, calls });
  globalThis.__stockhubHttpTest.auth = async () => ({ session: { shop }, admin, scopes: { query: async () => ({ granted: scopes }) } });
  const unconfirmed = await action({ request: mergeRequest(batchId, "merge", "no"), params: { batchId }, context: {} });
  assert.equal(unconfirmed.error, "Explicit confirmation is required before writing to Shopify.");

  globalThis.__stockhubHttpTest.auth = async () => ({ session: { shop }, admin,
    scopes: { query: async () => ({ granted: scopes.filter((scope) => scope !== "write_products") }) } });
  const missingScope = await action({ request: mergeRequest(batchId), params: { batchId }, context: {} });
  assert.match(missingScope.error, /missing: write_products/);

  const inactiveAdmin = makeAdmin({ shop, scopes, locationActive: false, calls });
  globalThis.__stockhubHttpTest.auth = async () => ({ session: { shop }, admin: inactiveAdmin, scopes: { query: async () => ({ granted: scopes }) } });
  const inactiveLocation = await action({ request: mergeRequest(batchId), params: { batchId }, context: {} });
  assert.match(inactiveLocation.error, /location is not active and authorized/);

  globalThis.__stockhubHttpTest.auth = async () => { throw new Response("Unauthorized", { status: 401 }); };
  await assert.rejects(action({ request: mergeRequest(batchId), params: { batchId }, context: {} }), (error) => error.status === 401);

  globalThis.__stockhubHttpTest.auth = async () => ({ session: { shop: "different-store.myshopify.com" }, admin, scopes: { query: async () => ({ granted: scopes }) } });
  const wrongTenant = await action({ request: mergeRequest(batchId), params: { batchId }, context: {} });
  assert.match(wrongTenant.error, /not found in the authenticated store/);
  assert.equal(calls.filter(({ name }) => name.startsWith("StockHubCreate") || name.startsWith("StockHubActivate")).length, 0);
});
