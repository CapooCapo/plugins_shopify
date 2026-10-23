/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { createReceivingImport } from "../app/utils/receiving-import.server.ts";

function fakePrisma({ shipmentShop = "a.myshopify.com", receiptShop = "a.myshopify.com" } = {}) {
  const state = {
    shipments: [{ id: "shipment-1", shop: shipmentShop, status: "OPEN" }],
    receipts: [{ id: "receipt-1", shop: receiptShop, shipmentId: "shipment-1", status: "DRAFT" }],
    attempts: [],
    expectations: new Map(),
    createCount: 0,
    expectationWrites: 0,
    receiptWrites: 0,
  };
  const tx = {
    receivingImportAttempt: {
      create: async ({ data }) => {
        state.createCount += 1;
        const { rows, ...attempt } = data;
        const saved = {
          ...attempt,
          rows: rows.create.map((row) => ({ ...row })),
        };
        state.attempts.push(saved);
        return saved;
      },
    },
    shipmentExpectation: {
      upsert: async ({ where, create, update }) => {
        state.expectationWrites += 1;
        const key = where.shipmentId_sku.sku;
        const current = state.expectations.get(key);
        const next = current ? { ...current, ...update } : { ...create };
        state.expectations.set(key, next);
        return next;
      },
    },
  };
  const db = {
    shipment: {
      findFirst: async ({ where }) => state.shipments.find((item) => item.id === where.id && item.shop === where.shop) ?? null,
    },
    receivingReceipt: {
      findFirst: async ({ where }) => state.receipts.find((item) => item.id === where.id && item.shipmentId === where.shipmentId && item.shop === where.shop && item.status === where.status) ?? null,
      create: async () => { state.receiptWrites += 1; throw new Error("S2 imports must not create Receipts."); },
      update: async () => { state.receiptWrites += 1; throw new Error("S2 imports must not change physical Receipt quantities."); },
    },
    receivingImportAttempt: {
      findFirst: async ({ where }) => state.attempts.find((item) => item.shop === where.shop && item.shipmentId === where.shipmentId && item.receiptId === where.receiptId && item.mode === where.mode && item.fileChecksum === where.fileChecksum) ?? null,
    },
    $transaction: async (callback) => callback(tx),
  };
  return { db, state };
}

const csv = "SKU,Quantity,Product Name\n00123,2,Hat\n,invalid,Missing SKU\nB-2,3,Cap\n";

test("Expected preview persists every source row but does not write expectations before confirmation", async () => {
  const { db, state } = fakePrisma();
  const result = await createReceivingImport({
    shop: "a.myshopify.com", shipmentId: "shipment-1", mode: "EXPECTED",
    fileName: "expected.csv", source: csv,
  }, db);

  assert.equal(result.duplicateWarning, false);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].status, "AWAITING_CONFIRMATION");
  assert.deepEqual(state.attempts[0].rows.map((row) => row.rowNumber), [2, 3, 4]);
  assert.equal(JSON.parse(state.attempts[0].rows[0].rawValuesJson).SKU, "00123");
  assert.equal(state.attempts[0].rows[1].outcome, "BLOCKED");
  assert.equal(state.expectationWrites, 0);
  assert.equal(state.expectations.size, 0);
  assert.equal(state.receiptWrites, 0);
});

test("Received mode requires a draft Receipt and rejects a receipt owned by another shop", async () => {
  const { db } = fakePrisma();
  await assert.rejects(createReceivingImport({
    shop: "a.myshopify.com", shipmentId: "shipment-1", mode: "RECEIVED",
    fileName: "received.csv", source: csv,
  }, db), /linked to a Receipt draft/);

  const foreignReceipt = fakePrisma({ receiptShop: "b.myshopify.com" });
  await assert.rejects(createReceivingImport({
    shop: "a.myshopify.com", shipmentId: "shipment-1", receiptId: "receipt-1", mode: "RECEIVED",
    fileName: "received.csv", source: csv,
  }, foreignReceipt.db), /draft Receipt belonging to this Shipment and Shopify store/);
  assert.equal(foreignReceipt.state.createCount, 0);
});

test("Received imports retain partial source rows and re-upload warns without replaying persistence", async () => {
  const { db, state } = fakePrisma();
  const input = {
    shop: "a.myshopify.com", shipmentId: "shipment-1", receiptId: "receipt-1", mode: "RECEIVED",
    fileName: "received.csv", source: csv,
  };
  const first = await createReceivingImport(input, db);
  const replay = await createReceivingImport({ ...input, fileName: "renamed.csv" }, db);

  assert.equal(first.duplicateWarning, false);
  assert.equal(replay.duplicateWarning, true);
  assert.equal(replay.attemptId, first.attemptId);
  assert.equal(state.createCount, 1);
  assert.equal(state.attempts[0].status, "PARTIAL");
  assert.deepEqual(state.attempts[0].rows.map((row) => [row.rowNumber, row.outcome]), [[2, "NEEDS_REVIEW"], [3, "BLOCKED"], [4, "NEEDS_REVIEW"]]);
  assert.equal(state.expectationWrites, 0);
  assert.equal(state.receiptWrites, 0);

  const otherShop = fakePrisma({ shipmentShop: "b.myshopify.com", receiptShop: "b.myshopify.com" });
  const independent = await createReceivingImport({ ...input, shop: "b.myshopify.com" }, otherShop.db);
  assert.equal(independent.duplicateWarning, false, "identical source in another shop is not a duplicate of this shop's attempt");
  assert.equal(otherShop.state.createCount, 1);
});
