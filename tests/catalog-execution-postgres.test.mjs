/* eslint-env node */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";

const schema = await readFile(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const reviewVersionMigration = await readFile(new URL("../prisma/migrations/20261028220000_catalog_execution_review_versions/migration.sql", import.meta.url), "utf8");
const databaseUrl = process.env.STOCKHUB_TEST_DATABASE_URL;
const integrationSkip = !databaseUrl ? "requires the explicitly configured disposable loopback PostgreSQL database" : false;

test("Prisma schema declares tenant-scoped catalog execution history and uniqueness constraints", () => {
  const operation = schema.match(/model CatalogExecutionOperation\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  const item = schema.match(/model CatalogExecutionItem\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  const attempt = schema.match(/model CatalogExecutionAttempt\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(operation && item && attempt);
  for (const field of ["shop", "batchId", "groupId", "reviewId", "draftVersion", "reviewVersion", "snapshotFingerprint", "idempotencyKey", "planJson", "status"]) {
    assert.match(operation, new RegExp("^\\s*" + field + "\\s+", "m"));
  }
  assert.match(operation, /@@unique\(\[shop,\s*reviewId,\s*reviewVersion\]\)/,
    "the same logical review can retain one execution per immutable review version");
  assert.match(operation, /@@unique\(\[shop,\s*idempotencyKey\]\)/);
  assert.match(operation, /onDelete:\s*Restrict/);
  assert.match(operation, /onUpdate:\s*Restrict/,
    "execution history must not cascade onto a replacement review identity");
  assert.match(reviewVersionMigration, /CREATE UNIQUE INDEX "CatalogExecutionOperation_shop_reviewId_reviewVersion_key"[\s\S]*?\("shop", "reviewId", "reviewVersion"\)/);
  assert.match(reviewVersionMigration, /ON UPDATE RESTRICT/);
  assert.match(reviewVersionMigration, /PRIMARY KEY \("id", "reviewVersion"\)/);
  assert.match(item, /@@unique\(\[shop,\s*operationId,\s*lineId\]\)/);
  assert.match(item, /onDelete:\s*Restrict/);
  assert.match(attempt, /mutation\s+String/);
  assert.match(attempt, /onDelete:\s*Restrict/);
});

const SHOP_PREFIX = "catalog-execution-pg-";
const PRODUCT_ID = "gid://shopify/Product/870001";
const VARIANT_ID = "gid://shopify/ProductVariant/870002";

async function assertOperationStatus(ctx, result, expectedStatus, message = "") {
  const operation = result?.operationId
    ? await ctx.prisma.catalogExecutionOperation.findFirst({ where: { shop: ctx.shop, id: result.operationId } })
    : null;
  const attempts = result?.operationId
    ? await ctx.prisma.catalogExecutionAttempt.findMany({ where: { shop: ctx.shop, operationId: result.operationId }, orderBy: { startedAt: "asc" } })
    : [];
  assert.equal(result?.status, expectedStatus, JSON.stringify({ message, result, operationStatus: operation?.status, errorCode: operation?.errorCode, errorDetail: operation?.errorDetail, attempts: attempts.map(({ mutation, status, errorCode, detail }) => ({ mutation, status, errorCode, detail })) }));
}

async function setup(t, { operation = "CREATE" } = {}) {
  assert.ok(databaseUrl, "STOCKHUB_TEST_DATABASE_URL must explicitly target the disposable PostgreSQL test database");
  const { validateTestDatabaseUrls, validateDatabaseIdentity } = await import("../scripts/postgres-test-guard.mjs");
  const { url, parsed } = validateTestDatabaseUrls(process.env);
  const { PrismaClient } = await import("../node_modules/.prisma/stockhub-pg-test-client/index.js");
  const prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.$connect();
  const shop = SHOP_PREFIX + randomUUID() + ".myshopify.com";
  const batchId = randomUUID();
  const groupId = randomUUID();
  const lineId = randomUUID();
  const reviewId = randomUUID();
  let vite;

  t.after(async () => {
    try {
      const operations = await prisma.catalogExecutionOperation.findMany({ where: { shop, batchId }, select: { id: true } });
      const operationIds = operations.map(({ id }) => id);
      if (operationIds.length) {
        await prisma.catalogExecutionAttempt.deleteMany({ where: { shop, operationId: { in: operationIds } } });
        await prisma.catalogExecutionItem.deleteMany({ where: { shop, operationId: { in: operationIds } } });
        await prisma.catalogExecutionOperation.deleteMany({ where: { shop, batchId } });
      }
      await prisma.catalogImportReviewHistory.deleteMany({ where: { shop, batchId } });
      await prisma.catalogImportReview.deleteMany({ where: { shop, batchId } });
      await prisma.catalogImportLine.deleteMany({ where: { shop, batchId } });
      await prisma.catalogImportGroup.deleteMany({ where: { shop, batchId } });
      await prisma.catalogImportBatch.deleteMany({ where: { shop, id: batchId } });
    } finally {
      await prisma.$disconnect();
      await vite?.close();
    }
  });

  const identityRows = await prisma.$queryRaw`
    SELECT current_database() AS database,
           current_user AS "user",
           inet_server_addr()::text AS address,
           inet_client_addr()::text AS "clientAddress",
           inet_server_port() AS port,
           version() AS version
  `;
  const identity = validateDatabaseIdentity(identityRows[0] ?? {}, parsed);
  assert.equal(identity.database, "stockhub_regression");
  assert.match(identityRows[0].version, /PostgreSQL 16/i);

  vite = await createServer({
    configFile: false,
    root: new URL("../app/utils/", import.meta.url).pathname,
    appType: "custom",
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    logLevel: "error",
  });
  const { executeConfirmedCatalogReview, verifyCatalogExecutionDatabase } = await vite.ssrLoadModule("/catalog-execution.server.ts");
  const { fingerprintForCatalogReview, catalogExecutionIdempotencyKey } = await vite.ssrLoadModule("/catalog-execution.shared.ts");

  const title = "P2 Execution Test";
  const line = {
    id: lineId,
    batchId,
    shop,
    rowNumber: 1,
    sourceRowNumber: 2,
    sourceValues: [],
    productName: title,
    sku: "P2-SKU-1",
    price: "12.50",
    priceZeroConfirmed: false,
    description: null,
    vendor: null,
    productType: null,
    size: null,
    color: null,
    imageUrl: null,
    status: "READY",
    errors: [],
    groupId,
  };
  const shopifyVariant = operation === "UPDATE" ? {
    id: VARIANT_ID,
    sku: line.sku,
    price: "10.00",
    selectedOptions: [],
    productId: PRODUCT_ID,
    productTitle: title,
    productDescription: null,
    vendor: "",
    productType: "",
    productOptions: [],
  } : null;
  const snapshotVariants = shopifyVariant ? [shopifyVariant] : [];
  const productId = operation === "UPDATE" ? PRODUCT_ID : null;
  const proposal = { groupTitle: title, productId, rowIds: [lineId] };
  const fingerprint = fingerprintForCatalogReview({ variants: snapshotVariants }, proposal, [{ id: lineId, sku: line.sku }]);
  const decisions = {
    schemaVersion: 1,
    group: "CONFIRM",
    productFields: { title: "USE_CSV", description: "KEEP_SHOPIFY", vendor: "KEEP_SHOPIFY", productType: "KEEP_SHOPIFY" },
    variants: { [lineId]: {
      operation,
      fields: { sku: operation === "CREATE" ? "USE_CSV" : "KEEP_SHOPIFY", price: "USE_CSV", size: "KEEP_SHOPIFY", color: "KEEP_SHOPIFY" },
    } },
  };

  await prisma.catalogImportBatch.create({ data: {
    id: batchId,
    shop,
    fileName: "execution.csv",
    fileChecksum: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    originalCsv: "Product Name,SKU,Price\nP2 Execution Test,P2-SKU-1,12.50\n",
    sourceHeaders: ["Product Name", "SKU", "Price"],
    mapping: { "0": "productName", "1": "sku", "2": "price" },
    status: "DRAFT",
    draftVersion: 1,
  } });
  await prisma.catalogImportGroup.create({ data: {
    id: groupId,
    shop,
    batchId,
    source: "productName",
    groupingKey: title.toLowerCase(),
    reason: "P2 execution test group",
    selections: { productName: { value: title, sourceLineId: lineId } },
    validation: [],
    confirmedAt: new Date("2026-10-28T00:00:00.000Z"),
    state: "ACTIVE",
  } });
  await prisma.catalogImportLine.create({ data: line });
  await prisma.catalogImportReview.create({ data: {
    id: reviewId,
    shop,
    batchId,
    groupId,
    draftVersion: 1,
    reviewVersion: 3,
    operation,
    status: "CONFIRMED",
    snapshotFingerprint: fingerprint,
    snapshot: { proposal, variants: snapshotVariants },
    shopifyProductId: productId,
    matchedVariantIds: snapshotVariants.map(({ id }) => id),
    decisions,
    snapshotCapturedAt: new Date("2026-10-28T00:00:00.000Z"),
    reviewedAt: new Date("2026-10-28T00:00:00.000Z"),
  } });

  const runtimeEnvironment = (targetShop = shop) => ({
    STOCKHUB_CATALOG_EXECUTION_ENABLED: "true",
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DEV_APP_ID: "p2-test-development-app-id",
    SHOPIFY_API_KEY: "p2-test-development-app-id",
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DEV_STORE: targetShop,
    DATABASE_URL: url,
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_URL: url,
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_USER: identity.user,
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_SERVER_ADDRESS: identity.address.replace(/^::ffff:/, ""),
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_SERVER_PORT: String(identity.port),
  });
  const calls = [];
  const mutations = [];
  const remote = {
    product: operation === "UPDATE" ? {
      id: PRODUCT_ID, title, status: "DRAFT", tags: [], operationId: null,
      descriptionHtml: null, vendor: "", productType: "", productOptions: [],
    } : null,
    variants: snapshotVariants.map((entry) => ({ ...entry })),
    failNextMutation: null,
    updateTimeoutLeavesState: false,
  };
  const nodeForSnapshot = (entry) => ({
    id: entry.id, sku: entry.sku, price: entry.price, selectedOptions: entry.selectedOptions,
    product: {
      id: entry.productId, title: entry.productTitle, descriptionHtml: entry.productDescription,
      vendor: entry.vendor, productType: entry.productType, options: entry.productOptions,
    },
  });
  const admin = {
    async graphql(query, options = {}) {
      const variables = options.variables ?? {};
      const call = { query, variables };
      calls.push(call);
      if (query.includes("StockHubCatalogVariantSnapshot")) {
        return Response.json({ data: {
          shop: { myshopifyDomain: shop },
          productVariants: { nodes: remote.variants.map(nodeForSnapshot), pageInfo: { hasNextPage: false, endCursor: null } },
        } });
      }
      if (query.includes("StockHubCatalogFindOperationProduct")) {
        const product = remote.product;
        const variants = remote.variants.map((entry) => ({ id: entry.id, sku: entry.sku, price: entry.price, selectedOptions: entry.selectedOptions }));
        return Response.json({ data: { shop: { myshopifyDomain: shop }, products: { nodes: product ? [{
          id: product.id, title: product.title, status: product.status, tags: product.tags,
          metafield: { value: product.operationId },
          variants: { nodes: variants, pageInfo: { hasNextPage: false } },
        }] : [] } } });
      }
      if (!/\bmutation\b/.test(query)) throw new Error("Unexpected fake GraphQL query");
      mutations.push(call);
      if (remote.failNextMutation === "rate-limit") {
        remote.failNextMutation = null;
        return Response.json({ errors: [{ message: "rate limited" }] }, { status: 429 });
      }
      if (remote.failNextMutation === "timeout" && query.includes("StockHubCatalogVariantsUpdate")) {
        remote.failNextMutation = null;
        if (!remote.updateTimeoutLeavesState) {
          // The request may have been accepted, but the later read is not yet
          // sufficient to prove that every approved field landed.
          const update = variables.variants?.[0];
          if (update && remote.product) {
            remote.variants = [{
              id: update.id,
              sku: remote.variants[0]?.sku ?? null,
              price: remote.variants[0]?.price ?? "0.00",
              selectedOptions: remote.variants[0]?.selectedOptions ?? [],
              productId: remote.product.id,
              productTitle: remote.product.title,
              productDescription: remote.product.descriptionHtml,
              vendor: remote.product.vendor,
              productType: remote.product.productType,
              productOptions: remote.product.productOptions,
            }];
          }
        }
        throw new Error("Timeout from the fake Shopify endpoint after request dispatch");
      }
      if (query.includes("StockHubCatalogProductCreate")) {
        const input = variables.product;
        const id = PRODUCT_ID;
        const defaultVariantId = VARIANT_ID;
        const defaultOptions = [{ name: "Title", value: "Default Title" }];
        remote.product = {
          id, title: input.title, status: input.status, tags: input.tags,
          operationId: input.metafields[0].value,
          descriptionHtml: input.descriptionHtml ?? null, vendor: input.vendor ?? "", productType: input.productType ?? "",
          productOptions: (input.productOptions ?? []).map((option) => ({ name: option.name, values: option.values.map((value) => value.name) })),
        };
        remote.variants = [{
          id: defaultVariantId, sku: null, price: "0.00", selectedOptions: defaultOptions,
          productId: id, productTitle: input.title, productDescription: remote.product.descriptionHtml,
          vendor: remote.product.vendor, productType: remote.product.productType, productOptions: remote.product.productOptions,
        }];
        return Response.json({ data: { productCreate: { product: {
          id,
          title: input.title,
          descriptionHtml: input.descriptionHtml ?? null,
          vendor: input.vendor ?? "",
          productType: input.productType ?? "",
          status: input.status,
          tags: input.tags,
          metafield: { value: input.metafields[0].value },
          variants: { nodes: [{ id: defaultVariantId, sku: null, price: "0.00", selectedOptions: defaultOptions }], pageInfo: { hasNextPage: false, endCursor: null } },
        }, userErrors: [] } } });
      }
      if (query.includes("StockHubCatalogProductUpdate")) {
        Object.assign(remote.product, variables.product);
        return Response.json({ data: { productUpdate: { product: { id: remote.product.id }, userErrors: [] } } });
      }
      if (query.includes("StockHubCatalogVariantsUpdate")) {
        const returned = variables.variants.map((update) => {
          const current = remote.variants.find((entry) => entry.id === update.id) ?? remote.variants[0];
          const selectedOptions = update.optionValues
            ? update.optionValues.map(({ optionName, name }) => ({ name: optionName, value: name }))
            : current?.selectedOptions ?? [];
          const updated = {
            id: update.id,
            sku: Object.hasOwn(update, "sku") ? update.sku : current?.sku ?? null,
            price: Object.hasOwn(update, "price") ? update.price : current?.price ?? "0.00",
            selectedOptions,
            productId: remote.product?.id ?? variables.productId,
            productTitle: remote.product?.title ?? current?.productTitle ?? "",
            productDescription: remote.product?.descriptionHtml ?? current?.productDescription ?? null,
            vendor: remote.product?.vendor ?? current?.vendor ?? "",
            productType: remote.product?.productType ?? current?.productType ?? "",
            productOptions: remote.product?.productOptions ?? current?.productOptions ?? [],
          };
          return updated;
        });
        remote.variants = remote.variants.map((current) => returned.find((entry) => entry.id === current.id) ?? current);
        return Response.json({ data: { productVariantsBulkUpdate: {
          product: { id: variables.productId ?? remote.product?.id },
          productVariants: returned.map(({ id, sku, price, selectedOptions }) => ({ id, sku, price, selectedOptions })),
          userErrors: [],
        } } });
      }
      if (query.includes("StockHubCatalogVariantsCreate")) {
        const returned = variables.variants.map((entry, index) => ({
          id: `gid://shopify/ProductVariant/${870003 + index}`, sku: entry.sku, price: entry.price,
          selectedOptions: (entry.optionValues ?? []).map(({ optionName, name }) => ({ name: optionName, value: name })),
        }));
        return Response.json({ data: { productVariantsBulkCreate: { product: { id: variables.productId }, productVariants: returned, userErrors: [] } } });
      }
      throw new Error(`Unexpected fake Shopify mutation: ${query}`);
    },
  };

  const scopes = { async query() { return { granted: ["read_products", "write_products"] }; } };
  const request = (overrides = {}) => executeConfirmedCatalogReview({
    shop,
    batchId,
    groupId,
    draftVersion: 1,
    expectedReviewVersion: 3,
    expectedFingerprint: fingerprint,
    admin,
    scopes,
    prisma,
    environment: runtimeEnvironment(),
    verifyDatabase: (config) => verifyCatalogExecutionDatabase(prisma, config),
    ...overrides,
  });

  return { prisma, shop, batchId, groupId, lineId, reviewId, fingerprint, identity, remote, calls, mutations, admin, request, runtimeEnvironment, verifyCatalogExecutionDatabase, catalogExecutionIdempotencyKey };
}

test("execution-time stale transition archives the confirmed review version and leaves its operation attributed to that version", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t, { operation: "UPDATE" });
  const review = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { shop: ctx.shop, id: ctx.reviewId } });
  const operationId = randomUUID();
  const idempotencyKey = ctx.catalogExecutionIdempotencyKey({
    shop: ctx.shop, batchId: ctx.batchId, groupId: ctx.groupId, reviewId: review.id,
    draftVersion: review.draftVersion, reviewVersion: review.reviewVersion,
    snapshotFingerprint: review.snapshotFingerprint,
  });
  await ctx.prisma.catalogExecutionOperation.create({ data: {
    id: operationId, shop: ctx.shop, batchId: ctx.batchId, groupId: ctx.groupId,
    reviewId: review.id, draftVersion: review.draftVersion, reviewVersion: review.reviewVersion,
    snapshotFingerprint: review.snapshotFingerprint, idempotencyKey,
    plan: "UPDATE", status: "READY", planJson: { disposition: "UPDATE", items: [] },
  } });
  ctx.remote.variants[0].price = "11.00";

  await assert.rejects(ctx.request(), /Shopify changed since this review was confirmed/i);
  const staleReview = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { shop: ctx.shop, id: review.id } });
  assert.equal(staleReview.status, "STALE");
  assert.equal(staleReview.reviewVersion, review.reviewVersion + 1);
  const historicalVersion = await ctx.prisma.catalogImportReviewHistory.findFirst({
    where: { shop: ctx.shop, batchId: ctx.batchId, groupId: ctx.groupId, id: review.id, reviewVersion: review.reviewVersion },
  });
  assert.ok(historicalVersion, "execution-time invalidation must retain the confirmed review before advancing its version");
  assert.equal(historicalVersion.status, "CONFIRMED");
  assert.equal(historicalVersion.snapshotFingerprint, review.snapshotFingerprint);
  assert.deepEqual(historicalVersion.decisions, review.decisions);
  const unchangedOperation = await ctx.prisma.catalogExecutionOperation.findFirstOrThrow({ where: { shop: ctx.shop, id: operationId } });
  assert.equal(unchangedOperation.reviewId, review.id);
  assert.equal(unchangedOperation.reviewVersion, review.reviewVersion);
  assert.equal(unchangedOperation.snapshotFingerprint, review.snapshotFingerprint);
  assert.equal(ctx.mutations.length, 0, "stale approval rejection sends no Shopify mutation");
});

test("confirmed execution durably persists operation, item, and API attempts and repeated success is idempotent", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const first = await ctx.request();
  await assertOperationStatus(ctx, first, "SUCCEEDED");
  assert.equal(ctx.mutations.length, 2);
  assert.ok(ctx.mutations.every(({ query }) => !/inventory|productDelete/i.test(query)));
  const operations = await ctx.prisma.catalogExecutionOperation.findMany({ where: { shop: ctx.shop, batchId: ctx.batchId } });
  const items = await ctx.prisma.catalogExecutionItem.findMany({ where: { shop: ctx.shop, batchId: ctx.batchId } });
  const attempts = await ctx.prisma.catalogExecutionAttempt.findMany({ where: { shop: ctx.shop, operationId: first.operationId }, orderBy: { startedAt: "asc" } });
  assert.equal(operations.length, 1);
  assert.equal(operations[0].status, "SUCCEEDED");
  assert.equal(operations[0].reviewId, ctx.reviewId);
  assert.equal(operations[0].snapshotFingerprint, ctx.fingerprint);
  assert.equal(operations[0].productId, PRODUCT_ID);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "SUCCEEDED");
  assert.equal(items[0].lineId, ctx.lineId);
  assert.deepEqual(items[0].approvedFields, { sku: "P2-SKU-1", price: "12.5" });
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["SUCCEEDED", "SUCCEEDED"]);
  assert.deepEqual(attempts.map((attempt) => attempt.mutation), ["productCreate", "productVariantsBulkUpdate"]);
  assert.ok(attempts.every((attempt) => /^[a-f0-9]{64}$/.test(attempt.requestHash)));

  const mutationCount = ctx.mutations.length;
  const replay = await ctx.request();
  assert.equal(replay.status, "SUCCEEDED");
  assert.equal(ctx.mutations.length, mutationCount, "a repeated confirmed request does not create a duplicate Shopify operation");
  assert.equal(await ctx.prisma.catalogExecutionOperation.count({ where: { shop: ctx.shop, batchId: ctx.batchId } }), 1);
  assert.equal(await ctx.prisma.catalogExecutionAttempt.count({ where: { shop: ctx.shop, operationId: first.operationId } }), 2);
});

test("operation, item, and idempotency uniqueness are enforced and records cannot cross tenants", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const result = await ctx.request();
  await assertOperationStatus(ctx, result, "SUCCEEDED");
  const operation = await ctx.prisma.catalogExecutionOperation.findFirstOrThrow({ where: { shop: ctx.shop, id: result.operationId } });
  const item = await ctx.prisma.catalogExecutionItem.findFirstOrThrow({ where: { shop: ctx.shop, operationId: operation.id } });

  await assert.rejects(ctx.prisma.catalogExecutionOperation.create({ data: {
    ...operation, id: randomUUID(), idempotencyKey: "different-key-for-same-review",
  } }), (error) => error?.code === "P2002");
  await assert.rejects(ctx.prisma.catalogExecutionItem.create({ data: {
    id: randomUUID(), shop: ctx.shop, batchId: ctx.batchId, operationId: operation.id, lineId: item.lineId,
    plan: item.plan, status: "READY", approvedFields: {}, idempotencyKey: "different-item-key-same-line",
  } }), (error) => error?.code === "P2002");

  const alternateReviewId = randomUUID();
  const originalReview = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { shop: ctx.shop, id: ctx.reviewId } });
  await ctx.prisma.catalogImportReview.create({ data: {
    ...originalReview, id: alternateReviewId, draftVersion: 2, reviewVersion: 0,
  } });
  await assert.rejects(ctx.prisma.catalogExecutionOperation.create({ data: {
    id: randomUUID(), shop: ctx.shop, batchId: ctx.batchId, groupId: ctx.groupId, reviewId: alternateReviewId,
    draftVersion: 2, reviewVersion: 0, snapshotFingerprint: operation.snapshotFingerprint,
    idempotencyKey: operation.idempotencyKey, plan: operation.plan, status: "READY", planJson: operation.planJson,
  } }), (error) => error?.code === "P2002", "one idempotency key cannot back two review operations in a shop");

  const wrongShop = "other-tenant-" + randomUUID() + ".myshopify.com";
  const callsBeforeWrongTenant = ctx.calls.length;
  await assert.rejects(ctx.request({ shop: wrongShop, environment: ctx.runtimeEnvironment(wrongShop) }), /draft changed or is unavailable/i);
  assert.equal(ctx.calls.length, callsBeforeWrongTenant, "wrong-tenant lookup is rejected before any Shopify read or mutation");
  await assert.rejects(ctx.prisma.catalogExecutionAttempt.create({ data: {
    id: randomUUID(), shop: wrongShop, operationId: operation.id, mutation: "productUpdate", requestHash: "a".repeat(64),
  } }), (error) => error?.code === "P2003", "tenant-scoped operation FK rejects a cross-shop attempt");
});

test("database CAS allows only one concurrent execution claim and only one mutation path", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  let reads = 0;
  let releaseReads;
  const readsBarrier = new Promise((resolve) => { releaseReads = resolve; });
  let releaseCreate;
  const createBarrier = new Promise((resolve) => { releaseCreate = resolve; });
  let mutationStarted;
  const started = new Promise((resolve) => { mutationStarted = resolve; });
  const baseGraphql = ctx.admin.graphql.bind(ctx.admin);
  ctx.admin.graphql = async (query, options = {}) => {
    if (query.includes("StockHubCatalogVariantSnapshot")) {
      reads += 1;
      if (reads === 2) releaseReads();
      await readsBarrier;
      return baseGraphql(query, options);
    }
    if (query.includes("StockHubCatalogProductCreate")) {
      mutationStarted();
      await createBarrier;
    }
    return baseGraphql(query, options);
  };

  const firstRequest = ctx.request();
  const secondRequest = ctx.request();
  let timeoutId;
  const timeout = new Promise((resolve) => { timeoutId = setTimeout(() => resolve({ timeout: true }), 3000); });
  let loser;
  try {
    const startedResult = await Promise.race([started.then(() => true), timeout]);
    assert.notDeepEqual(startedResult, { timeout: true }, "one concurrent request should claim the operation");
    loser = await Promise.race([
      firstRequest.then((value) => ({ value }), (error) => ({ error })),
      secondRequest.then((value) => ({ value }), (error) => ({ error })),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
    releaseCreate();
  }
  assert.ok(!loser?.timeout, "the competing claim should return while the owner is waiting on the fake mutation");
  assert.equal(loser?.error, undefined);
  assert.equal(loser.value.status, "RUNNING");
  const results = await Promise.all([firstRequest, secondRequest]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ["RUNNING", "SUCCEEDED"]);
  assert.equal(ctx.mutations.filter(({ query }) => query.includes("StockHubCatalogProductCreate")).length, 1);
  assert.equal(await ctx.prisma.catalogExecutionOperation.count({ where: { shop: ctx.shop, batchId: ctx.batchId } }), 1);
  assert.equal(await ctx.prisma.catalogExecutionItem.count({ where: { shop: ctx.shop, batchId: ctx.batchId } }), 1);
});

test("history and FK restrictions prevent deleting an executed review, group, line, or batch", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  const result = await ctx.request();
  await assertOperationStatus(ctx, result, "SUCCEEDED");
  const review = await ctx.prisma.catalogImportReview.findFirstOrThrow({ where: { shop: ctx.shop, id: ctx.reviewId } });
  await ctx.prisma.catalogImportReviewHistory.create({ data: {
    ...review, id: randomUUID(), archivedAt: new Date(),
  } });
  const historyCount = await ctx.prisma.catalogImportReviewHistory.count({ where: { shop: ctx.shop, batchId: ctx.batchId } });
  assert.equal(historyCount, 1);

  for (const remove of [
    () => ctx.prisma.catalogImportReview.deleteMany({ where: { shop: ctx.shop, id: ctx.reviewId } }),
    () => ctx.prisma.catalogImportLine.deleteMany({ where: { shop: ctx.shop, id: ctx.lineId } }),
    () => ctx.prisma.catalogImportGroup.deleteMany({ where: { shop: ctx.shop, id: ctx.groupId } }),
    () => ctx.prisma.catalogImportBatch.deleteMany({ where: { shop: ctx.shop, id: ctx.batchId } }),
  ]) {
    await assert.rejects(remove(), (error) => error?.code === "P2003");
  }
  assert.equal(await ctx.prisma.catalogImportReviewHistory.count({ where: { shop: ctx.shop, batchId: ctx.batchId } }), historyCount);
  assert.equal(await ctx.prisma.catalogExecutionOperation.count({ where: { shop: ctx.shop, batchId: ctx.batchId } }), 1);
});

test("definitive rate-limit failure persists FAILED state and a retry reuses the operation", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  ctx.remote.failNextMutation = "rate-limit";
  const failed = await ctx.request();
  assert.equal(failed.status, "FAILED");
  const operationAfterFailure = await ctx.prisma.catalogExecutionOperation.findFirstOrThrow({ where: { shop: ctx.shop, id: failed.operationId } });
  assert.equal(operationAfterFailure.status, "FAILED");
  assert.equal(operationAfterFailure.errorCode, "RATE_LIMITED");
  const itemAfterFailure = await ctx.prisma.catalogExecutionItem.findFirstOrThrow({ where: { shop: ctx.shop, operationId: failed.operationId } });
  assert.equal(itemAfterFailure.status, "FAILED");
  const failedAttempt = await ctx.prisma.catalogExecutionAttempt.findFirstOrThrow({ where: { shop: ctx.shop, operationId: failed.operationId } });
  assert.equal(failedAttempt.status, "FAILED");

  const retried = await ctx.request();
  await assertOperationStatus(ctx, retried, "SUCCEEDED");
  assert.equal(retried.operationId, failed.operationId);
  assert.equal(await ctx.prisma.catalogExecutionOperation.count({ where: { shop: ctx.shop, batchId: ctx.batchId } }), 1);
  assert.equal(await ctx.prisma.catalogExecutionAttempt.count({ where: { shop: ctx.shop, operationId: failed.operationId } }), 3);
});

test("unknown Shopify outcome is durable and reconciliation does not resend the mutation", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t);
  ctx.remote.failNextMutation = "timeout";
  const first = await ctx.request();
  assert.equal(first.status, "UNKNOWN");
  const operation = await ctx.prisma.catalogExecutionOperation.findFirstOrThrow({ where: { shop: ctx.shop, id: first.operationId } });
  assert.equal(operation.status, "UNKNOWN");
  const attempts = await ctx.prisma.catalogExecutionAttempt.findMany({ where: { shop: ctx.shop, operationId: first.operationId }, orderBy: { startedAt: "asc" } });
  assert.deepEqual(attempts.map(({ status }) => status), ["SUCCEEDED", "UNKNOWN"]);
  const mutationCount = ctx.mutations.length;

  const reconciled = await ctx.request({ reconcileOnly: true });
  assert.equal(reconciled.status, "UNKNOWN", "the fake Shopify read does not prove that the approved SKU/price landed");
  assert.equal(await ctx.prisma.catalogExecutionOperation.count({ where: { shop: ctx.shop, batchId: ctx.batchId, status: "UNKNOWN" } }), 1);
  assert.equal(ctx.mutations.length, mutationCount, "UNKNOWN records are read-only until reconciliation proves a result");
});

test("database CAS allows only one concurrent UNKNOWN reconciliation claimant without redispatch", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t, { operation: "UPDATE" });
  ctx.remote.failNextMutation = "timeout";
  const first = await ctx.request();
  assert.equal(first.status, "UNKNOWN");
  const unknownOperation = await ctx.prisma.catalogExecutionOperation.findFirstOrThrow({ where: { shop: ctx.shop, id: first.operationId } });
  assert.equal(unknownOperation.status, "UNKNOWN");

  const mutationsBeforeResume = ctx.mutations.length;
  const attemptsBeforeResume = await ctx.prisma.catalogExecutionAttempt.findMany({ where: { shop: ctx.shop, operationId: first.operationId } });
  const baseGraphql = ctx.admin.graphql.bind(ctx.admin);
  let resumeReadCount = 0;
  let releaseReads;
  const readsBarrier = new Promise((resolve) => { releaseReads = resolve; });
  let claimRequestCount = 0;
  const claimResults = [];
  let releaseClaims;
  const claimsBarrier = new Promise((resolve) => { releaseClaims = resolve; });
  const originalUpdateMany = ctx.prisma.catalogExecutionOperation.updateMany.bind(ctx.prisma.catalogExecutionOperation);
  ctx.admin.graphql = async (query, options = {}) => {
    if (query.includes("StockHubCatalogVariantSnapshot")) {
      resumeReadCount += 1;
      if (resumeReadCount === 2) releaseReads();
      await readsBarrier;
    }
    return baseGraphql(query, options);
  };
  ctx.prisma.catalogExecutionOperation.updateMany = async (args) => {
    if (args.where?.status === "UNKNOWN" && args.data?.status === "RECONCILING") {
      claimRequestCount += 1;
      if (claimRequestCount === 2) releaseClaims();
      await claimsBarrier;
      const result = await originalUpdateMany(args);
      claimResults.push(result.count);
      return result;
    }
    return originalUpdateMany(args);
  };

  const firstResume = ctx.request({ resumeUnknown: true });
  const secondResume = ctx.request({ resumeUnknown: true });
  const timeoutId = setTimeout(() => { releaseReads(); releaseClaims(); }, 5000);
  const results = await Promise.all([firstResume, secondResume]);
  clearTimeout(timeoutId);
  assert.equal(resumeReadCount, 2, "both requests read the same Shopify snapshot before reconciliation");
  assert.equal(claimRequestCount, 2, "both requests contend for the persisted reconciliation lease");
  assert.deepEqual(claimResults.sort(), [0, 1], "database compare-and-swap gives the reconciliation lease to exactly one request");
  assert.ok(results.every(({ status }) => ["UNKNOWN", "RECONCILING"].includes(status)));
  assert.ok(results.some(({ status }) => status === "UNKNOWN"));
  assert.equal(ctx.mutations.length - mutationsBeforeResume, 0, "concurrent UNKNOWN reconciliation never redispatches the uncertain mutation");
  const finalOperation = await ctx.prisma.catalogExecutionOperation.findFirstOrThrow({ where: { shop: ctx.shop, id: first.operationId } });
  assert.equal(finalOperation.status, "UNKNOWN");
  assert.equal(finalOperation.claimToken, null);
  assert.equal(finalOperation.claimExpiresAt, null);
  const attempts = await ctx.prisma.catalogExecutionAttempt.findMany({ where: { shop: ctx.shop, operationId: first.operationId } });
  assert.equal(attempts.length, attemptsBeforeResume.length, "read-only reconciliation creates no replacement attempt");
  assert.deepEqual(attempts.map(({ status }) => status).sort(), attemptsBeforeResume.map(({ status }) => status).sort(), "the original attempt history is preserved");
  assert.equal(await ctx.prisma.catalogExecutionOperation.count({ where: { shop: ctx.shop, batchId: ctx.batchId } }), 1);
});

test("expired Safe Resume lease does not auto-dispatch while the previous worker is still inside Shopify mutation", { skip: integrationSkip }, async (t) => {
  const ctx = await setup(t, { operation: "UPDATE" });
  ctx.remote.failNextMutation = "timeout";
  const first = await ctx.request();
  assert.equal(first.status, "UNKNOWN");
  const operationId = first.operationId;
  const legacyClaimToken = randomUUID();
  const claimed = await ctx.prisma.catalogExecutionOperation.updateMany({
    where: { shop: ctx.shop, id: operationId, status: "UNKNOWN" },
    data: { status: "RECONCILING", claimToken: legacyClaimToken, claimExpiresAt: new Date(Date.now() + 300_000) },
  });
  assert.equal(claimed.count, 1);
  const prepared = await ctx.prisma.catalogExecutionAttempt.updateMany({
    where: { shop: ctx.shop, operationId, status: "UNKNOWN" },
    data: { status: "PREPARED", claimToken: legacyClaimToken, errorCode: null, detail: null, finishedAt: null },
  });
  assert.equal(prepared.count, 1, "seed the durable record left by a legacy worker whose Shopify call is still in flight");

  const baseGraphql = ctx.admin.graphql.bind(ctx.admin);
  let inFlightMutationDispatches = 0;
  let releaseLegacyMutation;
  const legacyMutationBarrier = new Promise((resolve) => { releaseLegacyMutation = resolve; });
  let legacyMutationStarted;
  const legacyMutationStartedBarrier = new Promise((resolve) => { legacyMutationStarted = resolve; });
  ctx.admin.graphql = async (query, options = {}) => {
    if (query.includes("StockHubCatalogVariantsUpdate")) {
      inFlightMutationDispatches += 1;
      if (inFlightMutationDispatches === 1) {
        // Simulate a legacy Safe Resume network call already in flight before
        // the fail-closed code is deployed. It has not yet changed Shopify.
        legacyMutationStarted();
        await legacyMutationBarrier;
      }
    }
    return baseGraphql(query, options);
  };

  const legacyWorker = ctx.admin.graphql(
    "#graphql\nmutation StockHubCatalogVariantsUpdate { productVariantsBulkUpdate { product { id } userErrors { field message } } }",
    { variables: { productId: PRODUCT_ID, variants: [{ id: VARIANT_ID, price: "12.50" }], allowPartialUpdates: false } },
  );
  try {
    let startedTimeout;
    const started = await Promise.race([
      legacyMutationStartedBarrier.then(() => true),
      new Promise((resolve) => { startedTimeout = setTimeout(() => resolve(false), 5000); }),
    ]);
    clearTimeout(startedTimeout);
    assert.equal(started, true, "the legacy worker should be blocked inside its Shopify mutation");

    const expired = await ctx.prisma.catalogExecutionOperation.updateMany({
      where: { shop: ctx.shop, id: operationId, status: "RECONCILING", claimToken: legacyClaimToken },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal(expired.count, 1, "expire the active legacy worker's persisted lease without waiting for wall-clock expiry");

    // The legacy Shopify call remains blocked and the remote record is still
    // unchanged. New code must reconcile read-only rather than treating lease
    // expiry as proof the old worker stopped and dispatching a duplicate.
    const competitor = await ctx.request({ resumeUnknown: true });
    assert.equal(inFlightMutationDispatches, 1, "an expired lease must not cause a duplicate mutation while the prior worker remains active");
    assert.equal(competitor.status, "UNKNOWN", "the uncertain attempt must remain manual-reconciliation-required");
    const persisted = await ctx.prisma.catalogExecutionOperation.findFirstOrThrow({ where: { shop: ctx.shop, id: operationId } });
    assert.equal(persisted.status, "UNKNOWN");
    assert.equal(persisted.errorCode, "SHOPIFY_UNKNOWN");
    assert.match(persisted.errorDetail ?? "", /reconcil|manual|review/i, "the unresolved operation must explain that manual reconciliation is required");
    assert.equal(ctx.remote.variants[0]?.price, "10.00", "the gated fake Shopify snapshot remains unchanged during the competing request");
  } finally {
    releaseLegacyMutation();
    await Promise.allSettled([legacyWorker]);
  }

  assert.equal(ctx.remote.variants[0]?.price, "12.50", "the legacy in-flight Shopify call may complete after lease expiry");
  const reconciledLateResult = await ctx.request({ reconcileOnly: true });
  assert.equal(reconciledLateResult.status, "SUCCEEDED", "a later read-only reconciliation can verify the legacy worker's late completion");
  assert.equal(inFlightMutationDispatches, 1, "late-result reconciliation does not send another mutation");
});
