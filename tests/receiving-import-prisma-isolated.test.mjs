/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { confirmDuplicateSkuMerge, confirmExpectedGoods, confirmProductProposalGroup, createReceivingImport } from "../app/utils/receiving-import.server.ts";

const migrationPaths = [
  "../prisma/migrations/20240530213853_create_session_table/migration.sql",
  "../prisma/migrations/20261022050000_create_import_batches/migration.sql",
  "../prisma/migrations/20261022100000_auto_generated_import_receipts/migration.sql",
  "../prisma/migrations/20261023090000_add_shipments_receipts/migration.sql",
  "../prisma/migrations/20261023130000_receiving_csv_imports/migration.sql",
  "../prisma/migrations/20261023180000_receipt_inspection_foundation/migration.sql",
].map((path) => new URL(path, import.meta.url));

async function isolatedPrisma(t) {
  const dir = await mkdtemp(join(tmpdir(), "stockhub-s2-prisma-"));
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

async function seedShipment(prisma, shop, id) {
  return prisma.shipment.create({ data: {
    id, shop, referenceType: "TRACKING", reference: id, referenceNormalized: id,
    issuer: "Carrier", issuerNormalized: "CARRIER",
  } });
}

async function seedReceipt(prisma, shop, shipmentId, id) {
  return prisma.receivingReceipt.create({ data: {
    id, shop, shipmentId, requestId: `request-${id}`, locationId: `gid://shopify/Location/${id}`,
    locationName: `Location ${id}`, status: "DRAFT",
  } });
}

const partialCsv = "SKU,Quantity,Product Name\n00123,2,Hat\n,invalid,Missing SKU\nB-2,3,Cap\n";

test("Expected preview is write-free until explicit merge/confirm, then applies valid expectations exactly once", async (t) => {
  const prisma = await isolatedPrisma(t);
  await seedShipment(prisma, "one.myshopify.com", "shipment-one");
  const expectedCsv = "SKU,Quantity,Product Name\n00123,2,Hat\n,invalid,Missing SKU\nB-2,3,Cap\nDUP,2,Shirt\nDUP,3,Shirt\n";
  const result = await createReceivingImport({
    shop: "one.myshopify.com", shipmentId: "shipment-one", mode: "EXPECTED",
    fileName: "expected.csv", source: expectedCsv,
  }, prisma);

  const saved = await prisma.receivingImportAttempt.findUnique({ where: { id: result.attemptId }, include: { rows: { orderBy: { rowNumber: "asc" } } } });
  assert.equal(result.duplicateWarning, false);
  assert.equal(saved.status, "AWAITING_CONFIRMATION");
  assert.deepEqual(saved.rows.map((row) => [row.rowNumber, row.outcome, row.decision]), [
    [2, "NEEDS_REVIEW", null], [3, "BLOCKED", null], [4, "NEEDS_REVIEW", null],
    [5, "NEEDS_REVIEW", "MERGE_REQUIRED"], [6, "NEEDS_REVIEW", "MERGE_REQUIRED"],
  ]);
  assert.equal(JSON.parse(saved.rows[0].rawValuesJson).SKU, "00123");
  assert.match(JSON.parse(saved.rows[1].validationJson)[0], /SKU is required/);
  assert.equal(await prisma.shipmentExpectation.count({ where: { shipmentId: "shipment-one" } }), 0, "preview must not write Shipment expectations");

  const duplicateReplay = await createReceivingImport({
    shop: "one.myshopify.com", shipmentId: "shipment-one", mode: "EXPECTED",
    fileName: "expected-again.csv", source: expectedCsv,
  }, prisma);
  assert.equal(duplicateReplay.duplicateWarning, true);
  assert.equal(duplicateReplay.attemptId, result.attemptId);
  assert.equal(await prisma.shipmentExpectation.count({ where: { shipmentId: "shipment-one" } }), 0, "duplicate upload must not apply expectations");

  const duplicateRow = saved.rows.find((row) => row.sku === "DUP");
  const merged = await confirmDuplicateSkuMerge({ shop: "one.myshopify.com", attemptId: result.attemptId, rowId: duplicateRow.id }, prisma);
  assert.deepEqual(merged.sourceRows, [5, 6]);
  assert.equal(await prisma.shipmentExpectation.count({ where: { shipmentId: "shipment-one" } }), 0, "duplicate merge records intent but does not confirm the Expected preview");

  const confirmed = await confirmExpectedGoods({ shop: "one.myshopify.com", attemptId: result.attemptId }, prisma);
  assert.equal(confirmed.alreadyConfirmed, false);
  assert.equal(confirmed.appliedSkus, 3);
  const expectations = await prisma.shipmentExpectation.findMany({ where: { shipmentId: "shipment-one" }, orderBy: { sku: "asc" } });
  assert.deepEqual(expectations.map(({ sku, expectedQty }) => [sku, expectedQty]), [["00123", 2], ["B-2", 3], ["DUP", 5]]);
  const repeated = await confirmExpectedGoods({ shop: "one.myshopify.com", attemptId: result.attemptId }, prisma);
  assert.equal(repeated.alreadyConfirmed, true);
  assert.deepEqual(await prisma.shipmentExpectation.findMany({ where: { shipmentId: "shipment-one" }, orderBy: { sku: "asc" } }).then((rows) => rows.map(({ sku, expectedQty }) => [sku, expectedQty])), [["00123", 2], ["B-2", 3], ["DUP", 5]]);
});

test("Received mode requires a same-shop draft, retains input rows, and never changes expectations", async (t) => {
  const prisma = await isolatedPrisma(t);
  await seedShipment(prisma, "one.myshopify.com", "shipment-one");
  await seedShipment(prisma, "two.myshopify.com", "shipment-two");
  const ownReceipt = await seedReceipt(prisma, "one.myshopify.com", "shipment-one", "receipt-one");
  const foreignReceipt = await seedReceipt(prisma, "two.myshopify.com", "shipment-two", "receipt-two");
  await prisma.shipmentExpectation.create({ data: { id: "expected-one", shipmentId: "shipment-one", sku: "00123", expectedQty: 9 } });

  await assert.rejects(createReceivingImport({
    shop: "one.myshopify.com", shipmentId: "shipment-one", mode: "RECEIVED",
    fileName: "received.csv", source: partialCsv,
  }, prisma), /linked to a Receipt draft/);
  await assert.rejects(createReceivingImport({
    shop: "two.myshopify.com", shipmentId: "shipment-one", mode: "EXPECTED",
    fileName: "cross-shop.csv", source: partialCsv,
  }, prisma), /open Shipment belonging to this Shopify store/);
  await assert.rejects(createReceivingImport({
    shop: "one.myshopify.com", shipmentId: "shipment-one", receiptId: foreignReceipt.id,
    mode: "RECEIVED", fileName: "foreign.csv", source: partialCsv,
  }, prisma), /draft Receipt belonging to this Shipment and Shopify store/);

  const before = await prisma.receivingReceipt.findUnique({ where: { id: ownReceipt.id } });
  const result = await createReceivingImport({
    shop: "one.myshopify.com", shipmentId: "shipment-one", receiptId: ownReceipt.id,
    mode: "RECEIVED", fileName: "received.csv", source: partialCsv,
  }, prisma);
  const after = await prisma.receivingReceipt.findUnique({ where: { id: ownReceipt.id } });
  const saved = await prisma.receivingImportAttempt.findUnique({ where: { id: result.attemptId }, include: { rows: { orderBy: { rowNumber: "asc" } } } });
  assert.equal(saved.shop, "one.myshopify.com");
  assert.equal(saved.status, "PARTIAL");
  assert.deepEqual(saved.rows.map((row) => [row.rowNumber, row.outcome]), [[2, "NEEDS_REVIEW"], [3, "BLOCKED"], [4, "NEEDS_REVIEW"]]);
  assert.deepEqual(await prisma.shipmentExpectation.findMany({ where: { shipmentId: "shipment-one" } }).then((rows) => rows.map(({ sku, expectedQty }) => [sku, expectedQty])), [["00123", 9]]);
  assert.equal(after.status, before.status);
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
});

test("same-shop re-upload returns the existing attempt without replaying rows; another shop remains independent", async (t) => {
  const prisma = await isolatedPrisma(t);
  await seedShipment(prisma, "one.myshopify.com", "shipment-one");
  await seedShipment(prisma, "two.myshopify.com", "shipment-two");
  const receiptOne = await seedReceipt(prisma, "one.myshopify.com", "shipment-one", "receipt-one");
  const receiptTwo = await seedReceipt(prisma, "two.myshopify.com", "shipment-two", "receipt-two");
  const input = {
    shop: "one.myshopify.com", shipmentId: "shipment-one", receiptId: receiptOne.id,
    mode: "RECEIVED", fileName: "received.csv", source: partialCsv,
  };
  const first = await createReceivingImport(input, prisma);
  const savedRow = await prisma.receivingImportRow.findFirstOrThrow({ where: { attemptId: first.attemptId, rowNumber: 2 } });
  await prisma.receivingImportRow.update({ where: { id: savedRow.id }, data: { decision: "TEST_DECISION" } });

  const replay = await createReceivingImport({ ...input, fileName: "renamed.csv" }, prisma);
  assert.equal(replay.duplicateWarning, true);
  assert.equal(replay.attemptId, first.attemptId);
  assert.equal(await prisma.receivingImportAttempt.count({ where: { shop: "one.myshopify.com" } }), 1);
  assert.equal(await prisma.receivingImportRow.count({ where: { attemptId: first.attemptId } }), 3);
  assert.equal((await prisma.receivingImportRow.findUnique({ where: { id: savedRow.id } })).decision, "TEST_DECISION");

  const independent = await createReceivingImport({
    ...input, shop: "two.myshopify.com", shipmentId: "shipment-two", receiptId: receiptTwo.id,
  }, prisma);
  assert.equal(independent.duplicateWarning, false);
  assert.notEqual(independent.attemptId, first.attemptId);
  assert.equal(await prisma.receivingImportAttempt.count({ where: { shop: "two.myshopify.com" } }), 1);
});

test("Expected Product proposal confirmation rejects stale or incomplete source-row lookups", async (t) => {
  const prisma = await isolatedPrisma(t);
  await seedShipment(prisma, "one.myshopify.com", "shipment-one");
  const receipt = await seedReceipt(prisma, "one.myshopify.com", "shipment-one", "receipt-one");
  const result = await createReceivingImport({
    shop: "one.myshopify.com", shipmentId: "shipment-one", receiptId: receipt.id,
    mode: "RECEIVED", fileName: "products.csv", source: "SKU,Quantity,Product Name\nA,1,Hat\nB,1,Cap\n",
  }, prisma);
  const rows = await prisma.receivingImportRow.findMany({ where: { attemptId: result.attemptId }, orderBy: { rowNumber: "asc" } });
  const staleCases = [
    { id: "incomplete", proposalJson: JSON.stringify({ lookupComplete: false, parentLookupComplete: true, candidates: [] }) },
    { id: "now-matched", proposalJson: JSON.stringify({ lookupComplete: true, parentLookupComplete: true, candidates: [{ id: "variant-1" }] }) },
  ];
  for (let index = 0; index < staleCases.length; index += 1) {
    const stale = staleCases[index];
    const row = rows[index];
    const group = await prisma.receivingImportProposalGroup.create({ data: {
      id: `group-${stale.id}`, attemptId: result.attemptId, groupKey: stale.id, productName: row.sku,
    } });
    await prisma.receivingImportRow.update({ where: { id: row.id }, data: {
      proposalGroupId: group.id, outcome: "NEW_PRODUCT", validationJson: "[]", proposalJson: stale.proposalJson,
    } });
    await assert.rejects(confirmProductProposalGroup({ shop: "one.myshopify.com", attemptId: result.attemptId, groupId: group.id }, prisma), /stale or invalid row/);
    assert.equal((await prisma.receivingImportProposalGroup.findUnique({ where: { id: group.id } })).status, "DRAFT");
  }
});
