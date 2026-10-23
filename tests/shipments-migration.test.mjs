import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertReceiptCanStart, assertShipmentCanClose, assertShipmentCanReopen, formatUtcDateTime, normalizeReference, ShipmentDomainError } from "../app/utils/shipment-domain.js";

const migrationPath = new URL("../prisma/migrations-sqlite-backup/20261023090000_add_shipments_receipts/migration.sql", import.meta.url);
const receivingImportMigrationPath = new URL("../prisma/migrations-sqlite-backup/20261023130000_receiving_csv_imports/migration.sql", import.meta.url);

test("shipment invariants normalize duplicates and guard closure/reopen transitions", () => {
  assert.equal(normalizeReference("  ab-01\t "), "AB-01");
  assert.equal(normalizeReference("ＡＢ-01"), "AB-01");
  assert.equal(formatUtcDateTime("2026-10-23T02:04:05.000Z"), "2026-10-23 02:04:05");
  assert.throws(() => assertReceiptCanStart("CLOSED"), (error) => error instanceof ShipmentDomainError && error.code === "SHIPMENT_CLOSED");
  assert.throws(() => assertShipmentCanClose({ status: "RECEIVING", hasDraftReceipt: true, hasExpectedQuantities: false }), /draft Receipts/);
  assert.throws(() => assertShipmentCanClose({ status: "RECEIVING", hasDraftReceipt: false, hasExpectedQuantities: true }), /Add a reason/);
  assert.doesNotThrow(() => assertShipmentCanClose({ status: "RECEIVING", hasDraftReceipt: false, hasExpectedQuantities: true, reason: "Supplier delivered short" }));
  assert.throws(() => assertShipmentCanReopen("CLOSED", "  "), /reason is required/);
  assert.throws(() => assertShipmentCanReopen("OPEN", "Recount"), /Only a closed/);
  assert.doesNotThrow(() => assertShipmentCanReopen("CLOSED", "Need another delivery"));
});

test("Shipment migration is additive and enforces shop-scoped reference uniqueness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stockhub-s1-"));
  const db = new DatabaseSync(join(dir, "isolated.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(await readFile(migrationPath, "utf8"));
    const insertShipment = db.prepare(`INSERT INTO Shipment (id, shop, referenceType, reference, referenceNormalized, issuer, issuerNormalized, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
    insertShipment.run("s1", "one.myshopify.com", "TRACKING", "ab-01", "AB-01", "Acme", "ACME");
    assert.throws(() => insertShipment.run("s2", "one.myshopify.com", "TRACKING", "AB-01", "AB-01", "acme", "ACME"), /UNIQUE/);
    assert.doesNotThrow(() => insertShipment.run("s3", "two.myshopify.com", "TRACKING", "AB-01", "AB-01", "Acme", "ACME"));
    assert.doesNotThrow(() => insertShipment.run("s4", "one.myshopify.com", "DELIVERY_REFERENCE", "AB-01", "AB-01", "Acme", "ACME"));

    db.prepare("INSERT INTO ShipmentExpectation (id, shipmentId, sku, expectedQty) VALUES (?, ?, ?, ?)").run("e1", "s1", "00123", null);
    assert.equal(db.prepare("SELECT expectedQty FROM ShipmentExpectation WHERE id = ?").get("e1").expectedQty, null);
    db.prepare(`INSERT INTO ReceivingReceipt (id, shop, shipmentId, requestId, locationId, locationName, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).run("r1", "one.myshopify.com", "s1", "request-1", "gid://shopify/Location/1", "Main");
    db.prepare(`INSERT INTO ReceivingReceipt (id, shop, shipmentId, requestId, locationId, locationName, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).run("r2", "one.myshopify.com", "s1", "request-2", "gid://shopify/Location/2", "Overflow");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ReceivingReceipt WHERE shipmentId = 's1'").get().n, 2);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Receipt and event rows cannot outlive their Shipment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stockhub-s1-fk-"));
  const db = new DatabaseSync(join(dir, "isolated.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(await readFile(migrationPath, "utf8"));
    assert.throws(() => db.prepare(`INSERT INTO ShipmentEvent (id, shop, shipmentId, type) VALUES ('ev', 'shop', 'missing', 'REOPENED')`).run(), /FOREIGN KEY/);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ReceivingImportAttempt receipt relation enforces matching Shopify shop identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stockhub-s2-fk-"));
  const db = new DatabaseSync(join(dir, "isolated.sqlite"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(await readFile(migrationPath, "utf8"));
    db.prepare(`INSERT INTO Shipment (id, shop, referenceType, reference, referenceNormalized, issuer, issuerNormalized, updatedAt)
      VALUES (?, ?, 'TRACKING', ?, ?, 'Carrier', 'CARRIER', CURRENT_TIMESTAMP)`).run("s1", "one.myshopify.com", "one", "ONE");
    db.prepare(`INSERT INTO Shipment (id, shop, referenceType, reference, referenceNormalized, issuer, issuerNormalized, updatedAt)
      VALUES (?, ?, 'TRACKING', ?, ?, 'Carrier', 'CARRIER', CURRENT_TIMESTAMP)`).run("s2", "two.myshopify.com", "two", "TWO");
    db.prepare(`INSERT INTO ReceivingReceipt (id, shop, shipmentId, requestId, locationId, locationName, updatedAt)
      VALUES ('r1', 'one.myshopify.com', 's1', 'request1', 'loc1', 'One', CURRENT_TIMESTAMP)`).run();
    db.exec(await readFile(receivingImportMigrationPath, "utf8"));
    const insertAttempt = db.prepare(`INSERT INTO ReceivingImportAttempt
      (id, shop, shipmentId, receiptId, mode, fileName, fileChecksum, dedupeKey, mappingJson)
      VALUES (?, ?, ?, ?, 'RECEIVED', 'rows.csv', 'checksum', ?, '{}')`);
    assert.throws(() => insertAttempt.run("bad", "two.myshopify.com", "s2", "r1", "bad-key"), /FOREIGN KEY/);
    assert.doesNotThrow(() => insertAttempt.run("good", "one.myshopify.com", "s1", "r1", "good-key"));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
