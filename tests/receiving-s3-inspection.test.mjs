/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { createReceivingImport } from "../app/utils/receiving-import.server.ts";
import { cancelReceiptDraft } from "../app/utils/shipments.server.ts";
import {
  addWrongItemException,
  assertSourceRowNotInspected,
  confirmReceiptInspection,
  markAllEligibleAccepted,
  prepareReceiptInspection,
  saveReceiptInspectionLine,
} from "../app/utils/receiving-inspection.server.ts";

const migrationPaths = [
  "../prisma/migrations/20240530213853_create_session_table/migration.sql",
  "../prisma/migrations/20261022050000_create_import_batches/migration.sql",
  "../prisma/migrations/20261022100000_auto_generated_import_receipts/migration.sql",
  "../prisma/migrations/20261023090000_add_shipments_receipts/migration.sql",
  "../prisma/migrations/20261023130000_receiving_csv_imports/migration.sql",
  "../prisma/migrations/20261023180000_receipt_inspection_foundation/migration.sql",
].map((path) => new URL(path, import.meta.url));

async function isolatedPrisma(t) {
  const dir = await mkdtemp(join(tmpdir(), "stockhub-s3-prisma-"));
  const dbPath = join(dir, "isolated.sqlite");
  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const path of migrationPaths) sqlite.exec(await readFile(path, "utf8"));
  } finally {
    sqlite.close();
  }
  const client = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  t.after(async () => { await client.$disconnect(); await rm(dir, { recursive: true, force: true }); });
  return client;
}

async function seed(prisma) {
  const shop = "store-one.myshopify.com";
  const shipmentId = "shipment-s3";
  const receiptId = "receipt-s3";
  await prisma.shipment.create({ data: { id: shipmentId, shop, referenceType: "TRACKING", reference: "TRACK-S3", referenceNormalized: "TRACK-S3", issuer: "Carrier", issuerNormalized: "CARRIER" } });
  await prisma.receivingReceipt.create({ data: { id: receiptId, shop, shipmentId, requestId: "receipt-request-s3", locationId: "gid://shopify/Location/55", locationName: "Main", status: "DRAFT" } });
  const imported = await createReceivingImport({ shop, shipmentId, receiptId, mode: "RECEIVED", fileName: "goods.csv", source: "SKU,Quantity,Product Name\n00123,70,Hat\nUNKNOWN,2,Unknown item\n,1,Missing SKU\n" }, prisma);
  const rows = await prisma.receivingImportRow.findMany({ where: { attemptId: imported.attemptId }, orderBy: { rowNumber: "asc" } });
  await prisma.receivingImportRow.update({ where: { id: rows[0].id }, data: { outcome: "EXISTING_VARIANT", matchedProductId: "gid://shopify/Product/8", matchedVariantId: "gid://shopify/ProductVariant/9", proposalJson: JSON.stringify({ lookupComplete: true, candidates: [{ id: "gid://shopify/ProductVariant/9" }] }) } });
  await prisma.receivingImportRow.update({ where: { id: rows[1].id }, data: { outcome: "NEEDS_REVIEW", proposalJson: JSON.stringify({ lookupComplete: true, candidates: [] }) } });
  return { shop, shipmentId, receiptId, rows };
}

test("inspection conserves quantities, holds unresolved rows, retains exceptions, and confirms once with accepted-only pending operations", async (t) => {
  const prisma = await isolatedPrisma(t);
  const { shop, receiptId, rows } = await seed(prisma);
  assert.deepEqual(await prepareReceiptInspection({ shop, receiptId }, prisma), { createdLines: 2, preservedErrors: 1 });
  assert.deepEqual(await prepareReceiptInspection({ shop, receiptId }, prisma), { createdLines: 0, preservedErrors: 1 }, "preparing again reports the retained error without duplicating its exception");
  const attemptsBeforeLateUpload = await prisma.receivingImportAttempt.count({ where: { receiptId } });
  await assert.rejects(createReceivingImport({ shop, shipmentId: "shipment-s3", receiptId, mode: "RECEIVED", fileName: "late.csv", source: "SKU,Quantity\nLATE,4\n" }, prisma), /Inspection has already started/);
  assert.equal(await prisma.receivingImportAttempt.count({ where: { receiptId } }), attemptsBeforeLateUpload, "late upload does not append source rows after inspection begins");
  const lines = await prisma.receiptInspectionLine.findMany({ where: { receiptId }, orderBy: { receivedQty: "desc" } });
  const known = lines.find((line) => line.sourceRowId === rows[0].id);
  const unknown = lines.find((line) => line.sourceRowId === rows[1].id);
  assert.equal(known.acceptedQty, 0, "upload does not auto-accept goods");
  await assert.rejects(confirmReceiptInspection({ shop, receiptId, snapshots: {} }, prisma), /Classified quantities must equal physical Received/);
  assert.equal(await markAllEligibleAccepted({ shop, receiptId }, prisma).then((value) => value.acceptedLines), 1);
  await assert.rejects(saveReceiptInspectionLine({ shop, receiptId, lineId: unknown.id, acceptedQty: 1, damagedQty: 0, onHoldQty: 1 }, prisma), /no confirmed existing Shopify Variant/);
  await saveReceiptInspectionLine({ shop, receiptId, lineId: known.id, acceptedQty: 65, damagedQty: 5, onHoldQty: 0 }, prisma);
  await saveReceiptInspectionLine({ shop, receiptId, lineId: unknown.id, acceptedQty: 0, damagedQty: 0, onHoldQty: 2 }, prisma);
  await assert.rejects(saveReceiptInspectionLine({ shop, receiptId, lineId: known.id, acceptedQty: 65, damagedQty: 6, onHoldQty: 0 }, prisma), /cannot exceed physical Received/);
  await assert.rejects(saveReceiptInspectionLine({ shop, receiptId, lineId: known.id, acceptedQty: 65.5, damagedQty: 4.5, onHoldQty: 0 }, prisma), /whole number/);
  await assert.rejects(saveReceiptInspectionLine({ shop, receiptId, lineId: known.id, acceptedQty: -1, damagedQty: 71, onHoldQty: 0 }, prisma), /non-negative/);
  await assert.rejects(addWrongItemException({ shop, receiptId, requestId: "6f2b68a9-a79e-46fb-aed1-f0ac41a2d882", description: "Wrong item", quantity: 1, reason: "Unrecognized disposition", disposition: "DISCARD" }, prisma), /disposition must be Hold or Return/);
  assert.equal(await prisma.receiptInspectionException.count({ where: { receiptId, type: "WRONG_ITEM" } }), 0, "invalid disposition is rejected before persistence");
  const wrong = await addWrongItemException({ shop, receiptId, requestId: "8a2818fd-a219-43cd-80d7-62a08fba13ce", description: "Wrong color shirt", suspectedSku: "MYSTERY-01", quantity: 1, reason: "Not ordered", disposition: "HOLD" }, prisma);
  assert.equal(wrong.type, "WRONG_ITEM");
  assert.equal(wrong.suspectedSku, "MYSTERY-01");
  await assert.rejects(assertSourceRowNotInspected(rows[0].id, prisma), /matching is frozen/);
  await assert.rejects(cancelReceiptDraft({ shop, shipmentId: "shipment-s3", receiptId, reason: "Cancel after inspection" }, prisma), /cannot be cancelled/);

  const snapshots = { [known.matchedVariantId]: { inventoryItemId: "gid://shopify/InventoryItem/10", available: 12, readAt: new Date("2026-10-23T00:00:00Z"), reason: null } };
  const concurrent = await Promise.all([
    confirmReceiptInspection({ shop, receiptId, snapshots }, prisma),
    confirmReceiptInspection({ shop, receiptId, snapshots: { [known.matchedVariantId]: { inventoryItemId: "gid://shopify/InventoryItem/other", available: 999, readAt: new Date(), reason: null } } }, prisma),
  ]);
  assert.deepEqual(concurrent.map((item) => item.alreadyConfirmed).sort(), [false, true], "one concurrent caller claims confirmation and the loser reloads the committed result");
  const confirmed = concurrent.find((item) => !item.alreadyConfirmed);
  assert.ok(confirmed);
  assert.equal(confirmed.receipt.status, "CONFIRMED");
  assert.equal(confirmed.operations.length, 1);
  assert.equal(confirmed.operations[0].acceptedDelta, 65, "Damaged and On Hold quantities never enter the Shopify delta");
  assert.equal(confirmed.operations[0].snapshotAvailable, 12);
  assert.equal(confirmed.operations[0].status, "PENDING");
  assert.match(confirmed.operations[0].operationKey, /^[a-f0-9]{64}$/);
  const replay = await confirmReceiptInspection({ shop, receiptId, snapshots: {} }, prisma);
  assert.equal(replay.alreadyConfirmed, true);
  assert.equal(replay.operations.length, 1);
  assert.equal(replay.operations[0].operationKey, confirmed.operations[0].operationKey);
  assert.equal(replay.operations[0].inventoryItemId, "gid://shopify/InventoryItem/10", "loser's alternate snapshot cannot replace the winner's immutable snapshot");
  assert.equal(await prisma.receiptInventoryOperation.count({ where: { receiptId } }), 1);
  assert.equal(await prisma.shipmentEvent.count({ where: { shop, shipmentId: "shipment-s3", type: "RECEIPT_CONFIRMED" } }), 1, "concurrent claims record exactly one confirmation event");
  assert.equal(await prisma.receiptInspectionException.count({ where: { receiptId, type: "IMPORT_ROW_ERROR" } }), 1);
  await assert.rejects(saveReceiptInspectionLine({ shop, receiptId, lineId: known.id, acceptedQty: 70, damagedQty: 0, onHoldQty: 0 }, prisma), /immutable/);
  await assert.rejects(addWrongItemException({ shop, receiptId, requestId: "44760a74-04c7-49ac-875d-514c11619743", description: "Another wrong item", quantity: 1, reason: "Wrong delivery", disposition: "RETURN" }, prisma), /immutable/);
});

test("inspection reads and actions remain scoped to the owning Shopify shop", async (t) => {
  const prisma = await isolatedPrisma(t);
  const { receiptId, rows } = await seed(prisma);
  await assert.rejects(prepareReceiptInspection({ shop: "other-store.myshopify.com", receiptId }, prisma), /not found for this Shopify store/);
  await prepareReceiptInspection({ shop: "store-one.myshopify.com", receiptId }, prisma);
  await assert.rejects(assertSourceRowNotInspected(rows[0].id, prisma), /matching is frozen/);
  const line = await prisma.receiptInspectionLine.findUniqueOrThrow({ where: { sourceRowId: rows[0].id } });
  await assert.rejects(saveReceiptInspectionLine({ shop: "other-store.myshopify.com", receiptId, lineId: line.id, acceptedQty: 70, damagedQty: 0, onHoldQty: 0 }, prisma), /not found for this Shopify store/);
});
