/* eslint-env node */
/* global globalThis */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createServer } from "vite";

const schema = await readFile(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const reviewModel = schema.match(/model CatalogImportReview\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
const databaseUrl = process.env.STOCKHUB_TEST_DATABASE_URL;
const integrationSkip = !databaseUrl
  ? "requires the explicitly configured disposable loopback PostgreSQL database"
  : !reviewModel
    ? "requires CatalogImportReview in the Prisma schema"
    : false;

test("Prisma declares the proposed tenant-scoped, versioned catalog review record", () => {
  assert.ok(reviewModel, "Expected Prisma model CatalogImportReview for persisted catalog reviews");
  for (const field of [
    "id", "shop", "batchId", "groupId", "draftVersion", "reviewVersion", "operation", "status",
    "snapshotFingerprint", "snapshot", "shopifyProductId", "matchedVariantIds", "decisions", "snapshotCapturedAt",
    "reviewedAt", "createdAt", "updatedAt",
  ]) {
    assert.match(reviewModel, new RegExp("^\\s*" + field + "\\s+", "m"), "CatalogImportReview is missing " + field);
  }
  assert.match(reviewModel, /@@unique\(\[shop,\s*batchId,\s*groupId,\s*draftVersion\]\)/);
  assert.match(reviewModel, /@@index\(\[shop,\s*batchId,\s*draftVersion,\s*status\]\)/);
});

async function setup(t) {
  assert.ok(databaseUrl, "STOCKHUB_TEST_DATABASE_URL must point to the disposable local PostgreSQL database");
  const { validateTestDatabaseUrls, validateDatabaseIdentity } = await import("../scripts/postgres-test-guard.mjs");
  const { url, parsed } = validateTestDatabaseUrls(process.env);
  const { PrismaClient } = await import("../node_modules/.prisma/stockhub-pg-test-client/index.js");
  const prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.$connect();
  let cleanupShop;
  let cleanupBatchId;
  t.after(async () => {
    try {
      if (cleanupShop && cleanupBatchId) {
        await prisma.catalogExecutionOperation.deleteMany({ where: { shop: cleanupShop, batchId: cleanupBatchId } });
        await prisma.catalogImportReviewHistory.deleteMany({ where: { shop: cleanupShop, batchId: cleanupBatchId } });
        await prisma.catalogImportReview.deleteMany({ where: { shop: cleanupShop, batchId: cleanupBatchId } });
        await prisma.catalogImportBatch.deleteMany({ where: { shop: cleanupShop, id: cleanupBatchId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });
  const identityRows = await prisma.$queryRaw`SELECT current_database() AS database, current_user AS "user", inet_server_addr()::text AS address, inet_client_addr()::text AS "clientAddress", inet_server_port() AS port, version() AS version`;
  const identity = validateDatabaseIdentity(identityRows[0] ?? {}, parsed);
  assert.equal(identity.database, "stockhub_regression");
  assert.match(identityRows[0].version, /PostgreSQL 16/i);
  assert.equal(typeof prisma.catalogImportReview?.findFirst, "function", "generated Prisma Client must expose CatalogImportReview");

  let authenticatedShop = "review-" + randomUUID() + ".myshopify.com";
  const shop = authenticatedShop;
  const batchId = randomUUID();
  const groupId = randomUUID();
  const lineId = randomUUID();
  cleanupShop = shop;
  cleanupBatchId = batchId;
  const calls = [];
  let shopifySnapshot = {
    id: "gid://shopify/ProductVariant/1",
    sku: "REVIEW-1",
    price: "10.00",
    selectedOptions: [{ name: "Size", value: "M" }],
    product: {
      id: "gid://shopify/Product/1",
      title: "Review Shirt",
      descriptionHtml: "Current description",
      vendor: "Current vendor",
      productType: "Shirt",
      options: [{ name: "Size", values: ["M"] }],
    },
  };
  globalThis.__stockhubCatalogReviewTest = {
    prisma,
    auth: async () => ({
      session: { shop: authenticatedShop },
      scopes: { query: async () => ({ granted: ["read_products"] }) },
      admin: {
        graphql: async (query, options) => {
          calls.push({ query, options });
          assert.match(query, /^\s*#graphql\s*query/i, "catalog review may use only mocked read-only Shopify queries");
          assert.doesNotMatch(query, /\bmutation\b/i);
          return Response.json({ data: {
            shop: { myshopifyDomain: authenticatedShop },
            productVariants: {
              nodes: [structuredClone(shopifySnapshot)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          } });
        },
      },
    }),
  };
  t.after(() => { delete globalThis.__stockhubCatalogReviewTest; });

  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [{
      name: "stockhub-catalog-review-route-test-mocks",
      enforce: "pre",
      resolveId(source) {
        if (source === "../shopify.server") return "\0stockhub-catalog-review-test-shopify.server";
        if (source === "../db.server") return "\0stockhub-catalog-review-test-db.server";
        return null;
      },
      load(id) {
        if (id === "\0stockhub-catalog-review-test-shopify.server") return "export const authenticate = { admin: async (request) => globalThis.__stockhubCatalogReviewTest.auth(request) };";
        if (id === "\0stockhub-catalog-review-test-db.server") return "const prisma = globalThis.__stockhubCatalogReviewTest.prisma; export default prisma;";
        return null;
      },
    }],
    server: { middlewareMode: true, hmr: false },
    ssr: { noExternal: ["@shopify/shopify-app-react-router"] },
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    logLevel: "error",
  });
  t.after(async () => vite.close());
  const route = await vite.ssrLoadModule("/app/routes/app.imports.catalog.$batchId.tsx");
  assert.equal(typeof route.action, "function");
  assert.equal(typeof route.loader, "function");

  await prisma.catalogImportBatch.create({ data: {
    id: batchId,
    shop,
    fileName: "review.csv",
    fileChecksum: "a".repeat(64),
    originalCsv: "Product Name,SKU,Price\nReview Shirt,REVIEW-1,12.50\n",
    sourceHeaders: ["Product Name", "SKU", "Price"],
    mapping: { "0": "productName", "1": "sku", "2": "price" },
    status: "DRAFT",
    draftVersion: 4,
  } });
  await prisma.catalogImportGroup.create({ data: {
    id: groupId,
    shop,
    batchId,
    source: "productName",
    groupingKey: "review shirt",
    reason: "Test product group",
    selections: { productName: { value: "Review Shirt", sourceLineId: lineId } },
    validation: [],
    confirmedAt: new Date("2026-10-20T10:00:00.000Z"),
    state: "ACTIVE",
  } });
  await prisma.catalogImportLine.create({ data: {
    id: lineId,
    shop,
    batchId,
    rowNumber: 1,
    sourceRowNumber: 2,
    sourceValues: ["Review Shirt", "REVIEW-1", "12.50"],
    productName: "Review Shirt",
    sku: "REVIEW-1",
    price: "12.50",
    status: "READY",
    errors: [],
    groupId,
  } });
  return {
    prisma,
    shop,
    calls,
    batchId,
    groupId,
    lineId,
    setAuthenticatedShop(value) { authenticatedShop = value; },
    setShopifySnapshot(patch) { shopifySnapshot = { ...shopifySnapshot, ...patch }; },
    action: route.action,
    loader: route.loader,
  };
}

function requestFor(batchId, values = {}) {
  const form = new URLSearchParams(values);
  return new Request("http://localhost/app/imports/catalog/" + batchId, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

function compareRequest(batchId, draftVersion) {
  return requestFor(batchId, { intent: "compare-shopify", draftVersion: String(draftVersion), warnMissingImage: "0" });
}

function reviewRequest(batchId, { intent = "save-review", draftVersion, groupId, reviewVersion, decisions }) {
  return requestFor(batchId, {
    intent,
    draftVersion: String(draftVersion),
    groupId,
    reviewVersion: String(reviewVersion),
    ...(decisions ? { decisions: JSON.stringify(decisions) } : {}),
  });
}

function decisionsFor(lineId, patch = {}) {
  return {
    schemaVersion: 1,
    group: "CONFIRM",
    productFields: { title: "KEEP_SHOPIFY", description: "KEEP_SHOPIFY", vendor: "KEEP_SHOPIFY", productType: "KEEP_SHOPIFY" },
    variants: {
      [lineId]: {
        operation: "UPDATE",
        fields: { sku: "KEEP_SHOPIFY", price: "USE_CSV", size: "KEEP_SHOPIFY", color: "KEEP_SHOPIFY", ...patch },
      },
    },
  };
}

async function actionFor(action, batchId, request) {
  return action({ request, params: { batchId }, context: {} });
}

async function compareAndLoadReview(ctx) {
  const response = await actionFor(ctx.action, ctx.batchId, compareRequest(ctx.batchId, 4));
  assert.ok(response.compareResult, "Compare should return the read-only comparison result");
  const review = await ctx.prisma.catalogImportReview.findFirst({ where: { shop: ctx.shop, batchId: ctx.batchId, groupId: ctx.groupId, draftVersion: 4 } });
  return { response, review };
}

test("comparison persists a complete review snapshot and fingerprint that the authenticated loader can reload", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const { response, review } = await compareAndLoadReview(ctx);
  assert.ok(review, "server-side Shopify comparison must persist a CatalogImportReview before returning");
  assert.equal(review.shop, ctx.shop);
  assert.equal(review.batchId, ctx.batchId);
  assert.equal(review.groupId, ctx.groupId);
  assert.equal(review.draftVersion, 4);
  assert.equal(review.reviewVersion, 0);
  assert.equal(review.operation, "UPDATE");
  assert.equal(review.status, "PENDING");
  assert.equal(review.snapshotFingerprint, response.compareResult.fingerprint);
  assert.match(review.snapshotFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(review.shopifyProductId, "gid://shopify/Product/1");
  assert.deepEqual(review.matchedVariantIds, ["gid://shopify/ProductVariant/1"]);
  const snapshotVariants = Array.isArray(review.snapshot) ? review.snapshot : review.snapshot?.variants;
  assert.deepEqual(snapshotVariants?.map((variant) => variant.id), ["gid://shopify/ProductVariant/1"]);
  assert.ok(review.snapshotCapturedAt instanceof Date);
  assert.equal(ctx.calls.length, 1);
  assert.ok(ctx.calls.every(({ query }) => !/\bmutation\b/i.test(query)));

  const loaded = await ctx.loader({ request: new Request("http://localhost/app/imports/catalog/" + ctx.batchId), params: { batchId: ctx.batchId }, context: {} });
  const reloaded = loaded.groups.find((group) => group.id === ctx.groupId)?.reviewRecords?.find((record) => record.id === review.id);
  assert.ok(reloaded, "a fresh authenticated loader read must include the persisted review record");
  assert.equal(reloaded.snapshotFingerprint, review.snapshotFingerprint);
});

test("field decisions save server-side, survive reload, remain tenant-scoped, and never invoke Shopify writes", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const { review } = await compareAndLoadReview(ctx);
  assert.ok(review, "comparison must create the review before merchant decisions can be saved");
  const decisions = decisionsFor(ctx.lineId);
  const saved = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 0, decisions }));
  assert.equal(saved.status, 302);
  const persisted = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.equal(persisted.reviewVersion, 1);
  assert.deepEqual(persisted.decisions, decisions);
  assert.equal((await ctx.prisma.catalogImportBatch.findFirstOrThrow({ where: { shop: ctx.shop, id: ctx.batchId } })).draftVersion, 4, "saving review decisions does not alter the catalog draft version");
  const reloaded = await ctx.loader({ request: new Request("http://localhost/app/imports/catalog/" + ctx.batchId), params: { batchId: ctx.batchId }, context: {} });
  const loadedReview = reloaded.groups.find((group) => group.id === ctx.groupId)?.reviewRecords?.find((record) => record.id === review.id);
  assert.deepEqual(loadedReview?.decisions, decisions);

  const otherShop = "other-review-" + randomUUID() + ".myshopify.com";
  ctx.setAuthenticatedShop(otherShop);
  await assert.rejects(
    ctx.loader({ request: new Request("http://localhost/app/imports/catalog/" + ctx.batchId), params: { batchId: ctx.batchId }, context: {} }),
    (error) => error instanceof Response && error.status === 404,
    "a different authenticated shop cannot read the review or its snapshot",
  );
  const crossShopWrite = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 1, decisions: decisionsFor(ctx.lineId, { price: "KEEP_SHOPIFY" }) }));
  assert.match(crossShopWrite.error ?? "", /not found/i);
  assert.equal(await ctx.prisma.catalogImportReview.count({ where: { shop: otherShop, batchId: ctx.batchId } }), 0);
  assert.equal(ctx.calls.length, 1, "decision persistence and tenant checks do not call Shopify again");
});

test("stale draft versions cannot update an otherwise current review", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const { review } = await compareAndLoadReview(ctx);
  assert.ok(review);
  await ctx.prisma.catalogImportBatch.update({ where: { id: ctx.batchId }, data: { draftVersion: 5 } });
  const result = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 0, decisions: decisionsFor(ctx.lineId) }));
  assert.match(result.error ?? "", /changed|stale|version/i);
  const unchanged = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.equal(unchanged.reviewVersion, 0);
  assert.equal(unchanged.status, "PENDING");
});

test("reviewVersion compare-and-swap admits only one concurrent write from the same version", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const { review } = await compareAndLoadReview(ctx);
  assert.ok(review);
  const first = decisionsFor(ctx.lineId, { price: "USE_CSV" });
  const second = decisionsFor(ctx.lineId, { price: "KEEP_SHOPIFY" });
  const results = await Promise.all([
    actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 0, decisions: first })),
    actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 0, decisions: second })),
  ]);
  const winnerIndex = results.findIndex((result) => result.status === 302);
  assert.equal(results.filter((result) => result.status === 302).length, 1, "exactly one write with the expected reviewVersion must win");
  assert.equal(results.filter((result) => /review|version|stale|changed/i.test(result.error ?? "")).length, 1, "the stale concurrent write must be rejected");
  const current = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.equal(current.reviewVersion, 1);
  assert.deepEqual(current.decisions, winnerIndex === 0 ? first : second, "persisted JSONB decisions structurally match the winning write");
  assert.equal((await ctx.prisma.catalogImportBatch.findFirstOrThrow({ where: { shop: ctx.shop, id: ctx.batchId } })).draftVersion, 4);
});

test("valid saved decisions may be explicitly confirmed without changing the draft or writing to Shopify", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const { review } = await compareAndLoadReview(ctx);
  assert.ok(review);
  const decisions = decisionsFor(ctx.lineId);
  const saved = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 0, decisions }));
  assert.equal(saved.status, 302);

  const pending = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.reviewVersion, 1);
  assert.equal(pending.reviewedAt, null);
  assert.deepEqual(pending.decisions, decisions);

  const confirmed = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { intent: "confirm-review", draftVersion: 4, groupId: ctx.groupId, reviewVersion: 1 }));
  assert.equal(confirmed.status, 302, "confirmation is a separate explicit action after saving decisions");
  const persisted = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.equal(persisted.status, "CONFIRMED");
  assert.equal(persisted.reviewVersion, 2);
  assert.ok(persisted.reviewedAt instanceof Date);
  assert.equal(persisted.draftVersion, 4);
  assert.deepEqual(persisted.decisions, decisions);
  assert.equal((await ctx.prisma.catalogImportBatch.findFirstOrThrow({ where: { shop: ctx.shop, id: ctx.batchId } })).draftVersion, 4, "review confirmation does not advance the catalog draft version");
  assert.equal(ctx.calls.length, 2, "confirmation must re-read the Shopify snapshot before accepting the saved review");
  assert.ok(ctx.calls.every(({ query }) => !/\bmutation\b/i.test(query)));
});

test("confirmation rejects and invalidates a review when the Shopify snapshot changed after comparison", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const { review } = await compareAndLoadReview(ctx);
  assert.ok(review);
  const decisions = decisionsFor(ctx.lineId);
  const saved = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 0, decisions }));
  assert.equal(saved.status, 302);

  ctx.setShopifySnapshot({ price: "11.00" });
  const result = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { intent: "confirm-review", draftVersion: 4, groupId: ctx.groupId, reviewVersion: 1 }));
  assert.match(result.error ?? "", /stale|changed|compare again|snapshot/i,
    "confirmation must reject approval against a changed Shopify snapshot");

  const invalidated = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.equal(invalidated.status, "STALE", "a changed Shopify snapshot must persist review invalidation");
  assert.notEqual(invalidated.status, "CONFIRMED");
  assert.equal(invalidated.reviewedAt, null);
  assert.deepEqual(invalidated.decisions, decisions, "stale rejection preserves the merchant's saved choices for re-review");
  const invalidatedHistory = await ctx.prisma.catalogImportReviewHistory.findFirst({
    where: { shop: ctx.shop, batchId: ctx.batchId, groupId: ctx.groupId, id: review.id, reviewVersion: 1 },
  });
  assert.ok(invalidatedHistory, "confirmation-time invalidation must archive the exact saved version before advancing its version");
  assert.equal(invalidatedHistory.status, "PENDING");
  assert.equal(invalidatedHistory.snapshotFingerprint, review.snapshotFingerprint);
  assert.deepEqual(invalidatedHistory.decisions, decisions);
  assert.equal(ctx.calls.length, 2, "confirmation must issue a fresh read after the initial compare");
  assert.ok(ctx.calls.every(({ query }) => /^\s*#graphql\s*query/i.test(query) && !/\bmutation\b/i.test(query)),
    "staleness verification must remain read-only");
});

test("an authenticated save request cannot change a STALE review", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const { review } = await compareAndLoadReview(ctx);
  assert.ok(review);
  const decisions = decisionsFor(ctx.lineId);
  const saved = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 0, decisions }));
  assert.equal(saved.status, 302);

  ctx.setShopifySnapshot({ price: "11.00" });
  const rejectedConfirmation = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { intent: "confirm-review", draftVersion: 4, groupId: ctx.groupId, reviewVersion: 1 }));
  assert.match(rejectedConfirmation.error ?? "", /stale|changed|compare again|snapshot/i);
  const staleBeforeSave = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.equal(staleBeforeSave.status, "STALE");
  assert.deepEqual(staleBeforeSave.decisions, decisions);

  const rejectedSave = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, {
    intent: "save-review",
    draftVersion: 4,
    groupId: ctx.groupId,
    reviewVersion: staleBeforeSave.reviewVersion,
    decisions,
  }));
  assert.match(rejectedSave.error ?? "", /stale|compare again/i,
    "a direct authenticated save against a STALE review must be rejected");

  const staleAfterSave = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.equal(staleAfterSave.status, "STALE");
  assert.equal(staleAfterSave.reviewVersion, staleBeforeSave.reviewVersion);
  assert.deepEqual(staleAfterSave.decisions, decisions, "a rejected save leaves the stale review state and choices unchanged");
  assert.equal(ctx.calls.length, 2, "the save rejection must not make an additional Shopify request");
});

test("a changed re-comparison preserves prior review state as tenant-scoped immutable history", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const { review: originalReview } = await compareAndLoadReview(ctx);
  assert.ok(originalReview);
  const decisions = decisionsFor(ctx.lineId);
  const saved = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 0, decisions }));
  assert.equal(saved.status, 302);
  const firstConfirmed = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { intent: "confirm-review", draftVersion: 4, groupId: ctx.groupId, reviewVersion: 1 }));
  assert.equal(firstConfirmed.status, 302);
  const prior = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: originalReview.id, shop: ctx.shop } });
  const priorSnapshot = structuredClone(prior.snapshot);
  assert.equal(prior.status, "CONFIRMED");
  assert.equal(prior.reviewVersion, 2);
  assert.deepEqual(prior.decisions, decisions);
  const oldOperationId = randomUUID();
  await ctx.prisma.catalogExecutionOperation.create({ data: {
    id: oldOperationId, shop: ctx.shop, batchId: ctx.batchId, groupId: ctx.groupId,
    reviewId: prior.id, draftVersion: prior.draftVersion, reviewVersion: prior.reviewVersion,
    snapshotFingerprint: prior.snapshotFingerprint, idempotencyKey: "recompare-old-" + randomUUID(),
    plan: "UPDATE", status: "SUCCEEDED", planJson: { disposition: "UPDATE", items: [] },
  } });

  ctx.setShopifySnapshot({ price: "11.00" });
  const recomparison = await actionFor(ctx.action, ctx.batchId, compareRequest(ctx.batchId, 4));
  assert.ok(recomparison.compareResult, "changed Shopify data should produce a fresh comparison");
  const loaded = await ctx.loader({ request: new Request("http://localhost/app/imports/catalog/" + ctx.batchId), params: { batchId: ctx.batchId }, context: {} });
  const loadedGroup = loaded.groups.find((item) => item.id === ctx.groupId);
  const history = loadedGroup?.reviewRecords ?? [];
  assert.ok(history.every((record) => record.shop === ctx.shop), "loaded review history must remain scoped to the authenticated shop");

  const otherShop = "other-history-" + randomUUID() + ".myshopify.com";
  ctx.setAuthenticatedShop(otherShop);
  await assert.rejects(
    ctx.loader({ request: new Request("http://localhost/app/imports/catalog/" + ctx.batchId), params: { batchId: ctx.batchId }, context: {} }),
    (error) => error instanceof Response && error.status === 404,
    "another tenant cannot read the catalog review history",
  );
  ctx.setAuthenticatedShop(ctx.shop);

  const historical = history.find((record) => record.id === prior.id && record.snapshotFingerprint === prior.snapshotFingerprint && record.reviewVersion === prior.reviewVersion);
  assert.ok(historical, "re-comparison must retain the previous review as a retrievable historical record instead of overwriting it");
  assert.equal(historical.status, prior.status);
  assert.deepEqual(historical.decisions, prior.decisions);
  assert.deepEqual(historical.snapshot, priorSnapshot);

  const current = history.find((record) => record.snapshotFingerprint !== prior.snapshotFingerprint);
  assert.ok(current, "re-comparison must expose a separate review for the changed Shopify snapshot");
  assert.equal(current.status, "PENDING", "the new current review must require fresh merchant review");
  assert.notDeepEqual(current.decisions, decisions, "the new current review must not inherit decisions from the old snapshot");
  assert.equal(current.id, prior.id, "the stable logical review ID is disambiguated by the immutable reviewVersion");
  assert.equal(current.reviewVersion, prior.reviewVersion + 1);

  const firstOperation = await ctx.prisma.catalogExecutionOperation.findFirstOrThrow({ where: { shop: ctx.shop, id: oldOperationId } });
  assert.equal(firstOperation.reviewId, prior.id);
  assert.equal(firstOperation.reviewVersion, prior.reviewVersion);
  assert.equal(firstOperation.snapshotFingerprint, prior.snapshotFingerprint,
    "the old operation remains attributed to its original fingerprint after re-comparison");

  const savedCurrent = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, {
    intent: "save-review", draftVersion: 4, groupId: ctx.groupId, reviewVersion: current.reviewVersion, decisions,
  }));
  assert.equal(savedCurrent.status, 302);
  const beforeCurrentConfirmation = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { shop: ctx.shop, id: prior.id } });
  const confirmedCurrent = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, {
    intent: "confirm-review", draftVersion: 4, groupId: ctx.groupId, reviewVersion: beforeCurrentConfirmation.reviewVersion,
  }));
  assert.equal(confirmedCurrent.status, 302);
  const currentReview = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { shop: ctx.shop, id: prior.id } });
  assert.equal(currentReview.status, "CONFIRMED");
  const newOperationId = randomUUID();
  await ctx.prisma.catalogExecutionOperation.create({ data: {
    id: newOperationId, shop: ctx.shop, batchId: ctx.batchId, groupId: ctx.groupId,
    reviewId: currentReview.id, draftVersion: currentReview.draftVersion, reviewVersion: currentReview.reviewVersion,
    snapshotFingerprint: currentReview.snapshotFingerprint, idempotencyKey: "recompare-new-" + randomUUID(),
    plan: "UPDATE", status: "READY", planJson: { disposition: "UPDATE", items: [] },
  } });

  const reloaded = await ctx.loader({ request: new Request("http://localhost/app/imports/catalog/" + ctx.batchId), params: { batchId: ctx.batchId }, context: {} });
  const reloadedGroup = reloaded.groups.find((item) => item.id === ctx.groupId);
  const operations = reloadedGroup?.executionOperations ?? [];
  assert.equal(operations.length, 2, "the database accepts one retained operation for each confirmed review version");
  assert.ok(operations.some((operation) => operation.id === oldOperationId && operation.reviewVersion === prior.reviewVersion && operation.snapshotFingerprint === prior.snapshotFingerprint));
  assert.ok(operations.some((operation) => operation.id === newOperationId && operation.reviewVersion === currentReview.reviewVersion && operation.snapshotFingerprint === currentReview.snapshotFingerprint));
  const routeSource = await readFile(new URL("../app/routes/app.imports.catalog.$batchId.tsx", import.meta.url), "utf8");
  const executionLookup = routeSource.match(/const execution = activeGroup\?\.executionOperations\.find\([^\n]+/)?.[0] ?? "";
  assert.match(executionLookup, /candidate\.reviewId === proposal\.reviewId && candidate\.reviewVersion === proposal\.reviewVersion/,
    "UI execution status is selected by both stable review ID and version, never by the previous operation alone");

  const archivedAgain = reloadedGroup?.reviewRecords.find((record) => record.id === prior.id && record.reviewVersion === prior.reviewVersion);
  assert.ok(archivedAgain, "the first approved version remains available after creating a second operation");
  assert.equal(archivedAgain.effectiveStatus, "STALE");
  assert.equal(archivedAgain.status, prior.status);
  assert.deepEqual(archivedAgain.decisions, prior.decisions);
  assert.equal(ctx.calls.length, 4);
  assert.ok(ctx.calls.every(({ query }) => /^\s*#graphql\s*query/i.test(query) && !/\bmutation\b/i.test(query)));
});

test("an old review cannot be confirmed after the catalog draft version advances", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const { review } = await compareAndLoadReview(ctx);
  assert.ok(review);
  const decisions = decisionsFor(ctx.lineId);
  const saved = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 0, decisions }));
  assert.equal(saved.status, 302);
  await ctx.prisma.catalogImportBatch.update({ where: { id: ctx.batchId }, data: { draftVersion: 5 } });

  const result = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { intent: "confirm-review", draftVersion: 4, groupId: ctx.groupId, reviewVersion: 1 }));
  assert.match(result.error ?? "", /changed|stale|version/i);
  const unchanged = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.equal(unchanged.draftVersion, 4);
  assert.equal(unchanged.status, "PENDING");
  assert.equal(unchanged.reviewVersion, 1);
  assert.equal(unchanged.reviewedAt, null);
  assert.deepEqual(unchanged.decisions, decisions, "stale confirmation leaves the saved review decisions intact");
  assert.equal((await ctx.prisma.catalogImportBatch.findFirstOrThrow({ where: { shop: ctx.shop, id: ctx.batchId } })).draftVersion, 5);
  assert.equal(ctx.calls.length, 1, "stale confirmation must not issue another Shopify request");
});

test("draft deletion is refused while review history exists and the review foreign key restricts deletion", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const { review } = await compareAndLoadReview(ctx);
  assert.ok(review);

  const result = await actionFor(ctx.action, ctx.batchId, requestFor(ctx.batchId, { intent: "delete-batch", draftVersion: "4" }));
  assert.match(result.error ?? "", /review|history|cannot be deleted/i);
  assert.equal(await ctx.prisma.catalogImportBatch.count({ where: { shop: ctx.shop, id: ctx.batchId } }), 1, "the route must retain the draft when review history exists");
  assert.equal(await ctx.prisma.catalogImportReview.count({ where: { id: review.id, shop: ctx.shop } }), 1, "the route refusal must preserve its review record");

  await assert.rejects(
    ctx.prisma.catalogImportBatch.delete({ where: { id: ctx.batchId } }),
    (error) => error?.code === "P2003",
    "the review-to-group RESTRICT foreign key also prevents bypassing the route guard",
  );
  assert.equal(await ctx.prisma.catalogImportBatch.count({ where: { shop: ctx.shop, id: ctx.batchId } }), 1);
  assert.equal(await ctx.prisma.catalogImportReview.count({ where: { id: review.id, shop: ctx.shop } }), 1);
});

test("unresolved group conflicts cannot be confirmed", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const snapshot = [{ id: "gid://shopify/ProductVariant/fixture", sku: "REVIEW-1", price: "10.00" }];
  const review = await ctx.prisma.catalogImportReview.create({ data: {
    id: randomUUID(), shop: ctx.shop, batchId: ctx.batchId, groupId: ctx.groupId,
    draftVersion: 4, reviewVersion: 0, operation: "CONFLICT", status: "PENDING",
    snapshotFingerprint: "b".repeat(64), snapshot, shopifyProductId: null,
    matchedVariantIds: [], decisions: decisionsFor(ctx.lineId),
  } });
  await ctx.prisma.catalogImportGroup.update({ where: { id: ctx.groupId }, data: { validation: [{ code: "PRODUCT_FIELD_CONFLICT", message: "Choose a product field value", field: "vendor", lineIds: [ctx.lineId] }] } });
  const result = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { intent: "confirm-review", draftVersion: 4, groupId: ctx.groupId, reviewVersion: 0 }));
  assert.match(result.error ?? "", /conflict|resolve|validation|review/i);
  const unchanged = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.notEqual(unchanged.status, "CONFIRMED");
  assert.equal(unchanged.reviewVersion, 0);
  assert.equal(unchanged.reviewedAt, null);
  assert.equal(ctx.calls.length, 0, "confirmation validation must not send Shopify requests");
});

test("empty or unmapped fields preserve Shopify values and CLEAR decisions are rejected", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const { review } = await compareAndLoadReview(ctx);
  assert.ok(review);
  const preserve = {
    schemaVersion: 1,
    group: "CONFIRM",
    productFields: { title: "KEEP_SHOPIFY", description: "KEEP_SHOPIFY", vendor: "KEEP_SHOPIFY", productType: "KEEP_SHOPIFY" },
    variants: { [ctx.lineId]: { operation: "UPDATE", fields: { sku: "KEEP_SHOPIFY", price: "KEEP_SHOPIFY", size: "KEEP_SHOPIFY", color: "KEEP_SHOPIFY" } } },
  };
  const saved = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 0, decisions: preserve }));
  assert.equal(saved.status, 302);
  let persisted = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.deepEqual(persisted.decisions, preserve);
  assert.doesNotMatch(JSON.stringify(persisted.decisions), /CLEAR/i);

  const explicitClear = decisionsFor(ctx.lineId, { price: "CLEAR" });
  const rejected = await actionFor(ctx.action, ctx.batchId, reviewRequest(ctx.batchId, { draftVersion: 4, groupId: ctx.groupId, reviewVersion: 1, decisions: explicitClear }));
  assert.match(rejected.error ?? "", /decision|clear|invalid|unsupported/i);
  persisted = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { id: review.id, shop: ctx.shop } });
  assert.equal(persisted.reviewVersion, 1);
  assert.deepEqual(persisted.decisions, preserve, "a rejected CLEAR cannot overwrite persisted KEEP_SHOPIFY choices");
});
