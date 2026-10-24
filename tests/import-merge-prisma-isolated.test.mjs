/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "../node_modules/.prisma/stockhub-test-client/index.js";
import { mergeImportBatch } from "../app/utils/import-merge.server.ts";

const migrationPaths = [
  "../prisma/migrations-sqlite-backup/20240530213853_create_session_table/migration.sql",
  "../prisma/migrations-sqlite-backup/20261022050000_create_import_batches/migration.sql",
  "../prisma/migrations-sqlite-backup/20261022100000_auto_generated_import_receipts/migration.sql",
].map((path) => new URL(path, import.meta.url));

async function isolatedPrisma(t) {
  const dir = await mkdtemp(join(tmpdir(), "stockhub-import-merge-race-"));
  const dbPath = join(dir, "isolated.sqlite");
  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const path of migrationPaths) sqlite.exec(await readFile(path, "utf8"));
  } finally {
    sqlite.close();
  }
  const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  t.after(async () => {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });
  return prisma;
}

function jsonResponse(data) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("stale Merge worker cannot repeat product creation or inventory activation after another worker finishes", async (t) => {
  const prisma = await isolatedPrisma(t);
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
