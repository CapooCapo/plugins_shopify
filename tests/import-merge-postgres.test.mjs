/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";

import { mergeImportBatch } from "../app/utils/import-merge.server.ts";

async function isolatedPrisma(t) {
  const url = process.env.STOCKHUB_TEST_DATABASE_URL;
  assert.ok(url, "STOCKHUB_TEST_DATABASE_URL must target an isolated test database");
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/stockhub_regression");
  const { PrismaClient } = await import("../node_modules/.prisma/stockhub-pg-test-client/index.js");
  const prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.$connect();
  t.after(async () => prisma.$disconnect());
  return prisma;
}

async function seedBatch(prisma, { shop, batchId, lineId, status = "PREVIEWED", lineStatus = "PREVIEWED", stage = "PREPARED", operationType = "CREATE_DRAFT", t0 = new Date("2026-10-24T10:00:00.000Z") }) {
  await prisma.importBatch.deleteMany({ where: { shop } });
  const operationId = `operation-${lineId}`;
  const idempotencyKey = `idempotency-${lineId}`;
  await prisma.importBatch.create({ data: {
    id: batchId, shop, submissionId: `submission-${lineId}`,
    receiptCode: `IMP-${lineId}`, fileChecksum: `checksum-${lineId}`,
    fileName: "test.csv", locationId: "gid://shopify/Location/10",
    locationName: "Main warehouse", currencyCode: "USD", status,
    createdAt: t0, updatedAt: t0,
    lines: { create: [{
      id: lineId, rowNumber: 2, sku: `SKU-${lineId}`, title: "Test product",
      description: "PostgreSQL integration test", price: "10.00", quantity: 3,
      operationType, status: lineStatus, stage, operationId, idempotencyKey,
      ...(operationType !== "CREATE_DRAFT" || stage === "INVENTORY_ADJUSTING" ? {
        productId: "gid://shopify/Product/30",
        variantId: "gid://shopify/ProductVariant/20",
        inventoryItemId: "gid://shopify/InventoryItem/40",
        expectedQuantity: 11,
      } : {}),
      createdAt: t0, updatedAt: t0,
    }] },
  } });
  return { operationId, idempotencyKey, t0 };
}

function jsonResponse(data) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function locationResponse() {
  return jsonResponse({ locations: { nodes: [{
    id: "gid://shopify/Location/10", name: "Main warehouse", isActive: true,
  }], pageInfo: { hasNextPage: false, endCursor: null } } });
}

function draftProduct(operationId, n = 300) {
  return {
    id: `gid://shopify/Product/${n}`, handle: `stockhub-${operationId}`,
    title: "Test product", status: "DRAFT", metafield: { value: operationId },
    variants: { nodes: [{
      id: `gid://shopify/ProductVariant/${n}`, sku: "",
      inventoryItem: { id: `gid://shopify/InventoryItem/${n}`, tracked: false },
    }] },
  };
}

test("PostgreSQL: stale Merge worker cannot repeat product creation or inventory activation after another worker finishes", { skip: !process.env.STOCKHUB_TEST_DATABASE_URL }, async (t) => {
  const prisma = await isolatedPrisma(t);
  await prisma.importBatch.deleteMany({ where: { shop: "race-test.myshopify.com" } });
  const t0 = new Date("2026-10-24T10:00:00.000Z");
  let currentTime = t0;
  const now = () => new Date(currentTime);
  const shop = "race-test.myshopify.com";
  const locationId = "gid://shopify/Location/10";
  const batchId = "race-batch";
  const operationId = "race-operation";
  const lineId = "race-line";

  await prisma.importBatch.create({ data: {
    id: batchId,
    shop,
    submissionId: "00000000-0000-4000-8000-000000000010",
    receiptCode: "IMP-20261024-000010",
    fileChecksum: "race-checksum",
    fileName: "race.csv",
    locationId,
    locationName: "Main warehouse",
    currencyCode: "USD",
    status: "PREVIEWED",
    actor: "test",
    createdAt: t0,
    updatedAt: t0,
    lines: { create: [{
      id: lineId,
      rowNumber: 2,
      sku: "RACE-SKU",
      title: "Race product",
      description: "Test item",
      price: "10.00",
      quantity: 2,
      operationType: "CREATE_DRAFT",
      status: "PREVIEWED",
      stage: "PREPARED",
      operationId,
      idempotencyKey: "race-idempotency-key",
      createdAt: t0,
      updatedAt: t0,
    }] },
  } });

  let releaseWorkerAFirstSkuLookup;
  let signalWorkerAFirstSkuLookup;
  const workerAFirstSkuLookupStarted = new Promise((resolve) => {
    signalWorkerAFirstSkuLookup = resolve;
  });
  const workerAFirstSkuLookupResult = new Promise((resolve) => {
    releaseWorkerAFirstSkuLookup = resolve;
  });
  let skuLookupCount = 0;
  const createdProducts = [];
  const activatedInventoryItems = [];
  const admin = {
    async graphql(query, { variables }) {
      const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
      switch (operationName) {
        case "StockHubValidateLocation":
          return jsonResponse({ locations: {
            nodes: [{ id: locationId, name: "Main warehouse", isActive: true }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } });
        case "StockHubRecheckSku":
          skuLookupCount += 1;
          if (skuLookupCount === 1) {
            signalWorkerAFirstSkuLookup();
            return workerAFirstSkuLookupResult;
          }
          // Simulate Shopify's SKU search index lagging the product creation
          // just committed by worker B, so the stale worker's second lookup
          // cannot be relied on as a concurrency fence.
          return jsonResponse({ productVariants: {
            edges: [], pageInfo: { hasNextPage: false, endCursor: null },
          } });
        case "StockHubFindDraftMarker":
          return jsonResponse({ productByIdentifier: null });
        case "StockHubCreateDraft": {
          const productNumber = createdProducts.length + 1;
          const product = {
            id: `gid://shopify/Product/${300 + productNumber}`,
            title: "Race product",
            status: "DRAFT",
            metafield: { value: operationId },
            variants: { nodes: [{
              id: `gid://shopify/ProductVariant/${200 + productNumber}`,
              sku: "",
              price: "10.00",
              inventoryItem: {
                id: `gid://shopify/InventoryItem/${400 + productNumber}`,
                tracked: false,
              },
            }] },
          };
          createdProducts.push(product);
          return jsonResponse({ productCreate: { product, userErrors: [] } });
        }
        case "StockHubUpdateDraftInventoryItem":
          return jsonResponse({ inventoryItemUpdate: {
            inventoryItem: { id: variables.id, sku: variables.input.sku, tracked: true },
            userErrors: [],
          } });
        case "StockHubSetDraftPrice":
          return jsonResponse({ productVariantsBulkUpdate: {
            productVariants: [{ id: variables.variantId, price: variables.price }],
            userErrors: [],
          } });
        case "StockHubActivateDraftInventory":
          activatedInventoryItems.push(variables.inventoryItemId);
          return jsonResponse({ inventoryActivate: {
            inventoryLevel: { id: `gid://shopify/InventoryLevel/${activatedInventoryItems.length}` },
            userErrors: [],
          } });
        default:
          throw new Error(`Unexpected Shopify GraphQL operation: ${operationName}`);
      }
    },
  };

  const workerA = mergeImportBatch({ shop, batchId, admin, prisma, now });
  await workerAFirstSkuLookupStarted;

  currentTime = new Date(t0.getTime() + 16 * 60 * 1000);
  const workerB = await mergeImportBatch({ shop, batchId, admin, prisma, now });
  assert.equal(workerB.status, "COMPLETED");
  assert.equal((await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } })).status, "SUCCEEDED");
  assert.equal(createdProducts.length, 1);
  assert.equal(activatedInventoryItems.length, 1);

  // Worker A's first lookup began before B's writes and returns that stale
  // empty result only after B has completed and the lease has been stolen.
  releaseWorkerAFirstSkuLookup(jsonResponse({ productVariants: {
    edges: [], pageInfo: { hasNextPage: false, endCursor: null },
  } }));
  await workerA;

  assert.deepEqual(
    [createdProducts.length, activatedInventoryItems.length],
    [1, 1],
    "a stale worker must not create a duplicate Shopify Draft or repeat inventory activation",
  );
  const finalLine = await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(finalLine.status, "SUCCEEDED", "stale worker must not overwrite the completed line");
  assert.equal(finalLine.stage, "COMPLETED");
});

test("PostgreSQL: concurrent lease claims have one winner and stale line CAS updates affect zero rows", { skip: !process.env.STOCKHUB_TEST_DATABASE_URL }, async (t) => {
  const prisma = await isolatedPrisma(t);
  await prisma.importBatch.deleteMany({ where: { shop: "pg-claim-test.myshopify.com" } });
  const timestamp = new Date("2026-10-24T10:00:00.000Z");
  const shop = "pg-claim-test.myshopify.com";
  const batchId = "pg-claim-batch";
  const lineId = "pg-claim-line";
  await prisma.importBatch.create({ data: {
    id: batchId, shop, submissionId: "00000000-0000-4000-8000-000000000011",
    receiptCode: "IMP-20261024-000011", fileChecksum: "pg-claim-checksum",
    fileName: "claim.csv", locationId: "gid://shopify/Location/11",
    locationName: "Test", currencyCode: "USD", status: "PREVIEWED",
    createdAt: timestamp, updatedAt: timestamp,
    lines: { create: [{
      id: lineId, rowNumber: 2, sku: "PG-SKU", title: "PG item",
      quantity: 1, operationType: "CREATE_DRAFT", status: "PREVIEWED",
      stage: "PREPARED", operationId: "pg-claim-operation",
      idempotencyKey: "pg-claim-idempotency", createdAt: timestamp, updatedAt: timestamp,
    }] },
  } });
  const claimAt = new Date(timestamp.getTime() + 1);
  const eligibleWhere = {
    id: batchId, shop,
    OR: [
      { status: { in: ["PREVIEWED", "PARTIAL", "FAILED", "UNCERTAIN"] } },
      { status: "RUNNING", updatedAt: { lt: new Date(claimAt.getTime() - 15 * 60 * 1000) } },
    ],
  };
  const [claimA, claimB] = await Promise.all([
    prisma.importBatch.updateMany({ where: eligibleWhere, data: { status: "RUNNING", updatedAt: claimAt } }),
    prisma.importBatch.updateMany({ where: eligibleWhere, data: { status: "RUNNING", updatedAt: claimAt } }),
  ]);
  assert.deepEqual([claimA.count, claimB.count].sort(), [0, 1]);

  const ownerTimestamp = new Date(claimAt.getTime() + 1);
  await prisma.importBatch.updateMany({
    where: { id: batchId, shop, status: "RUNNING", updatedAt: claimAt },
    data: { updatedAt: ownerTimestamp },
  });
  const staleLineWrite = await prisma.importLine.updateMany({
    where: {
      id: lineId,
      batch: { is: { id: batchId, shop, status: "RUNNING", updatedAt: claimAt } },
    },
    data: { status: "SUCCEEDED", updatedAt: new Date(ownerTimestamp.getTime() + 1) },
  });
  assert.equal(staleLineWrite.count, 0);
  assert.equal((await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } })).status, "PREVIEWED");
});

test("PostgreSQL: simultaneous Merge service requests admit one active worker", { skip: !process.env.STOCKHUB_TEST_DATABASE_URL }, async (t) => {
  const prisma = await isolatedPrisma(t);
  const shop = "pg-http-race.myshopify.com";
  const batchId = "pg-http-race-batch";
  const lineId = "pg-http-race-line";
  const { t0 } = await seedBatch(prisma, { shop, batchId, lineId, operationType: "UPDATE_EXISTING" });
  let releaseLocation;
  let signalLocation;
  const locationStarted = new Promise((resolve) => { signalLocation = resolve; });
  const locationResult = new Promise((resolve) => { releaseLocation = resolve; });
  let locationCalls = 0;
  let inventoryMutations = 0;
  const admin = { async graphql(query) {
    const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    if (operationName === "StockHubValidateLocation") {
      locationCalls += 1;
      signalLocation();
      return locationResult;
    }
    if (operationName === "StockHubRecheckSku") return jsonResponse({ productVariants: {
      edges: [{ node: {
        id: "gid://shopify/ProductVariant/20", sku: `SKU-${lineId}`, title: "Default",
        product: { id: "gid://shopify/Product/30", title: "Existing", status: "ACTIVE" },
        inventoryItem: { id: "gid://shopify/InventoryItem/40", tracked: true,
          inventoryLevel: { quantities: [{ name: "available", quantity: 11 }] } },
      } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } });
    if (operationName === "StockHubAdjustIncoming") {
      inventoryMutations += 1;
      return jsonResponse({ inventoryAdjustQuantities: {
        inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" }, userErrors: [],
      } });
    }
    throw new Error(`Unexpected GraphQL operation: ${operationName}`);
  } };
  const now = () => new Date(t0.getTime() + 1000);
  const workerA = mergeImportBatch({ shop, batchId, admin, prisma, now });
  await locationStarted;
  await assert.rejects(
    mergeImportBatch({ shop, batchId, admin, prisma, now }),
    (error) => error.code === "BATCH_ALREADY_RUNNING",
  );
  assert.equal(locationCalls, 1);
  releaseLocation(locationResponse());
  const result = await workerA;
  assert.equal(result.status, "COMPLETED");
  assert.equal(inventoryMutations, 1);
  assert.equal((await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } })).status, "COMPLETED");
});

test("PostgreSQL: inventory timeout followed by Resume reuses persisted Shopify idempotency key", { skip: !process.env.STOCKHUB_TEST_DATABASE_URL }, async (t) => {
  const prisma = await isolatedPrisma(t);
  const shop = "pg-timeout-test.myshopify.com";
  const batchId = "pg-timeout-batch";
  const lineId = "pg-timeout-line";
  const { idempotencyKey, t0 } = await seedBatch(prisma, {
    shop, batchId, lineId, operationType: "UPDATE_EXISTING",
  });
  const calls = [];
  let adjustmentAttempts = 0;
  const admin = { async graphql(query, { variables }) {
    const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    calls.push({ operationName, variables });
    if (operationName === "StockHubValidateLocation") return locationResponse();
    if (operationName === "StockHubRecheckSku") return jsonResponse({ productVariants: {
      edges: [{ node: {
        id: "gid://shopify/ProductVariant/20", sku: `SKU-${lineId}`,
        product: { id: "gid://shopify/Product/30", title: "Existing", status: "ACTIVE" },
        inventoryItem: { id: "gid://shopify/InventoryItem/40", tracked: true,
          inventoryLevel: { quantities: [{ name: "available", quantity: 11 }] } },
      } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    } });
    if (operationName === "StockHubAdjustIncoming") {
      adjustmentAttempts += 1;
      if (adjustmentAttempts === 1) throw new Error("mock timeout after Shopify accepted request");
      return jsonResponse({ inventoryAdjustQuantities: {
        inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/101" },
        userErrors: [],
      } });
    }
    throw new Error(`Unexpected GraphQL operation: ${operationName}`);
  } };
  const first = await mergeImportBatch({ shop, batchId, admin, prisma, now: () => new Date(t0.getTime() + 1000) });
  assert.equal(first.status, "UNCERTAIN");
  let line = await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(line.status, "UNCERTAIN");
  assert.equal(line.idempotencyKey, idempotencyKey);
  const second = await mergeImportBatch({ shop, batchId, admin, prisma, now: () => new Date(t0.getTime() + 2000) });
  const attempts = calls.filter((call) => call.operationName === "StockHubAdjustIncoming");
  assert.equal(second.status, "COMPLETED");
  assert.deepEqual(attempts.map((call) => call.variables.key), [idempotencyKey, idempotencyKey]);
  line = await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(line.status, "SUCCEEDED");
  assert.equal(line.idempotencyKey, idempotencyKey);
});

test("PostgreSQL: lost productCreate response reconciles the operation marker on Resume without recreating", { skip: !process.env.STOCKHUB_TEST_DATABASE_URL }, async (t) => {
  const prisma = await isolatedPrisma(t);
  const shop = "pg-marker-test.myshopify.com";
  const batchId = "pg-marker-batch";
  const lineId = "pg-marker-line";
  const { operationId, t0 } = await seedBatch(prisma, { shop, batchId, lineId });
  const calls = [];
  let foundMarker = false;
  const admin = { async graphql(query, { variables }) {
    const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    calls.push({ operationName, variables });
    if (operationName === "StockHubValidateLocation") return locationResponse();
    if (operationName === "StockHubRecheckSku") return jsonResponse({ productVariants: {
      edges: [], pageInfo: { hasNextPage: false, endCursor: null },
    } });
    if (operationName === "StockHubCreateDraft") {
      foundMarker = true; // model Shopify accepted mutation although response was lost
      throw new Error("lost response after productCreate was accepted");
    }
    if (operationName === "StockHubFindDraftMarker") return jsonResponse({
      productByIdentifier: foundMarker ? {
        ...draftProduct(operationId),
        variants: { nodes: [{
          id: "gid://shopify/ProductVariant/300", sku: `SKU-${lineId}`,
          inventoryItem: { id: "gid://shopify/InventoryItem/300", tracked: false, inventoryLevel: null },
        }] },
      } : null,
    });
    if (operationName === "StockHubUpdateDraftInventoryItem") return jsonResponse({
      inventoryItemUpdate: { inventoryItem: { id: variables.id, sku: variables.input.sku, tracked: true }, userErrors: [] },
    });
    if (operationName === "StockHubSetDraftPrice") return jsonResponse({
      productVariantsBulkUpdate: { productVariants: [{ id: variables.variantId, price: variables.price }], userErrors: [] },
    });
    if (operationName === "StockHubActivateDraftInventory") return jsonResponse({
      inventoryActivate: { inventoryLevel: { id: "gid://shopify/InventoryLevel/300" }, userErrors: [] },
    });
    throw new Error(`Unexpected GraphQL operation: ${operationName}`);
  } };
  const now = () => new Date(t0.getTime() + 1000);
  const first = await mergeImportBatch({ shop, batchId, admin, prisma, now });
  assert.equal(first.status, "UNCERTAIN");
  assert.equal((await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } })).stage, "PRODUCT_CREATING");
  const second = await mergeImportBatch({ shop, batchId, admin, prisma, now });
  assert.equal(second.status, "COMPLETED");
  assert.equal(calls.filter((call) => call.operationName === "StockHubCreateDraft").length, 1);
  assert.equal(calls.filter((call) => call.operationName === "StockHubFindDraftMarker").length, 1);
  assert.equal(calls.filter((call) => call.operationName === "StockHubActivateDraftInventory").length, 1);
  const line = await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(line.status, "SUCCEEDED");
  assert.equal(line.productId, "gid://shopify/Product/300");
});

test("PostgreSQL: takeover during an in-flight productCreate cannot let the stale worker overwrite the winner", { skip: !process.env.STOCKHUB_TEST_DATABASE_URL }, async (t) => {
  const prisma = await isolatedPrisma(t);
  const shop = "pg-create-inflight.myshopify.com";
  const batchId = "pg-create-inflight-batch";
  const lineId = "pg-create-inflight-line";
  const { operationId, t0 } = await seedBatch(prisma, { shop, batchId, lineId });
  let currentTime = t0;
  const now = () => new Date(currentTime);
  let signalFirstCreate;
  let releaseFirstCreate;
  const firstCreateStarted = new Promise((resolve) => { signalFirstCreate = resolve; });
  const firstCreateResponse = new Promise((resolve) => { releaseFirstCreate = resolve; });
  const productsByHandle = new Map();
  let createRequests = 0;
  let acceptedProducts = 0;
  let activationRequests = 0;
  const admin = { async graphql(query, { variables }) {
    const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    if (operationName === "StockHubValidateLocation") return locationResponse();
    if (operationName === "StockHubRecheckSku") return jsonResponse({ productVariants: {
      edges: [], pageInfo: { hasNextPage: false, endCursor: null },
    } });
    if (operationName === "StockHubFindDraftMarker") {
      return jsonResponse({ productByIdentifier: productsByHandle.get(variables.identifier.handle) ?? null });
    }
    if (operationName === "StockHubCreateDraft") {
      createRequests += 1;
      if (createRequests === 1) {
        // Request is in flight; the fake Shopify server has not accepted it yet.
        signalFirstCreate();
        return firstCreateResponse;
      }
      const handle = variables.product.handle;
      if (productsByHandle.has(handle)) {
        return jsonResponse({ productCreate: { product: null, userErrors: [{ message: "Handle has already been taken" }] } });
      }
      const product = draftProduct(operationId);
      productsByHandle.set(handle, product);
      acceptedProducts += 1;
      return jsonResponse({ productCreate: { product, userErrors: [] } });
    }
    if (operationName === "StockHubUpdateDraftInventoryItem") return jsonResponse({
      inventoryItemUpdate: { inventoryItem: { id: variables.id, sku: variables.input.sku, tracked: true }, userErrors: [] },
    });
    if (operationName === "StockHubSetDraftPrice") return jsonResponse({
      productVariantsBulkUpdate: { productVariants: [{ id: variables.variantId, price: variables.price }], userErrors: [] },
    });
    if (operationName === "StockHubActivateDraftInventory") {
      activationRequests += 1;
      return jsonResponse({ inventoryActivate: { inventoryLevel: { id: "gid://shopify/InventoryLevel/300" }, userErrors: [] } });
    }
    throw new Error(`Unexpected GraphQL operation: ${operationName}`);
  } };
  const workerA = mergeImportBatch({ shop, batchId, admin, prisma, now });
  await firstCreateStarted;
  currentTime = new Date(t0.getTime() + 16 * 60 * 1000);
  const workerB = await mergeImportBatch({ shop, batchId, admin, prisma, now });
  assert.equal(workerB.status, "UNCERTAIN", "takeover sees no marker yet and must not blindly repeat PRODUCT_CREATING");
  assert.equal(acceptedProducts, 0);
  const lateProduct = draftProduct(operationId);
  productsByHandle.set(`stockhub-${operationId}`, lateProduct);
  acceptedProducts += 1;
  releaseFirstCreate(jsonResponse({ productCreate: { product: lateProduct, userErrors: [] } }));
  await workerA;
  assert.equal(createRequests, 1);
  assert.equal(acceptedProducts, 1, "the already-sent request may still be accepted after lease loss");
  assert.equal((await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } })).status, "UNCERTAIN");
  currentTime = new Date(t0.getTime() + 17 * 60 * 1000);
  const resumed = await mergeImportBatch({ shop, batchId, admin, prisma, now });
  assert.equal(resumed.status, "COMPLETED", "Resume must reconcile the late product by its marker");
  assert.equal(createRequests, 1, "Resume must not send another productCreate");
  assert.equal(activationRequests, 1);
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  const line = await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(batch.status, "COMPLETED");
  assert.equal(line.status, "SUCCEEDED");
  assert.equal(line.stage, "COMPLETED");
});

test("PostgreSQL: takeover immediately before inventoryActivate prevents the stale worker from sending it", { skip: !process.env.STOCKHUB_TEST_DATABASE_URL }, async (t) => {
  const prisma = await isolatedPrisma(t);
  const shop = "pg-pre-activate.myshopify.com";
  const batchId = "pg-pre-activate-batch";
  const lineId = "pg-pre-activate-line";
  const t0 = new Date("2026-10-24T10:00:00.000Z");
  let currentTime = t0;
  const { operationId } = await seedBatch(prisma, {
    shop, batchId, lineId, status: "UNCERTAIN", lineStatus: "UNCERTAIN",
    stage: "INVENTORY_ACTIVATING", t0,
  });
  await prisma.importLine.update({ where: { id: lineId }, data: {
    productId: "gid://shopify/Product/300",
    variantId: "gid://shopify/ProductVariant/300",
    inventoryItemId: "gid://shopify/InventoryItem/300",
  } });
  let tookOver = false;
  let activationRequests = 0;
  const admin = { async graphql(query) {
    const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    if (operationName === "StockHubValidateLocation") return locationResponse();
    if (operationName === "StockHubFindDraftMarker") return jsonResponse({
      productByIdentifier: {
        ...draftProduct(operationId),
        id: "gid://shopify/Product/300",
        variants: { nodes: [{
          id: "gid://shopify/ProductVariant/300", sku: `SKU-${lineId}`,
          inventoryItem: { id: "gid://shopify/InventoryItem/300", tracked: true, inventoryLevel: null },
        }] },
      },
    });
    if (operationName === "StockHubActivateDraftInventory") {
      activationRequests += 1;
      return jsonResponse({ inventoryActivate: { inventoryLevel: { id: "gid://shopify/InventoryLevel/300" }, userErrors: [] } });
    }
    throw new Error(`Unexpected GraphQL operation: ${operationName}`);
  } };
  const guardedPrisma = new Proxy(prisma, {
    get(target, property) {
      if (property !== "importLine") return target[property];
      return new Proxy(target.importLine, {
        get(lineTarget, method) {
          if (method !== "findUniqueOrThrow") return lineTarget[method].bind(lineTarget);
          return async (args) => {
            const result = await lineTarget.findUniqueOrThrow(args);
            if (!tookOver && result.stage === "INVENTORY_ACTIVATING") {
              tookOver = true;
              currentTime = new Date(t0.getTime() + 16 * 60 * 1000);
              const takeover = await prisma.importBatch.updateMany({
                where: { id: batchId, shop, status: "RUNNING", updatedAt: { lt: new Date(currentTime.getTime() - 15 * 60 * 1000) } },
                data: { updatedAt: currentTime },
              });
              assert.equal(takeover.count, 1, "second owner must successfully take the expired lease");
            }
            return result;
          };
        },
      });
    },
  });
  await mergeImportBatch({ shop, batchId, admin, prisma: guardedPrisma, now: () => new Date(currentTime) });
  assert.equal(tookOver, true);
  assert.equal(activationRequests, 0, "the worker must renew/verify ownership before sending inventoryActivate");
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  const line = await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(batch.status, "RUNNING", "stale worker must not finalize the new owner's receipt");
  assert.equal(line.status, "RUNNING");
});

test("PostgreSQL: takeover after Shopify inventory success but before line persistence leaves safe Resume state", { skip: !process.env.STOCKHUB_TEST_DATABASE_URL }, async (t) => {
  const prisma = await isolatedPrisma(t);
  const shop = "pg-persist-race.myshopify.com";
  const batchId = "pg-persist-race-batch";
  const lineId = "pg-persist-race-line";
  const { idempotencyKey, t0 } = await seedBatch(prisma, {
    shop, batchId, lineId, operationType: "UPDATE_EXISTING",
  });
  let currentTime = new Date(t0.getTime() + 1000);
  let transferLease = true;
  let effects = 0;
  let adjustmentKeys = [];
  const admin = { async graphql(query, { variables }) {
    const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    if (operationName === "StockHubValidateLocation") return locationResponse();
    if (operationName === "StockHubRecheckSku") return jsonResponse({ productVariants: {
      edges: [{ node: {
        id: "gid://shopify/ProductVariant/20", sku: `SKU-${lineId}`,
        product: { id: "gid://shopify/Product/30", title: "Existing", status: "ACTIVE" },
        inventoryItem: { id: "gid://shopify/InventoryItem/40", tracked: true,
          inventoryLevel: { quantities: [{ name: "available", quantity: 11 }] } },
      } }], pageInfo: { hasNextPage: false, endCursor: null },
    } });
    if (operationName === "StockHubAdjustIncoming") {
      adjustmentKeys.push(variables.key);
      if (!adjustmentKeys.includes(variables.key) || effects === 0) effects += 1;
      if (transferLease) {
        transferLease = false;
        currentTime = new Date(t0.getTime() + 16 * 60 * 1000);
        const takeover = await prisma.importBatch.updateMany({
          where: { id: batchId, shop, status: "RUNNING", updatedAt: { lt: new Date(currentTime.getTime() - 15 * 60 * 1000) } },
          data: { updatedAt: currentTime },
        });
        assert.equal(takeover.count, 1, "new owner takes over after Shopify accepted the adjustment");
      }
      return jsonResponse({ inventoryAdjustQuantities: {
        inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" }, userErrors: [],
      } });
    }
    throw new Error(`Unexpected GraphQL operation: ${operationName}`);
  } };
  const first = await mergeImportBatch({ shop, batchId, admin, prisma, now: () => new Date(currentTime) });
  assert.equal(first.status, "RUNNING");
  let line = await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(line.status, "RUNNING");
  assert.equal(line.stage, "INVENTORY_ADJUSTING");
  assert.equal(line.idempotencyKey, idempotencyKey);
  currentTime = new Date(t0.getTime() + 32 * 60 * 1000);
  const resumed = await mergeImportBatch({ shop, batchId, admin, prisma, now: () => new Date(currentTime) });
  assert.equal(resumed.status, "COMPLETED");
  assert.deepEqual(adjustmentKeys, [idempotencyKey, idempotencyKey]);
  assert.equal(effects, 1, "the mocked Shopify idempotency contract collapses retry of the accepted operation");
  line = await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(line.status, "SUCCEEDED");
  assert.equal(line.idempotencyKey, idempotencyKey);
});

test("PostgreSQL: Resume worker loses its lease during lookup and sends no stale inventory adjustment", { skip: !process.env.STOCKHUB_TEST_DATABASE_URL }, async (t) => {
  const prisma = await isolatedPrisma(t);
  const shop = "pg-resume-race.myshopify.com";
  const batchId = "pg-resume-race-batch";
  const lineId = "pg-resume-race-line";
  const t0 = new Date("2026-10-24T10:00:00.000Z");
  let currentTime = t0;
  await seedBatch(prisma, {
    shop, batchId, lineId, status: "UNCERTAIN", lineStatus: "UNCERTAIN",
    stage: "INVENTORY_ADJUSTING", operationType: "UPDATE_EXISTING", t0,
  });
  let signalFirstLookup;
  let releaseFirstLookup;
  const lookupStarted = new Promise((resolve) => { signalFirstLookup = resolve; });
  const lookupResult = new Promise((resolve) => { releaseFirstLookup = resolve; });
  let lookupCalls = 0;
  let adjustmentCalls = 0;
  const admin = { async graphql(query) {
    const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    if (operationName === "StockHubValidateLocation") return locationResponse();
    if (operationName === "StockHubRecheckSku") {
      lookupCalls += 1;
      if (lookupCalls === 1) {
        signalFirstLookup();
        return lookupResult;
      }
      return jsonResponse({ productVariants: {
        edges: [{
          id: "gid://shopify/ProductVariant/20", sku: `SKU-${lineId}`,
          product: { id: "gid://shopify/Product/30", title: "Existing", status: "ACTIVE" },
          inventoryItem: { id: "gid://shopify/InventoryItem/40", tracked: true,
            inventoryLevel: { quantities: [{ name: "available", quantity: 11 }] } },
        }].map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      } });
    }
    if (operationName === "StockHubAdjustIncoming") {
      adjustmentCalls += 1;
      return jsonResponse({ inventoryAdjustQuantities: {
        inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" }, userErrors: [],
      } });
    }
    throw new Error(`Unexpected GraphQL operation: ${operationName}`);
  } };
  const workerA = mergeImportBatch({ shop, batchId, admin, prisma, now: () => new Date(currentTime) });
  await lookupStarted;
  currentTime = new Date(t0.getTime() + 16 * 60 * 1000);
  const workerB = await mergeImportBatch({ shop, batchId, admin, prisma, now: () => new Date(currentTime) });
  assert.equal(workerB.status, "COMPLETED", JSON.stringify(workerB.lines[0]));
  releaseFirstLookup(jsonResponse({ productVariants: {
    edges: [{
      id: "gid://shopify/ProductVariant/20", sku: `SKU-${lineId}`,
      product: { id: "gid://shopify/Product/30", title: "Existing", status: "ACTIVE" },
      inventoryItem: { id: "gid://shopify/InventoryItem/40", tracked: true,
        inventoryLevel: { quantities: [{ name: "available", quantity: 11 }] } },
    }].map((node) => ({ node })),
    pageInfo: { hasNextPage: false, endCursor: null },
  } }));
  await workerA;
  assert.equal(adjustmentCalls, 1);
  assert.equal((await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } })).status, "COMPLETED");
  assert.equal((await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } })).status, "SUCCEEDED");
});
