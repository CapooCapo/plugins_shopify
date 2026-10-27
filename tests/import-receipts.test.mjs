/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const helperSourceUrl = new URL("../app/utils/import-receipts.server.ts", import.meta.url);
const helperSource = await readFile(helperSourceUrl, "utf8");
const defaultPrismaImport = 'import prisma from "../db.server";';
assert.ok(helperSource.includes(defaultPrismaImport), "receipt helper must keep its default database dependency explicit");
const activityImport = 'import { activityCreateData, type ActivityActor } from "./activity-log.server";';
assert.ok(helperSource.includes(activityImport), "preview persistence must use the activity event factory");
const sourceWithInjectedPrismaStub = helperSource
  .replace(defaultPrismaImport, "const prisma = undefined;")
  .replace(activityImport, `const activityCreateData = (input) => ({ id: "activity-1", shop: input.shop, eventType: input.eventType, outcome: input.outcome, actorType: input.actor.actorType, actorId: input.actor.actorId, importBatchId: input.importBatchId ?? null, receiptCode: input.receiptCode ?? null, sourceKey: input.sourceKey, summary: input.summary, occurredAt: new Date(), createdAt: new Date(), metadataJson: JSON.stringify(input.metadata ?? null) });`);
const { outputText } = ts.transpileModule(sourceWithInjectedPrismaStub, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const helperUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const {
  DuplicateImportPreviewError,
  formatReceiptCode,
  ImportSubmissionConflictError,
  persistImportPreview,
  receiptDateKey,
} = await import(helperUrl);

const SHOP = "demo.myshopify.com";
const LOCATION = { id: "gid://shopify/Location/10", name: "Main warehouse" };

function makeInput(overrides = {}) {
  return {
    shop: SHOP,
    submissionId: "00000000-0000-4000-8000-000000000001",
    actor: "merchant@example.test",
    fileName: "delivery.csv",
    checksum: "sha256-same-csv",
    location: LOCATION,
    currencyCode: "VND",
    lines: [{
      id: "line-1",
      rowNumber: 2,
      sku: "SKU-1",
      quantity: 5,
      operationType: "ADJUST",
      status: "PREVIEWED",
      stage: "PREPARED",
      operationId: "operation-1",
      idempotencyKey: "idempotency-1",
    }],
    ...overrides,
  };
}

function makeDatabase() {
  const state = { batches: [], counters: new Map(), activities: [] };
  const project = (record, select) => {
    if (!record || !select) return record ? structuredClone(record) : null;
    return Object.fromEntries(
      Object.entries(select)
        .filter(([, selected]) => selected)
        .map(([field]) => [field, structuredClone(record[field])]),
    );
  };
  const findBySubmission = (shop, submissionId) =>
    state.batches.find((batch) => batch.shop === shop && batch.submissionId === submissionId) ?? null;
  const matchesCsv = (where) => state.batches.find((batch) =>
    batch.shop === where.shop &&
    batch.fileChecksum === where.fileChecksum &&
    (!where.id?.not || batch.id !== where.id.not),
  ) ?? null;

  const importBatch = {
    async findUnique({ where, select }) {
      const batch = findBySubmission(where.shop_submissionId.shop, where.shop_submissionId.submissionId);
      return project(batch, select);
    },
    async findFirst({ where, select }) {
      return project(matchesCsv(where), select);
    },
    async create({ data, select }) {
      // Yield so two concurrent transactions can both observe an unused token;
      // the unique index simulation below then makes one request recover the winner.
      await new Promise((resolve) => setImmediate(resolve));
      if (findBySubmission(data.shop, data.submissionId)) {
        const error = new Error("unique submission token");
        error.code = "P2002";
        throw error;
      }
      if (state.batches.some((batch) => batch.shop === data.shop && batch.receiptCode === data.receiptCode)) {
        const error = new Error("unique receipt code");
        error.code = "P2002";
        throw error;
      }
      const batch = {
        ...structuredClone(data),
        lines: structuredClone(data.lines.create),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      state.batches.push(batch);
      return project(batch, select);
    },
  };

  const importReceiptCounter = {
    async upsert({ where, create, update, select }) {
      const key = `${where.shop_dateKey.shop}:${where.shop_dateKey.dateKey}`;
      let counter = state.counters.get(key);
      if (counter) {
        counter.lastSequence += update.lastSequence.increment;
      } else {
        counter = structuredClone(create);
        state.counters.set(key, counter);
      }
      return project(counter, select);
    },
  };

  const activityLog = {
    async create({ data }) {
      state.activities.push(structuredClone(data));
      return structuredClone(data);
    },
  };

  const transaction = { importBatch, importReceiptCounter, activityLog };
  let transactionTail = Promise.resolve();
  const database = {
    ...transaction,
    async $transaction(callback) {
      // Model PostgreSQL's serializable decision boundary so concurrent
      // checksum checks cannot both create a preview in this focused test.
      const previous = transactionTail;
      let release;
      transactionTail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback(transaction);
      } finally {
        release();
      }
    },
  };
  return { database, state };
}

test("receipt helper formats UTC date keys and six-digit generated codes", () => {
  assert.equal(receiptDateKey(new Date("2026-10-22T04:30:00.000Z")), "20261022");
  assert.equal(formatReceiptCode("20261022", 123), "IMP-20261022-000123");
  assert.equal(formatReceiptCode("20261022", 1), "IMP-20261022-000001");
});

test("repeated preview submission with the same token reuses one batch and receipt", async () => {
  const { database, state } = makeDatabase();
  const input = makeInput();

  const first = await persistImportPreview(input, database);
  const repeated = await persistImportPreview(input, database);

  assert.match(first.receiptCode, /^IMP-\d{8}-\d{6}$/);
  assert.equal(repeated.batchId, first.batchId);
  assert.equal(repeated.receiptCode, first.receiptCode);
  assert.equal(first.duplicateCsv, false);
  assert.equal(repeated.duplicateCsv, false);
  assert.equal(state.batches.length, 1);
});

test("a successful preview and its audit event are persisted in the same transaction", async () => {
  const { database, state } = makeDatabase();
  const result = await persistImportPreview(makeInput({
    auditActor: { actorType: "SHOPIFY_USER", actorId: "42" },
  }), database);
  assert.equal(state.batches.length, 1);
  assert.equal(state.activities.length, 1);
  assert.equal(state.activities[0].eventType, "IMPORT_PREVIEWED");
  assert.equal(state.activities[0].importBatchId, result.batchId);
  assert.equal(state.activities[0].actorId, "42");
  assert.deepEqual(JSON.parse(state.activities[0].metadataJson), {
    rowCount: 1, blockedRows: 0, createDraftRows: 0, inventoryAddRows: 1,
  });
});

test("concurrent preview requests with the same token recover the unique-index winner", async () => {
  const { database, state } = makeDatabase();
  const input = makeInput();

  const [left, right] = await Promise.all([
    persistImportPreview(input, database),
    persistImportPreview(input, database),
  ]);

  assert.equal(left.batchId, right.batchId);
  assert.equal(left.receiptCode, right.receiptCode);
  assert.match(left.receiptCode, /^IMP-\d{8}-\d{6}$/);
  assert.equal(state.batches.length, 1);
});

test("a fresh token with identical shop-scoped CSV bytes returns the original receipt and creates no batch", async () => {
  const { database, state } = makeDatabase();
  const first = await persistImportPreview(makeInput(), database);
  await assert.rejects(
    persistImportPreview(makeInput({
      submissionId: "00000000-0000-4000-8000-000000000002",
      fileName: "delivery-copy.csv",
      lines: [{ ...makeInput().lines[0], id: "line-2", operationId: "operation-2", idempotencyKey: "idempotency-2" }],
    }), database),
    (error) => error instanceof DuplicateImportPreviewError
      && error.duplicate.batchId === first.batchId
      && error.duplicate.receiptCode === first.receiptCode
      && error.duplicate.status === "PREVIEWED",
  );
  assert.equal(state.batches.length, 1);
});

test("concurrent fresh tokens with identical CSV bytes create one preview and return its duplicate record", async () => {
  const { database, state } = makeDatabase();
  const [left, right] = await Promise.allSettled([
    persistImportPreview(makeInput({ submissionId: "00000000-0000-4000-8000-000000000003" }), database),
    persistImportPreview(makeInput({
      submissionId: "00000000-0000-4000-8000-000000000004",
      fileName: "delivery-copy.csv",
      lines: [{ ...makeInput().lines[0], id: "line-4", operationId: "operation-4", idempotencyKey: "idempotency-4" }],
    }), database),
  ]);

  const fulfilled = [left, right].filter((result) => result.status === "fulfilled");
  const rejected = [left, right].filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(state.batches.length, 1);
  assert.ok(rejected[0].reason instanceof DuplicateImportPreviewError);
  assert.equal(rejected[0].reason.duplicate.batchId, fulfilled[0].value.batchId);
});

test("an explicit repeat confirmation creates a distinct receipt without weakening normal duplicate protection", async () => {
  const { database, state } = makeDatabase();
  const first = await persistImportPreview(makeInput(), database);
  const second = await persistImportPreview(makeInput({
    submissionId: "00000000-0000-4000-8000-000000000005",
    fileName: "separate-delivery.csv",
    duplicateConfirmed: true,
    lines: [{ ...makeInput().lines[0], id: "line-5", operationId: "operation-5", idempotencyKey: "idempotency-5" }],
  }), database);

  assert.notEqual(second.batchId, first.batchId);
  assert.equal(second.duplicateCsv, true);
  assert.equal(state.batches.length, 2);
});

test("the import route exposes the duplicate receipt before any duplicate batch is created", async () => {
  const [newImport, receiptDetail] = await Promise.all([
    readFile(new URL("../app/routes/app.imports._index.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(newImport, /createHash\("sha256"\)\.update\(Buffer\.from\(fileBytes\)\)\.digest\("hex"\)/,
    "the upload route checksums original uploaded bytes rather than the filename");
  assert.match(newImport, /DuplicateImportPreviewError[\s\S]*?duplicateImport/,
    "the action returns the existing receipt record instead of redirecting to a new duplicate batch");
  assert.match(newImport, /Duplicate CSV Detected[\s\S]*?No duplicate batch was created/,
    "the upload UI explains the block and links to the prior receipt");
  assert.doesNotMatch(receiptDetail, /duplicateCsv|This CSV matches an earlier upload/,
    "receipt detail does not need a redirect-only duplicate warning");
});

test("a submission token cannot be replayed with a different CSV or location", async () => {
  const { database, state } = makeDatabase();
  const input = makeInput();
  const first = await persistImportPreview(input, database);

  await assert.rejects(
    persistImportPreview(makeInput({ checksum: "sha256-different-csv" }), database),
    ImportSubmissionConflictError,
  );
  await assert.rejects(
    persistImportPreview(makeInput({ location: { id: "gid://shopify/Location/11", name: "Other" } }), database),
    ImportSubmissionConflictError,
  );
  assert.equal(state.batches.length, 1);
  assert.equal(state.batches[0].id, first.batchId);
});

test("separate submissions receive unique codes while batch identity stays fixed", async () => {
  const { database, state } = makeDatabase();
  const receipts = await Promise.all([
    persistImportPreview(makeInput(), database),
    persistImportPreview(makeInput({
      submissionId: "00000000-0000-4000-8000-000000000002",
      checksum: "sha256-another-csv",
      lines: [{ ...makeInput().lines[0], id: "line-2", operationId: "operation-2", idempotencyKey: "idempotency-2" }],
    }), database),
  ]);

  assert.notEqual(receipts[0].receiptCode, receipts[1].receiptCode);
  assert.equal(state.batches.length, 2);
  for (const receipt of receipts) {
    const persisted = state.batches.find((batch) => batch.id === receipt.batchId);
    assert.equal(persisted.receiptCode, receipt.receiptCode);
    assert.equal(persisted.status, "PREVIEWED");
  }
});

test("merge retry reads the existing batch and reuses its receipt URI and idempotency key", async () => {
  const merge = await readFile(new URL("../app/utils/import-merge.server.ts", import.meta.url), "utf8");

  assert.match(merge, /referenceDocumentUri:\s*`stockhub:\/\/receipt\/\$\{encodeURIComponent\(batch\.receiptCode\)\}\/line\/\$\{line\.operationId\}`/);
  assert.match(merge, /key:\s*line\.idempotencyKey/);
  assert.match(merge, /where:\s*\{\s*id:\s*batchId,\s*shop\s*\}/);
  assert.doesNotMatch(merge, /formatReceiptCode|persistImportPreview/);
});
