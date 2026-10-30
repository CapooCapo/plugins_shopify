/* eslint-env node */
/* global globalThis */
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

function makeAdmin({ shop, scopes, locationActive = true, calls, skuBarrier, skuMatches = false }) {
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
          if (skuMatches) {
            const sku = options.variables?.query?.match(/sku:\\?"([^"]+)/)?.[1] ?? "HTTP-SKU";
            return response({ productVariants: { edges: [{ node: {
              id: "gid://shopify/ProductVariant/20", sku, title: "Default",
              product: { id: "gid://shopify/Product/30", title: "Existing", status: "ACTIVE" },
              inventoryItem: { id: "gid://shopify/InventoryItem/40", tracked: true,
                inventoryLevel: { quantities: [{ name: "available", quantity: 11 }] } },
            } }], pageInfo: { hasNextPage: false, endCursor: null } } });
          }
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
        case "StockHubAdjustIncoming":
          return response({ inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/300" },
            userErrors: [],
          } });
        default:
          throw new Error(`Unexpected mocked Admin GraphQL operation ${name}`);
      }
    },
  };
}

function mergeRequest(batchId, intent = "merge", confirmed = "yes", confirmedCount = "1", extra = {}) {
  const form = new URLSearchParams({ intent, batchId, confirmed, confirmedCount, expectedRevision: "0" });
  for (const [key, value] of Object.entries(extra)) form.set(key, String(value));
  return new Request(`http://localhost/app/imports/history/${batchId}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Test-Request": crypto.randomUUID() },
    body: form,
  });
}

function approvalRequest(batchId, intent, approvalId) {
  const form = new URLSearchParams({ intent, batchId, approvalId });
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
  // Two HTTP initial confirmations overlap. Keep the first worker's lease
  // current: this test exercises duplicate confirmation, while stale leases
  // are covered by dedicated service-level recovery tests.
  const responseBWait = action({ request: requestB, params: { batchId }, context: {} });
  const responseB = await responseBWait;
  releaseA(response({ productVariants: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } }));
  const responseA = await responseAWait;

  assert.equal(authenticatedRequests.length, 2, "both HTTP actions use authentication");
  assert.equal(responseA.mergeProgress?.status, "COMPLETED");
  assert.match(responseB.error ?? "", /already being processed|active approval/i,
    "a repeated initial confirmation cannot take over or dispatch another worker");

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
  const writeOperations = ["StockHubCreateDraft", "StockHubUpdateDraftInventoryItem", "StockHubSetDraftPrice", "StockHubActivateDraftInventory"];
  const beforeResume = mutationCalls.filter(({ name }) => writeOperations.includes(name)).length;
  const beforeReplay = await prisma.importBatch.findFirstOrThrow({ where: { id: batchId, shop }, include: { lines: true, activityLogs: true } });
  const staleCountResume = await action({ request: mergeRequest(batchId, "resume", "yes", "1"), params: { batchId }, context: {} });
  assert.equal(staleCountResume.error, "Confirm the current number of eligible rows and any excluded rows before merging.");
  const resumeResponse = await action({ request: mergeRequest(batchId, "resume", "yes", "0"), params: { batchId }, context: {} });
  const afterResume = mutationCalls.filter(({ name }) => writeOperations.includes(name)).length;
  assert.equal(resumeResponse.mergeProgress?.status, "COMPLETED");
  assert.equal(afterResume, beforeResume);

  // Replaying an already-completed Resume repeatedly must remain a no-op for
  // Shopify writes, persisted line results, and activity history.
  const repeatedResumeResponse = await action({ request: mergeRequest(batchId, "resume", "yes", "0"), params: { batchId }, context: {} });
  const afterRepeatedResume = mutationCalls.filter(({ name }) => writeOperations.includes(name)).length;
  const afterReplay = await prisma.importBatch.findFirstOrThrow({ where: { id: batchId, shop }, include: { lines: true, activityLogs: true } });
  assert.equal(repeatedResumeResponse.mergeProgress?.status, "COMPLETED");
  assert.equal(afterRepeatedResume, beforeResume);
  assert.equal(afterReplay.status, "COMPLETED");
  assert.equal(afterReplay.completedAt?.getTime(), beforeReplay.completedAt?.getTime());
  assert.deepEqual(afterReplay.lines.map(({ id, status, stage, productId, variantId, inventoryItemId }) => ({ id, status, stage, productId, variantId, inventoryItemId })),
    beforeReplay.lines.map(({ id, status, stage, productId, variantId, inventoryItemId }) => ({ id, status, stage, productId, variantId, inventoryItemId })));
  assert.equal(afterReplay.activityLogs.filter(({ eventType }) => eventType === "IMPORT_RESULT").length,
    beforeReplay.activityLogs.filter(({ eventType }) => eventType === "IMPORT_RESULT").length);
  assert.equal(afterReplay.activityLogs.filter(({ eventType }) => eventType === "IMPORT_LINE_RESULT").length,
    beforeReplay.activityLogs.filter(({ eventType }) => eventType === "IMPORT_LINE_RESULT").length);
  assert.equal(afterReplay.activityLogs.filter(({ eventType, outcome }) => eventType === "IMPORT_RESUME" && outcome === "SUCCEEDED").length,
    beforeReplay.activityLogs.filter(({ eventType, outcome }) => eventType === "IMPORT_RESUME" && outcome === "SUCCEEDED").length,
    "completed no-op Resume replays do not create successful execution-history events");
});

test("actual Import History action continues one confirmed 51-row snapshot in bounded chunks without reconfirmation", { skip: !databaseUrl }, async (t) => {
  const { prisma, action } = await setup(t);
  const shop = `http-one-click-${crypto.randomUUID()}.myshopify.com`;
  const batchId = `http-one-click-batch-${crypto.randomUUID()}`;
  const scopes = ["read_products", "read_inventory", "read_locations", "write_inventory"];
  const lineIds = Array.from({ length: 51 }, (_, index) => `http-one-click-line-${crypto.randomUUID()}-${index}`);
  const calls = [];
  await prisma.importBatch.deleteMany({ where: { shop } });
  t.after(async () => prisma.importBatch.deleteMany({ where: { shop } }));
  await prisma.importBatch.create({ data: {
    id: batchId, shop, submissionId: crypto.randomUUID(), receiptCode: `IMP-${crypto.randomUUID()}`,
    fileChecksum: `checksum-${crypto.randomUUID()}`, fileName: "51-lines.csv",
    locationId: "gid://shopify/Location/10", locationName: "Main warehouse", currencyCode: "USD",
    status: "PREVIEWED", revision: 0,
    lines: { create: lineIds.map((id, index) => ({
      id, rowNumber: index + 2, sku: `HTTP-${String(index + 1).padStart(3, "0")}`, title: `HTTP item ${index + 1}`,
      description: "Action-boundary chunk test", price: "10.00", quantity: 2,
      operationType: "ADJUST", status: "PREVIEWED", stage: "PREPARED",
      operationId: `operation-${id}`, idempotencyKey: `key-${id}`,
      productId: "gid://shopify/Product/30", variantId: "gid://shopify/ProductVariant/20",
      inventoryItemId: "gid://shopify/InventoryItem/40", expectedQuantity: 11,
    })) },
  } });

  const admin = makeAdmin({ shop, scopes, calls, skuMatches: true });
  globalThis.__stockhubHttpTest.auth = async () => ({
    session: { shop, userId: 7n, firstName: "Test", lastName: "Merchant", email: "test@example.invalid", accountOwner: true },
    admin,
    scopes: { query: async () => ({ granted: scopes }) },
  });

  // This is the single merchant confirmation. The action returns the first
  // server-bounded chunk and a durable approval identity for client auto-next.
  const initial = await action({ request: mergeRequest(batchId, "merge", "yes", "51"), params: { batchId }, context: {} });
  assert.ok(initial.mergeProgress, JSON.stringify(initial));
  assert.deepEqual(initial.mergeProgress, {
    batchId,
    approvalId: initial.mergeProgress.approvalId,
    approvalStatus: "ACTIVE",
    chunkNumber: 1,
    continueRequired: true,
    status: "PARTIAL",
  });
  assert.ok(initial.mergeProgress.approvalId);
  assert.equal(calls.filter(({ name }) => name === "StockHubAdjustIncoming").length, 50);

  // Match the UI's follow-up POST exactly: no confirmed flag/count or line IDs.
  const continued = await action({
    request: approvalRequest(batchId, "continueMerge", initial.mergeProgress.approvalId),
    params: { batchId },
    context: {},
  });
  assert.equal(continued.mergeProgress.approvalId, initial.mergeProgress.approvalId);
  assert.equal(continued.mergeProgress.approvalStatus, "COMPLETED");
  assert.equal(continued.mergeProgress.chunkNumber, 2);
  assert.equal(continued.mergeProgress.continueRequired, false);
  assert.equal(continued.mergeProgress.status, "COMPLETED");
  assert.equal(calls.filter(({ name }) => name === "StockHubAdjustIncoming").length, 51);
  const approval = await prisma.importMergeApproval.findFirstOrThrow({
    where: { id: initial.mergeProgress.approvalId, shop, batchId },
  });
  assert.equal(approval.processedCount, 51);
  assert.equal(approval.chunkNumber, 2);
  assert.equal(approval.status, "COMPLETED");
  assert.equal(await prisma.importLine.count({ where: { batchId, status: "SUCCEEDED" } }), 51);

  const beforeReplay = calls.filter(({ name }) => name === "StockHubAdjustIncoming").length;
  const replay = await action({
    request: approvalRequest(batchId, "continueMerge", initial.mergeProgress.approvalId),
    params: { batchId },
    context: {},
  });
  assert.equal(replay.mergeProgress.approvalStatus, "COMPLETED");
  assert.equal(calls.filter(({ name }) => name === "StockHubAdjustIncoming").length, beforeReplay,
    "replaying an already completed auto-next request does not repeat Shopify writes");
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
