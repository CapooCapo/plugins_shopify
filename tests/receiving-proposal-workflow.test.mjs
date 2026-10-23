/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmDuplicateSkuMerge,
  confirmExpectedGoods,
  confirmExistingVariantMatch,
  confirmProductProposalGroup,
  lookupReceivingRowMatch,
  proposeNewVariant,
  recordReceivingMatchDecision,
  saveProductProposalGroup,
  splitProductProposalRow,
  createReceivingImport,
} from "../app/utils/receiving-import.server.ts";

const variantParent = {
  id: "gid://shopify/Product/1",
  title: "Shirt",
  options: [{ name: "Size", values: ["M"] }, { name: "Color", values: ["Blue"] }],
  variants: {
    nodes: [{ id: "gid://shopify/ProductVariant/1", selectedOptions: [{ name: "Size", value: "M" }, { name: "Color", value: "Blue" }] }],
    pageInfo: { hasNextPage: false },
  },
};

test("NEW_VARIANT proposal requires a selected parent and rejects existing option combinations", async () => {
  let updated;
  const row = { id: "row1", sku: "SHIRT-XL", outcome: "NEW_PRODUCT", attemptId: "attempt1", proposalJson: JSON.stringify({ lookupComplete: true, parentCandidates: [{ id: variantParent.id, title: variantParent.title }] }) };
  const db = { receivingImportRow: { findFirst: async () => row, update: async ({ data }) => (updated = data) } };
  const admin = { graphql: async () => ({ json: async () => ({ data: { product: variantParent } }) }) };
  const saved = await proposeNewVariant(admin, { shop: "shop.myshopify.com", attemptId: "attempt1", rowId: "row1", productId: variantParent.id, optionValuesJson: '{"Size":"XL","Color":"Blue"}' }, db);
  assert.equal(saved.outcome, "NEW_VARIANT");
  assert.equal(updated.matchedProductId, variantParent.id);
  assert.deepEqual(JSON.parse(updated.proposalJson).optionValues, { Size: "XL", Color: "Blue" });
  await assert.rejects(() => proposeNewVariant(admin, { shop: "shop.myshopify.com", attemptId: "attempt1", rowId: "row1", productId: variantParent.id, optionValuesJson: '{"Size":"M","Color":"Blue"}' }, db), /already exists/);
  await assert.rejects(() => proposeNewVariant(admin, { shop: "shop.myshopify.com", attemptId: "attempt1", rowId: "row1", productId: variantParent.id, optionValuesJson: '{"Size":"XL"}' }, db), /exactly one/);
});

test("existing variant confirmation requires an explicitly selected lookup candidate", async () => {
  const row = { id: "row1", sku: "DUP-SKU", proposalJson: JSON.stringify({ lookupComplete: true, candidates: [{ id: "v1", product: { id: "p1" } }, { id: "v2", product: { id: "p2" } }] }) };
  let updated;
  const db = { receivingImportRow: { findFirst: async () => row, update: async ({ data }) => (updated = data) } };
  const admin = { graphql: async () => ({ json: async () => ({ data: { productVariants: { nodes: [{ id: "v1", sku: "DUP-SKU", product: { id: "p1" } }, { id: "v2", sku: "DUP-SKU", product: { id: "p2" } }], pageInfo: { hasNextPage: false } } } }) }) };
  await confirmExistingVariantMatch(admin, { shop: "shop.myshopify.com", attemptId: "attempt1", rowId: "row1", productId: "p2", variantId: "v2" }, db);
  assert.equal(updated.decision, "EXISTING_VARIANT_CONFIRMED");
  assert.match(updated.decisionReason, /ambiguous/);
  await assert.rejects(() => confirmExistingVariantMatch(admin, { shop: "shop.myshopify.com", attemptId: "attempt1", rowId: "row1", productId: "p3", variantId: "v3" }, db), /candidate/);
});

test("invalid CSV rows remain BLOCKED and are not sent to Shopify matching", async () => {
  let updated;
  const db = { receivingImportRow: { findFirst: async () => ({ id: "r1", sku: "A", validationJson: '["Quantity is invalid"]', decision: null }), update: async ({ data }) => (updated = data) } };
  const admin = { graphql: async () => { throw new Error("must not query Shopify for invalid row"); } };
  const row = await lookupReceivingRowMatch(admin, { shop: "shop.myshopify.com", attemptId: "a1", rowId: "r1" }, db);
  assert.equal(row.outcome, "BLOCKED");
  assert.match(updated.decisionReason, /validation errors/);
});

test("Expected Goods preview persists rows but does not mutate Shipment expectations", async () => {
  let attempt;
  const db = {
    shipment: { findFirst: async () => ({ id: "s1", status: "OPEN" }) },
    receivingImportAttempt: { findFirst: async () => null },
    $transaction: async (callback) => callback({
      receivingImportAttempt: { create: async ({ data }) => (attempt = data) },
      shipmentExpectation: { upsert: async () => assert.fail("preview must not mutate expectations") },
    }),
  };
  const result = await createReceivingImport({ shop: "shop.myshopify.com", shipmentId: "s1", mode: "EXPECTED", fileName: "expected.csv", source: "SKU,Quantity\nA,5\n" }, db);
  assert.equal(result.status, "AWAITING_CONFIRMATION");
  assert.equal(attempt.rows.create.length, 1);
  assert.equal(attempt.status, "AWAITING_CONFIRMATION");
});

test("Expected Goods confirmation applies valid agreed rows once and skips invalid/unmerged duplicates", async () => {
  let status = "AWAITING_CONFIRMATION";
  const applied = [];
  const rows = [
    { rowNumber: 2, sku: "A", quantity: 5, validationJson: "[]", decision: null, proposalJson: null },
    { rowNumber: 3, sku: "BAD", quantity: null, validationJson: '["invalid quantity"]', decision: null, proposalJson: null },
    { rowNumber: 4, sku: "PENDING", quantity: 2, validationJson: "[]", decision: "MERGE_REQUIRED", proposalJson: null },
    { rowNumber: 5, sku: "PENDING", quantity: 3, validationJson: "[]", decision: "MERGE_REQUIRED", proposalJson: null },
    { rowNumber: 6, sku: "MERGED", quantity: 2, validationJson: "[]", decision: "MERGE_DUPLICATES_CONFIRMED", proposalJson: JSON.stringify({ sku: "MERGED", aggregateQuantity: 5, sourceRows: [6, 7] }) },
    { rowNumber: 7, sku: "MERGED", quantity: 3, validationJson: "[]", decision: "MERGE_DUPLICATES_CONFIRMED", proposalJson: JSON.stringify({ sku: "MERGED", aggregateQuantity: 5, sourceRows: [6, 7] }) },
  ];
  const db = { $transaction: async (callback) => callback({
    receivingImportAttempt: { findFirst: async () => ({ id: "a1", status, mode: "EXPECTED", receiptId: null, shipmentId: "s1", shipment: { status: "OPEN" }, rows }), update: async ({ data }) => (status = data.status) },
    shipmentExpectation: { upsert: async ({ where, create, update }) => { applied.push({ sku: where.shipmentId_sku.sku, expectedQty: create.expectedQty ?? update.expectedQty }); } },
  }) };
  const first = await confirmExpectedGoods({ shop: "shop.myshopify.com", attemptId: "a1" }, db);
  assert.deepEqual(applied, [{ sku: "A", expectedQty: 5 }, { sku: "MERGED", expectedQty: 5 }]);
  assert.equal(first.appliedSkus, 2);
  assert.equal(status, "EXPECTED_CONFIRMED");
  const replay = await confirmExpectedGoods({ shop: "shop.myshopify.com", attemptId: "a1" }, db);
  assert.equal(replay.alreadyConfirmed, true);
  assert.equal(applied.length, 2);
});

test("proposal group key can explicitly combine rows only under one chosen product name", async () => {
  let groupData;
  let rowData;
  const db = {
    receivingImportRow: { findFirst: async () => ({ id: "row1", outcome: "NEW_PRODUCT", validationJson: "[]", proposalJson: JSON.stringify({ lookupComplete: true, parentLookupComplete: true, candidates: [] }) }), update: async ({ data }) => (rowData = data) },
    receivingImportProposalGroup: {
      findUnique: async () => null,
      upsert: async ({ create }) => (groupData = { ...create, id: "group1" }),
    },
  };
  const group = await saveProductProposalGroup({ shop: "shop.myshopify.com", attemptId: "attempt1", rowId: "row1", groupKey: "POLO", productName: "Polo shirt" }, db);
  assert.equal(group.groupKey, "POLO");
  assert.equal(rowData.proposalGroupId, "group1");
  assert.equal(rowData.outcome, "NEW_PRODUCT");
});

test("Product proposal groups reject forged existing or ambiguous exact-SKU lookup results", async () => {
  for (const [outcome, candidates] of [["EXISTING_VARIANT", [{ id: "v1" }]], ["NEEDS_REVIEW", [{ id: "v1" }, { id: "v2" }]]]) {
    const db = { receivingImportRow: { findFirst: async () => ({ id: "r1", outcome, validationJson: "[]", proposalJson: JSON.stringify({ lookupComplete: true, parentLookupComplete: true, candidates }) }) } };
    await assert.rejects(() => saveProductProposalGroup({ shop: "shop.myshopify.com", attemptId: "a1", rowId: "r1", groupKey: "G", productName: "Hat" }, db), /server-verified NEW_PRODUCT/);
  }
});

test("NEW_VARIANT confirmation retains the server-validated selected parent Product ID", async () => {
  const row = { id: "r1", outcome: "NEW_VARIANT", matchedProductId: "gid://shopify/Product/42", matchedVariantId: null, proposalJson: '{"optionValues":{"Size":"XL"}}', validationJson: "[]", decision: null, proposalGroup: null };
  let saved;
  const db = { receivingImportRow: { findFirst: async () => row, update: async ({ data }) => (saved = data) } };
  await recordReceivingMatchDecision({ shop: "shop.myshopify.com", attemptId: "a1", rowId: "r1", decision: "NEW_VARIANT" }, db);
  assert.equal(saved.matchedProductId, "gid://shopify/Product/42");
  assert.equal(saved.matchedVariantId, null);
});

test("NEW_PRODUCT group confirmation checks unique variant options and persists the explicit grouping", async () => {
  const validLookup = JSON.stringify({ lookupComplete: true, parentLookupComplete: true, candidates: [] });
  const group = { id: "g1", status: "DRAFT", rows: [
    { id: "r1", proposalGroupId: "g1", outcome: "NEW_PRODUCT", validationJson: "[]", decision: null, proposalJson: validLookup, rowNumber: 2, rawValuesJson: JSON.stringify({ Size: "M", Color: "Blue" }) },
    { id: "r2", proposalGroupId: "g1", outcome: "NEW_PRODUCT", validationJson: "[]", decision: null, proposalJson: validLookup, rowNumber: 3, rawValuesJson: JSON.stringify({ Size: "L", Color: "Blue" }) },
  ] };
  const updates = [];
  const db = {
    receivingImportProposalGroup: { findFirst: async () => group, update: async ({ data }) => (updates.push(data), { ...group, ...data }) },
    receivingImportAttempt: { findUniqueOrThrow: async () => ({ mappingJson: JSON.stringify({ size: "Size", color: "Color" }) }) },
    receivingImportRow: { updateMany: async ({ data }) => (updates.push(data), { count: 2 }) },
    $transaction: async (callback) => callback(db),
  };
  const confirmed = await confirmProductProposalGroup({ shop: "shop.myshopify.com", attemptId: "attempt1", groupId: "g1" }, db);
  assert.equal(confirmed.status, "CONFIRMED_PROPOSAL");
  assert.equal(updates[0].decision, "NEW_PRODUCT_CONFIRMED");
  assert.equal(updates[1].decision, "USER_CONFIRMED_GROUP");
  group.rows[1].rawValuesJson = JSON.stringify({ Size: "M", Color: "Blue" });
  await assert.rejects(() => confirmProductProposalGroup({ shop: "shop.myshopify.com", attemptId: "attempt1", groupId: "g1" }, db), /same Size\/Color/);
});

test("Product group confirmation rejects stale/forged membership or lookup and rows cannot be matched while grouped", async () => {
  const valid = { lookupComplete: true, parentLookupComplete: true, candidates: [] };
  for (const patch of [
    { proposalGroupId: "other-group" },
    { outcome: "EXISTING_VARIANT" },
    { validationJson: '["invalid"]' },
    { proposalJson: JSON.stringify({ ...valid, candidates: [{ id: "variant" }] }) },
    { decision: "EXISTING_VARIANT_CONFIRMED" },
  ]) {
    const row = { id: "r1", proposalGroupId: "g1", outcome: "NEW_PRODUCT", validationJson: "[]", decision: null, proposalJson: JSON.stringify(valid), rowNumber: 2, rawValuesJson: '{"Size":"M"}', ...patch };
    const db = { receivingImportProposalGroup: { findFirst: async () => ({ id: "g1", status: "DRAFT", rows: [row] }) }, receivingImportAttempt: { findUniqueOrThrow: async () => ({ mappingJson: '{"size":"Size"}' }) } };
    await assert.rejects(() => confirmProductProposalGroup({ shop: "shop.myshopify.com", attemptId: "a1", groupId: "g1" }, db), /stale or invalid|conflicting confirmed/);
  }
  const admin = { graphql: async () => assert.fail("grouped rows must not query Shopify") };
  await assert.rejects(() => lookupReceivingRowMatch(admin, { shop: "shop.myshopify.com", attemptId: "a1", rowId: "r1" }, { receivingImportRow: { findFirst: async () => ({ id: "r1", proposalGroupId: "g1" }) } }), /Split this source row/);
});

test("splitting a source row safely unlinks it before a fresh product lookup", async () => {
  let rowUpdate;
  let groupUpdate;
  const db = {
    receivingImportRow: { findFirst: async () => ({ id: "r1", proposalGroupId: "g1", proposalGroup: { id: "g1", status: "DRAFT" } }) },
    $transaction: async (callback) => callback({
      receivingImportRow: { update: async ({ data }) => (rowUpdate = data), count: async () => 0 },
      receivingImportProposalGroup: { update: async ({ data }) => (groupUpdate = data) },
    }),
  };
  const result = await splitProductProposalRow({ shop: "shop.myshopify.com", attemptId: "a1", rowId: "r1" }, db);
  assert.equal(result.remainingRows, 0);
  assert.equal(rowUpdate.proposalGroupId, null);
  assert.equal(rowUpdate.outcome, "NEEDS_REVIEW");
  assert.equal(groupUpdate.status, "EMPTY");
});

test("duplicate merge confirms every compatible source row and preserves source row numbers", async () => {
  const updates = [];
  const rows = [
    { id: "r1", rowNumber: 2, sku: "A", quantity: 2, validationJson: "[]", decision: "MERGE_REQUIRED" },
    { id: "r2", rowNumber: 3, sku: "A", quantity: 3, validationJson: "[]", decision: "MERGE_REQUIRED" },
  ];
  const db = {
    receivingImportRow: { findFirst: async () => ({ ...rows[0], attempt: { mode: "RECEIVED", shipmentId: "sh1" } }), findMany: async () => rows, update: async ({ where, data }) => updates.push({ where, data }) },
    $transaction: async (callback) => callback({ receivingImportRow: { update: db.receivingImportRow.update } }),
  };
  const result = await confirmDuplicateSkuMerge({ shop: "shop.myshopify.com", attemptId: "attempt1", rowId: "r1" }, db);
  assert.equal(result.aggregateQuantity, 5);
  assert.deepEqual(result.sourceRows, [2, 3]);
  assert.equal(updates.length, 2);
  assert.ok(updates.every(({ data }) => JSON.parse(data.proposalJson).sourceRows.length === 2));
  await assert.rejects(() => recordReceivingMatchDecision({ shop: "shop.myshopify.com", attemptId: "attempt1", rowId: "r1", decision: "NEW_VARIANT" }, { receivingImportRow: { findFirst: async () => ({ id: "r1", outcome: "NEW_VARIANT", proposalJson: null, matchedProductId: null }), update: async () => {} } }), /parent Product/);
  rows[1].validationJson = '["conflicting product data"]';
  await assert.rejects(() => confirmDuplicateSkuMerge({ shop: "shop.myshopify.com", attemptId: "attempt1", rowId: "r1" }, db), /conflicting or invalid/);
});

test("Expected duplicate merge records source-row decisions without applying the plan, with range validation", async () => {
  const rows = [
    { id: "r1", rowNumber: 2, sku: "A", quantity: 2, validationJson: "[]", decision: "MERGE_REQUIRED" },
    { id: "r2", rowNumber: 3, sku: "A", quantity: 3, validationJson: "[]", decision: "MERGE_REQUIRED" },
  ];
  const events = [];
  const db = {
    receivingImportRow: { findFirst: async () => ({ ...rows[0], attempt: { mode: "EXPECTED", shipmentId: "sh1" } }), findMany: async () => rows },
    shipmentExpectation: { upsert: async () => events.push("expectation-outside") },
    $transaction: async (callback) => callback({
      shipmentExpectation: { upsert: async () => events.push("expectation") },
      receivingImportRow: { update: async () => events.push("row") },
    }),
  };
  await confirmDuplicateSkuMerge({ shop: "shop.myshopify.com", attemptId: "a1", rowId: "r1" }, db);
  assert.deepEqual(events, ["row", "row"]);
  rows[1].quantity = 2_147_483_646;
  await assert.rejects(() => confirmDuplicateSkuMerge({ shop: "shop.myshopify.com", attemptId: "a1", rowId: "r1" }, db), /supported integer range/);
  assert.deepEqual(events, ["row", "row"]);
});

test("confirmed Expected Goods attempts reject duplicate merge instead of implying plan changes", async () => {
  let transactionStarted = false;
  const db = {
    receivingImportRow: { findFirst: async () => ({ id: "r1", sku: "A", decision: "MERGE_REQUIRED", attempt: { mode: "EXPECTED", status: "EXPECTED_CONFIRMED" } }) },
    $transaction: async () => { transactionStarted = true; },
  };
  await assert.rejects(() => confirmDuplicateSkuMerge({ shop: "shop.myshopify.com", attemptId: "a1", rowId: "r1" }, db), /already confirmed/);
  assert.equal(transactionStarted, false);
});
