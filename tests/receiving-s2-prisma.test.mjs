/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { confirmDuplicateSkuMerge, confirmExpectedGoods, confirmProductProposalGroup, createReceivingImport } from "../app/utils/receiving-import.server.ts";

const repo = resolve(new URL("..", import.meta.url).pathname);
const schemaFile = join(repo, "prisma/schema.prisma");

async function withTempPrisma(fn) {
  const dir = await mkdtemp(join(tmpdir(), "stockhub-s2-prisma-"));
  const database = join(dir, "isolated.sqlite");
  const schemaPath = join(dir, "schema.prisma");
  const schema = (await readFile(schemaFile, "utf8")).replace('url      = "file:dev.sqlite"', `url      = "file:${database}"`);
  await writeFile(schemaPath, schema);
  execFileSync(resolve(repo, "node_modules/.bin/prisma"), ["db", "push", "--schema", schemaPath, "--skip-generate"], { cwd: repo, stdio: "pipe" });
  const db = new PrismaClient({ datasources: { db: { url: `file:${database}` } } });
  try {
    await db.$connect();
    const now = new Date();
    await db.shipment.create({ data: { id: "s1", shop: "one.myshopify.com", referenceType: "TRACKING", reference: "ref-1", referenceNormalized: "REF-1", issuer: "Carrier", issuerNormalized: "CARRIER", updatedAt: now } });
    await fn(db);
  } finally {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}

test("temporary Prisma: Expected preview and duplicate merge do not write plan; explicit confirmation applies only valid/agreed rows once", async () => {
  await withTempPrisma(async (db) => {
    const input = { shop: "one.myshopify.com", shipmentId: "s1", mode: "EXPECTED", fileName: "expected.csv", source: "SKU,Quantity,Qty\nA,5,9\nBAD,nope,1\nC,2,2\nC,3,3\n", mapping: { quantity: "Quantity" } };
    const preview = await createReceivingImport(input, db);
    assert.equal(preview.status, "AWAITING_CONFIRMATION");
    assert.equal(await db.shipmentExpectation.count(), 0, "visible preview precedes any expectation writes");
    const duplicate = await createReceivingImport({ ...input, mapping: { quantity: "Qty" } }, db);
    assert.equal(duplicate.duplicateWarning, true);
    assert.equal(duplicate.status, "AWAITING_CONFIRMATION");
    assert.equal(duplicate.preview.rows[0].quantity, 5, "duplicate preview must show the persisted mapping, not an unpersisted override");
    assert.equal(await db.shipmentExpectation.count(), 0, "duplicate upload must not apply quantities");
    const duplicateRow = await db.receivingImportRow.findFirst({ where: { attemptId: preview.attemptId, sku: "C" } });
    await confirmDuplicateSkuMerge({ shop: input.shop, attemptId: preview.attemptId, rowId: duplicateRow.id }, db);
    assert.equal(await db.shipmentExpectation.count(), 0, "explicit merge still waits for final Expected Goods confirmation");
    const confirmed = await confirmExpectedGoods({ shop: input.shop, attemptId: preview.attemptId }, db);
    assert.equal(confirmed.appliedSkus, 2);
    assert.deepEqual(await db.shipmentExpectation.findMany({ where: { shipmentId: "s1" }, orderBy: { sku: "asc" }, select: { sku: true, expectedQty: true } }), [
      { sku: "A", expectedQty: 5 }, { sku: "C", expectedQty: 5 },
    ]);
    const replay = await confirmExpectedGoods({ shop: input.shop, attemptId: preview.attemptId }, db);
    assert.equal(replay.alreadyConfirmed, true);
    assert.equal(await db.shipmentExpectation.count(), 2);
  });
});

test("temporary Prisma: proposal confirmation rejects unauthorized, invalid, and stale/forged rows", async () => {
  await withTempPrisma(async (db) => {
    const attempt = await db.receivingImportAttempt.create({ data: { id: "a1", shop: "one.myshopify.com", shipmentId: "s1", mode: "EXPECTED", fileName: "p.csv", fileChecksum: "c", dedupeKey: "d", mappingJson: JSON.stringify({ size: "Size" }) } });
    const goodLookup = JSON.stringify({ lookupComplete: true, parentLookupComplete: true, candidates: [] });
    let rowNumber = 0;
    const createGroup = async (id, rowData = {}) => {
      const group = await db.receivingImportProposalGroup.create({ data: { id, attemptId: attempt.id, groupKey: id, productName: "Shirt" } });
      rowNumber += 1;
      await db.receivingImportRow.create({ data: { id: `row-${id}`, attemptId: attempt.id, rowNumber: rowNumber + 1, rawValuesJson: '{"Size":"M"}', sku: `sku-${id}`, quantity: 1, validationJson: "[]", outcome: "NEW_PRODUCT", proposalJson: goodLookup, proposalGroupId: group.id, ...rowData } });
      return group;
    };
    const invalid = await createGroup("invalid", { validationJson: '["bad quantity"]' });
    await assert.rejects(() => confirmProductProposalGroup({ shop: "one.myshopify.com", attemptId: attempt.id, groupId: invalid.id }, db), /stale or invalid/);
    const stale = await createGroup("stale", { proposalJson: JSON.stringify({ lookupComplete: true, parentLookupComplete: true, candidates: [{ id: "existing-variant" }] }) });
    await assert.rejects(() => confirmProductProposalGroup({ shop: "one.myshopify.com", attemptId: attempt.id, groupId: stale.id }, db), /stale or invalid/);
    await assert.rejects(() => confirmProductProposalGroup({ shop: "other.myshopify.com", attemptId: attempt.id, groupId: stale.id }, db), /empty or not owned/);
    const conflicting = await createGroup("conflicting", { decision: "EXISTING_VARIANT_CONFIRMED" });
    await assert.rejects(() => confirmProductProposalGroup({ shop: "one.myshopify.com", attemptId: attempt.id, groupId: conflicting.id }, db), /conflicting confirmed/);
  });
});
