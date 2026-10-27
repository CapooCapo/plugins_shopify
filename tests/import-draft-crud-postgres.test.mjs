/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const databaseUrl = process.env.STOCKHUB_TEST_DATABASE_URL;
const locationId = "gid://shopify/Location/10";
const scopes = ["read_products", "read_inventory", "read_locations"];

async function setup(t, shop) {
  assert.ok(databaseUrl, "STOCKHUB_TEST_DATABASE_URL must point to a disposable PostgreSQL database");
  const parsed = new URL(databaseUrl);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/stockhub_regression");

  const { PrismaClient } = await import("../node_modules/.prisma/stockhub-pg-test-client/index.js");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  await prisma.$connect();
  const identity = await prisma.$queryRaw`SELECT current_database() AS database, version() AS version`;
  assert.equal(identity[0].database, "stockhub_regression");
  assert.match(identity[0].version, /PostgreSQL 16/i);
  t.after(async () => prisma.$disconnect());

  const calls = [];
  const admin = {
    async graphql(query) {
      const name = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "unknown";
      calls.push({ name, query });
      if (name === "DiagnoseStockHubLocations") {
        return new Response(JSON.stringify({ data: {
          shop: { myshopifyDomain: shop, currencyCode: "USD" },
          currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
          locations: { nodes: [{ id: locationId, name: "Main warehouse", isActive: true }], pageInfo: { hasNextPage: false, endCursor: null } },
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (name === "StockHubImportSkuLookup") {
        return new Response(JSON.stringify({ data: {
          productVariants: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected Shopify Admin operation during draft CRUD: ${name}`);
    },
  };

  globalThis.__stockhubDraftCrudTest = {
    prisma,
    auth: async () => ({
      session: { shop, isOnline: true, userId: 42 },
      admin,
      scopes: { query: async () => ({ granted: scopes }) },
    }),
  };

  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [{
      name: "stockhub-draft-crud-route-test-mocks",
      enforce: "pre",
      resolveId(source) {
        if (source === "../shopify.server") return "\0stockhub-draft-test-shopify.server";
        if (source === "../db.server") return "\0stockhub-draft-test-db.server";
        return null;
      },
      load(id) {
        if (id === "\0stockhub-draft-test-shopify.server") {
          return `export const authenticate = { admin: async (request) => globalThis.__stockhubDraftCrudTest.auth(request) };`;
        }
        if (id === "\0stockhub-draft-test-db.server") {
          return `const prisma = globalThis.__stockhubDraftCrudTest.prisma; export default prisma;`;
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
  return { prisma, action: detailRoute.action, calls };
}

function draftRequest({ batchId, expectedUpdatedAt, intent, lineId, values = {} }) {
  const form = new URLSearchParams({
    intent,
    batchId,
    expectedUpdatedAt: expectedUpdatedAt.toISOString(),
    ...values,
  });
  if (lineId) form.set("lineId", lineId);
  return new Request(`http://localhost/app/imports/history/${batchId}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

async function createDraftBatch(prisma, shop, suffix) {
  const batchId = `draft-crud-${suffix}`;
  return prisma.importBatch.create({
    data: {
      id: batchId,
      shop,
      submissionId: `submission-${suffix}`,
      receiptCode: `IMP-CRUD-${suffix}`,
      fileChecksum: `checksum-${suffix}`,
      fileName: "draft.csv",
      locationId,
      locationName: "Main warehouse",
      currencyCode: "USD",
      status: "PREVIEWED",
    },
  });
}

test("actual Import Draft Add/Edit/Delete actions persist to isolated PostgreSQL and perform read-only validation", { skip: !databaseUrl }, async (t) => {
  const shop = `draft-crud-${crypto.randomUUID()}.myshopify.com`;
  const { prisma, action, calls } = await setup(t, shop);
  t.after(async () => prisma.importBatch.deleteMany({ where: { shop } }));
  const batch = await createDraftBatch(prisma, shop, crypto.randomUUID());
  const args = (request) => ({ request, params: { batchId: batch.id }, context: {} });

  const added = await action(args(draftRequest({
    batchId: batch.id,
    expectedUpdatedAt: batch.updatedAt,
    intent: "draftAddLine",
    values: { sku: "NEW-SKU", quantity: "3", title: "New product", price: "10.00" },
  })));
  assert.equal(added.status, 302, "Add saves the draft row and redirects back to its receipt");
  let saved = await prisma.importBatch.findFirst({ where: { id: batch.id, shop }, include: { lines: true } });
  assert.equal(saved.lines.length, 1);
  assert.equal(saved.lines[0].status, "PREVIEWED");
  assert.equal(saved.lines[0].operationType, "CREATE_DRAFT");
  assert.equal(saved.fileChecksum, batch.fileChecksum, "draft edits do not rewrite original-upload duplicate identity");
  const line = saved.lines[0];
  const originalOperationId = line.operationId;
  const originalIdempotencyKey = line.idempotencyKey;

  const invalidEdit = await action(args(draftRequest({
    batchId: batch.id,
    expectedUpdatedAt: saved.updatedAt,
    intent: "draftEditLine",
    lineId: line.id,
    values: { sku: "NEW-SKU", quantity: "4", title: "", price: "" },
  })));
  assert.equal(invalidEdit.status, 302, "a draft edit saves even when validation blocks the row");
  saved = await prisma.importBatch.findFirst({ where: { id: batch.id, shop }, include: { lines: true } });
  assert.equal(saved.lines[0].status, "BLOCKED");
  assert.equal(saved.lines[0].errorCode, "NEW_PRODUCT_FIELDS_MISSING");
  assert.equal(saved.lines.filter((item) => item.status === "PREVIEWED").length, 0);
  assert.equal(saved.lines.filter((item) => item.status === "BLOCKED").length, 1);

  const validEdit = await action(args(draftRequest({
    batchId: batch.id,
    expectedUpdatedAt: saved.updatedAt,
    intent: "draftEditLine",
    lineId: line.id,
    values: { sku: "NEW-SKU", quantity: "4", title: "Corrected product", price: "12.50" },
  })));
  assert.equal(validEdit.status, 302);
  saved = await prisma.importBatch.findFirst({ where: { id: batch.id, shop }, include: { lines: true } });
  assert.equal(saved.lines[0].status, "PREVIEWED", "valid edit clears the previous validation error");
  assert.equal(saved.lines[0].title, "Corrected product");
  assert.equal(saved.lines[0].quantity, 4);
  assert.equal(saved.lines[0].operationId, originalOperationId);
  assert.equal(saved.lines[0].idempotencyKey, originalIdempotencyKey);

  const deleted = await action(args(draftRequest({
    batchId: batch.id,
    expectedUpdatedAt: saved.updatedAt,
    intent: "draftDeleteLine",
    lineId: line.id,
  })));
  assert.equal(deleted.status, 302, "Delete persists and redirects back to receipt");
  assert.equal(await prisma.importLine.count({ where: { batchId: batch.id } }), 0);
  const events = await prisma.activityLog.findMany({ where: { shop, importBatchId: batch.id }, orderBy: { occurredAt: "asc" } });
  assert.equal(events.length, 4, "Add/Edit/Edit/Delete each append an activity event");
  assert.ok(events.every((event) => event.eventType === "IMPORT_DRAFT_LINE_EDITED" && event.outcome === "SUCCEEDED"));
  assert.ok(events.every((event) => event.actorType === "SHOPIFY_USER" && event.actorId === "42"));
  assert.ok(calls.length > 0, "draft revalidation reads the authorized location and SKU match state");
  assert.ok(calls.every((call) => !/^\s*mutation\b/.test(call.query)), "draft CRUD must not execute any Shopify write mutation");
});

test("actual Import Draft action rejects cross-shop, locked-state, and stale-version writes", { skip: !databaseUrl }, async (t) => {
  const shop = `draft-guards-${crypto.randomUUID()}.myshopify.com`;
  const otherShop = `other-${crypto.randomUUID()}.myshopify.com`;
  const { prisma, action, calls } = await setup(t, shop);
  t.after(async () => prisma.importBatch.deleteMany({ where: { shop: { in: [shop, otherShop] } } }));
  const batch = await createDraftBatch(prisma, shop, crypto.randomUUID());
  const line = await prisma.importLine.create({ data: {
    id: `draft-guard-line-${crypto.randomUUID()}`,
    batchId: batch.id,
    rowNumber: 2,
    sku: "GUARD-SKU",
    title: "Guard product",
    price: "10.00",
    quantity: 1,
    operationType: "CREATE_DRAFT",
    status: "PREVIEWED",
    stage: "PREPARED",
    operationId: `draft-guard-op-${crypto.randomUUID()}`,
    idempotencyKey: `draft-guard-key-${crypto.randomUUID()}`,
  } });

  globalThis.__stockhubDraftCrudTest.auth = async () => ({
    session: { shop: otherShop },
    admin: { graphql: async () => { throw new Error("Cross-tenant write must not call Shopify"); } },
    scopes: { query: async () => ({ granted: scopes }) },
  });
  const wrongShop = await action({ request: draftRequest({ batchId: batch.id, expectedUpdatedAt: batch.updatedAt, intent: "draftEditLine", lineId: line.id, values: { sku: line.sku, quantity: "2", title: "Wrong tenant", price: "10.00" } }), params: { batchId: batch.id }, context: {} });
  assert.match(wrongShop.error, /not found in the authenticated store/);

  globalThis.__stockhubDraftCrudTest.auth = async () => ({
    session: { shop },
    admin: { graphql: async () => { throw new Error("Locked or stale draft must not call Shopify"); } },
    scopes: { query: async () => ({ granted: scopes }) },
  });
  await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "RUNNING", updatedAt: new Date(batch.updatedAt.getTime() + 1_000) } });
  const locked = await action({ request: draftRequest({ batchId: batch.id, expectedUpdatedAt: batch.updatedAt, intent: "draftDeleteLine", lineId: line.id }), params: { batchId: batch.id }, context: {} });
  assert.match(locked.error, /locked because Shopify processing has started/);
  await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "PREVIEWED", updatedAt: new Date(batch.updatedAt.getTime() + 2_000) } });
  const current = await prisma.importBatch.findUnique({ where: { id: batch.id } });
  const stale = await action({ request: draftRequest({ batchId: batch.id, expectedUpdatedAt: batch.updatedAt, intent: "draftDeleteLine", lineId: line.id }), params: { batchId: batch.id }, context: {} });
  assert.match(stale.error, /changed in another tab/);
  const unchanged = await prisma.importLine.findUnique({ where: { id: line.id } });
  assert.equal(unchanged.status, "PREVIEWED");
  assert.ok(current.updatedAt.getTime() > batch.updatedAt.getTime());
  assert.equal(calls.length, 0, "rejected tenant/state/version requests do not call Shopify");
});
