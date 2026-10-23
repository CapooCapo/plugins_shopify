import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import { cancelReceiptDraft, closeShipment, createReceiptDraft, createShipment, getShipment, reopenShipment } from "../app/utils/shipments.server.ts";

const migrationPaths = [
  "../prisma/migrations/20240530213853_create_session_table/migration.sql",
  "../prisma/migrations/20261022050000_create_import_batches/migration.sql",
  "../prisma/migrations/20261022100000_auto_generated_import_receipts/migration.sql",
  "../prisma/migrations/20261023090000_add_shipments_receipts/migration.sql",
  "../prisma/migrations/20261023130000_receiving_csv_imports/migration.sql",
  "../prisma/migrations/20261023180000_receipt_inspection_foundation/migration.sql",
].map((path) => new URL(path, import.meta.url));

async function temporaryDatabase(t) {
  const dir = await mkdtemp(join(tmpdir(), "stockhub-s1-service-"));
  const dbPath = join(dir, "isolated.sqlite");
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const path of migrationPaths) sqlite.exec(await readFile(path, "utf8"));
  sqlite.close();
  const prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  t.after(async () => {
    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });
  return prisma;
}

const location = (id) => ({ locationId: `gid://shopify/Location/${id}`, locationName: `Location ${id}` });
const requestId = (tail) => `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;

test("Shipment service validates reference type, preserves nullable expectations, and scopes duplicate detection", async (t) => {
  const db = await temporaryDatabase(t);
  await assert.rejects(createShipment({ shop: "a.myshopify.com", referenceType: "PO", reference: "R1", issuer: "Acme" }, db), (error) => error.code === "INVALID_REFERENCE_TYPE");
  const first = await createShipment({ shop: "a.myshopify.com", referenceType: "tracking", reference: "  ab-1 ", issuer: "Acme", expectations: [{ sku: "00123", expectedQty: null }, { sku: "SKU-B", expectedQty: 4 }] }, db);
  assert.equal(first.reference, "ab-1");
  assert.deepEqual(first.expectations.map(({ sku, expectedQty }) => [sku, expectedQty]), [["00123", null], ["SKU-B", 4]]);
  await assert.rejects(createShipment({ shop: "c.myshopify.com", referenceType: "TRACKING", reference: "QTY", issuer: "Carrier", expectations: [{ sku: "A", expectedQty: 1.5 }] }, db), (error) => error.code === "INVALID_EXPECTATION");
  await assert.rejects(createShipment({ shop: "c.myshopify.com", referenceType: "TRACKING", reference: "DUP", issuer: "Carrier", expectations: [{ sku: "A", expectedQty: null }, { sku: "A", expectedQty: 2 }] }, db), (error) => error.code === "DUPLICATE_EXPECTATION");
  await assert.rejects(createShipment({ shop: "a.myshopify.com", referenceType: "TRACKING", reference: "AB-1", issuer: " acme " }, db), (error) => error.code === "DUPLICATE_REFERENCE");
  const otherShop = await createShipment({ shop: "b.myshopify.com", referenceType: "TRACKING", reference: "AB-1", issuer: "Acme" }, db);
  assert.notEqual(first.id, otherShop.id);
  assert.equal(await getShipment("b.myshopify.com", first.id, db), null);
});

test("Receipt draft replay is idempotent, scoped, and rejects changed shipment/location details", async (t) => {
  const db = await temporaryDatabase(t);
  const shipment = await createShipment({ shop: "a.myshopify.com", referenceType: "TRACKING", reference: "T-2", issuer: "Carrier" }, db);
  const loc = location("11");
  const input = { shop: "a.myshopify.com", shipmentId: shipment.id, ...loc, requestId: requestId(1) };
  const receipt = await createReceiptDraft(input, db);
  assert.equal((await createReceiptDraft(input, db)).id, receipt.id);
  await assert.rejects(createReceiptDraft({ ...input, locationId: "gid://shopify/Location/12" }, db), (error) => error.code === "IDEMPOTENCY_CONFLICT");
  const otherShipment = await createShipment({ shop: "a.myshopify.com", referenceType: "TRACKING", reference: "T-3", issuer: "Carrier" }, db);
  await assert.rejects(createReceiptDraft({ ...input, shipmentId: otherShipment.id }, db), (error) => error.code === "IDEMPOTENCY_CONFLICT");
  await assert.rejects(createReceiptDraft({ ...input, shop: "b.myshopify.com", requestId: requestId(2) }, db), (error) => error.code === "NOT_FOUND");
  const secondLocation = location("12");
  const separate = await createReceiptDraft({ ...input, ...secondLocation, requestId: requestId(3) }, db);
  assert.equal(separate.shipmentId, shipment.id);
  assert.equal((await getShipment("a.myshopify.com", shipment.id, db)).receipts.length, 2);
  const otherShopShipment = await createShipment({ shop: "b.myshopify.com", referenceType: "TRACKING", reference: "T-4", issuer: "Carrier" }, db);
  const otherShopReceipt = await createReceiptDraft({ shop: "b.myshopify.com", shipmentId: otherShopShipment.id, ...loc, requestId: requestId(1) }, db);
  assert.notEqual(otherShopReceipt.id, receipt.id);
});

test("cancel, close and reopen preserve append-only events and require transition reasons", async (t) => {
  const db = await temporaryDatabase(t);
  const shipment = await createShipment({ shop: "a.myshopify.com", referenceType: "DELIVERY_REFERENCE", reference: "D-3", issuer: "Supplier", expectations: [{ sku: "X", expectedQty: 3 }] }, db);
  const loc = location("21");
  const receipt = await createReceiptDraft({ shop: "a.myshopify.com", shipmentId: shipment.id, ...loc, requestId: requestId(21) }, db);
  await assert.rejects(closeShipment({ shop: "a.myshopify.com", shipmentId: shipment.id, reason: "done" }, db), /draft Receipts/);
  await cancelReceiptDraft({ shop: "a.myshopify.com", shipmentId: shipment.id, receiptId: receipt.id, reason: "Duplicate draft" }, db);
  await assert.rejects(closeShipment({ shop: "a.myshopify.com", shipmentId: shipment.id }, db), /Add a reason/);
  await closeShipment({ shop: "a.myshopify.com", shipmentId: shipment.id, reason: "No more goods expected" }, db);
  await assert.rejects(createReceiptDraft({ shop: "a.myshopify.com", shipmentId: shipment.id, ...location("22"), requestId: requestId(22) }, db), (error) => error.code === "SHIPMENT_CLOSED");
  await assert.rejects(reopenShipment({ shop: "a.myshopify.com", shipmentId: shipment.id, reason: "  " }, db), /reason is required/);
  await reopenShipment({ shop: "a.myshopify.com", shipmentId: shipment.id, reason: "Another delivery is coming" }, db);
  const saved = await getShipment("a.myshopify.com", shipment.id, db);
  assert.equal(saved.status, "RECEIVING");
  assert.equal(saved.receipts[0].status, "CANCELLED");
  assert.deepEqual(saved.events.map((event) => event.type), ["CREATED", "RECEIVING_STARTED", "RECEIPT_DRAFT_CREATED", "RECEIPT_DRAFT_CANCELLED", "CLOSED", "REOPENED"]);
  assert.equal(saved.events.find((event) => event.type === "REOPENED").reason, "Another delivery is coming");
});

test("database rejects Receipt or event rows whose shop does not own the Shipment", async (t) => {
  const db = await temporaryDatabase(t);
  const shipment = await createShipment({ shop: "a.myshopify.com", referenceType: "TRACKING", reference: "TENANT", issuer: "Carrier" }, db);
  await assert.rejects(db.receivingReceipt.create({ data: { id: "bad-r", shop: "b.myshopify.com", shipmentId: shipment.id, requestId: requestId(99), locationId: "gid://shopify/Location/99", locationName: "Other", status: "DRAFT" } }));
  await assert.rejects(db.shipmentEvent.create({ data: { id: "bad-e", shop: "b.myshopify.com", shipmentId: shipment.id, type: "REOPENED" } }));
});
