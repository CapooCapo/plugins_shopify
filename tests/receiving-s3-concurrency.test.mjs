/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "../node_modules/.prisma/stockhub-test-client/index.js";
import { createReceivingImport } from "../app/utils/receiving-import.server.ts";
import { confirmReceiptInspection, prepareReceiptInspection, saveReceiptInspectionLine } from "../app/utils/receiving-inspection.server.ts";

const migrationPaths = [
  "../prisma/migrations-sqlite-backup/20240530213853_create_session_table/migration.sql",
  "../prisma/migrations-sqlite-backup/20261022050000_create_import_batches/migration.sql",
  "../prisma/migrations-sqlite-backup/20261022100000_auto_generated_import_receipts/migration.sql",
  "../prisma/migrations-sqlite-backup/20261023090000_add_shipments_receipts/migration.sql",
  "../prisma/migrations-sqlite-backup/20261023130000_receiving_csv_imports/migration.sql",
  "../prisma/migrations-sqlite-backup/20261023180000_receipt_inspection_foundation/migration.sql",
].map((path) => new URL(path, import.meta.url));

async function isolatedPrisma(t) {
  const dir = await mkdtemp(join(tmpdir(), "stockhub-s3-concurrency-"));
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

test("concurrent receipt confirmations converge to one confirmation and one stable pending operation", async (t) => {
  const prisma = await isolatedPrisma(t);
  const shop = "concurrent-store.myshopify.com";
  const shipmentId = "shipment-concurrent";
  const receiptId = "receipt-concurrent";
  await prisma.shipment.create({ data: {
    id: shipmentId, shop, referenceType: "TRACKING", reference: "CONCURRENT", referenceNormalized: "CONCURRENT",
    issuer: "Carrier", issuerNormalized: "CARRIER",
  } });
  await prisma.receivingReceipt.create({ data: {
    id: receiptId, shop, shipmentId, requestId: "request-concurrent", locationId: "gid://shopify/Location/808",
    locationName: "Main", status: "DRAFT",
  } });
  const imported = await createReceivingImport({
    shop, shipmentId, receiptId, mode: "RECEIVED", fileName: "concurrent.csv", source: "SKU,Quantity\nSKU-1,70\n",
  }, prisma);
  const source = await prisma.receivingImportRow.findFirstOrThrow({ where: { attemptId: imported.attemptId } });
  await prisma.receivingImportRow.update({ where: { id: source.id }, data: {
    outcome: "EXISTING_VARIANT", matchedProductId: "gid://shopify/Product/1", matchedVariantId: "gid://shopify/ProductVariant/1",
  } });
  await prepareReceiptInspection({ shop, receiptId }, prisma);
  const line = await prisma.receiptInspectionLine.findUniqueOrThrow({ where: { sourceRowId: source.id } });
  await saveReceiptInspectionLine({ shop, receiptId, lineId: line.id, acceptedQty: 65, damagedQty: 5, onHoldQty: 0 }, prisma);
  const snapshots = { [line.matchedVariantId]: { inventoryItemId: "gid://shopify/InventoryItem/1", available: 10, readAt: new Date("2026-10-23T00:00:00.000Z"), reason: null } };

  const results = await Promise.all([
    confirmReceiptInspection({ shop, receiptId, snapshots }, prisma),
    confirmReceiptInspection({ shop, receiptId, snapshots }, prisma),
  ]);
  assert.equal(results.every((result) => Array.isArray(result.operations)), true);
  assert.equal(await prisma.receiptInventoryOperation.count({ where: { shop, receiptId } }), 1);
  assert.equal(await prisma.shipmentEvent.count({ where: { shop, shipmentId, type: "RECEIPT_CONFIRMED" } }), 1);
  assert.equal(results[0].operations[0].operationKey, results[1].operations[0].operationKey);
  assert.equal(results[0].operations[0].acceptedDelta, 65);
  assert.equal(results[1].operations[0].status, "PENDING");
  assert.equal((await prisma.receivingReceipt.findUniqueOrThrow({ where: { id: receiptId } })).status, "CONFIRMED");
});
