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
    // Keep this race test's disposable SQLite schema aligned with the
    // PostgreSQL-only merge approval migration without touching prisma/dev.sqlite.
    sqlite.exec(`
      ALTER TABLE "ImportBatch" ADD COLUMN "originalCsv" TEXT;
      ALTER TABLE "ImportBatch" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE "ImportBatch" ADD COLUMN "activeMergeApprovalId" TEXT;
      CREATE UNIQUE INDEX "ImportBatch_shop_id_key" ON "ImportBatch"("shop", "id");
      CREATE TABLE "ImportMergeApproval" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "shop" TEXT NOT NULL,
        "batchId" TEXT NOT NULL,
        "mode" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'ACTIVE',
        "snapshotJson" TEXT NOT NULL,
        "fingerprint" TEXT NOT NULL,
        "receiptRevision" INTEGER NOT NULL,
        "chunkNumber" INTEGER NOT NULL DEFAULT 0,
        "processedCount" INTEGER NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "ImportMergeApproval_shop_batchId_fkey"
          FOREIGN KEY ("shop", "batchId") REFERENCES "ImportBatch"("shop", "id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );
      CREATE UNIQUE INDEX "ImportMergeApproval_shop_id_key" ON "ImportMergeApproval"("shop", "id");
      CREATE INDEX "ImportMergeApproval_shop_batchId_createdAt_idx" ON "ImportMergeApproval"("shop", "batchId", "createdAt");
      CREATE INDEX "ImportMergeApproval_shop_status_updatedAt_idx" ON "ImportMergeApproval"("shop", "status", "updatedAt");
    `);
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

test("an expired lease during a Shopify lookup fails closed before product creation or inventory activation", async (t) => {
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
          // Any later lookup would be unsafe if the stale worker were allowed
          // to continue after the approval has been stopped.
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

  const workerA = mergeImportBatch({
    shop, batchId, admin, prisma, now,
    intent: "merge", expectedRevision: 0, confirmedLineIds: [lineId],
  });
  await workerAFirstSkuLookupStarted;

  currentTime = new Date(t0.getTime() + 16 * 60 * 1000);
  const runningBatch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  await assert.rejects(
    mergeImportBatch({
      shop, batchId, admin, prisma, now,
      intent: "continue", approvalId: runningBatch.activeMergeApprovalId,
    }),
    (error) => error.code === "RESUME_REQUIRED",
  );
  assert.equal(createdProducts.length, 0);
  assert.equal(activatedInventoryItems.length, 0);

  // Worker A's first lookup returns after the lease has expired. Its stale
  // result cannot authorize a write after another request stopped approval.
  releaseWorkerAFirstSkuLookup(jsonResponse({ productVariants: {
    edges: [], pageInfo: { hasNextPage: false, endCursor: null },
  } }));
  await workerA;

  assert.deepEqual([createdProducts.length, activatedInventoryItems.length], [0, 0]);
  const finalLine = await prisma.importLine.findUniqueOrThrow({ where: { id: lineId } });
  assert.equal(finalLine.status, "PREVIEWED", "no mutation had begun while the Shopify lookup was pending");
  assert.equal(finalLine.stage, "PREPARED");
  const finalBatch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  assert.equal(finalBatch.status, "UNCERTAIN");
  const approval = await prisma.importMergeApproval.findFirstOrThrow({ where: { batchId, shop } });
  assert.equal(approval.status, "STOPPED");
});
