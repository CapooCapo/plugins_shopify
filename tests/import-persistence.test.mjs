/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL("../prisma/schema.prisma", import.meta.url);
const initialMigrationUrl = new URL(
  "../prisma/migrations/20261022050000_create_import_batches/migration.sql",
  import.meta.url,
);
const receiptMigrationUrl = new URL(
  "../prisma/migrations/20261022100000_auto_generated_import_receipts/migration.sql",
  import.meta.url,
);
const importsRouteUrl = new URL("../app/routes/app.imports._index.tsx", import.meta.url);
const mergeUrl = new URL("../app/utils/import-merge.server.ts", import.meta.url);

test("receipt codes and submission tokens are store-scoped and permit repeated CSVs", async () => {
  const schema = await readFile(schemaUrl, "utf8");
  const migration = await readFile(receiptMigrationUrl, "utf8");

  assert.match(schema, /submissionId\s+String\?/);
  assert.match(schema, /receiptCode\s+String/);
  assert.match(schema, /@@unique\(\[shop,\s*submissionId\]\)/);
  assert.match(schema, /@@unique\(\[shop,\s*receiptCode\]\)/);
  assert.match(schema, /model ImportReceiptCounter\s*\{[\s\S]*?@@id\(\[shop,\s*dateKey\]\)/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "ImportBatch_shop_receiptCode_key" ON "ImportBatch"\("shop",\s*"receiptCode"\)/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "ImportBatch_shop_submissionId_key" ON "ImportBatch"\("shop",\s*"submissionId"\)/,
  );
  assert.match(migration, /CREATE TABLE "ImportReceiptCounter"/);
  assert.doesNotMatch(schema, /@@unique\([^\n]*fileChecksum/);
  assert.doesNotMatch(migration, /CREATE UNIQUE INDEX [^;]*fileChecksum/);
});

test("each import line has durable unique operation and idempotency identifiers", async () => {
  const schema = await readFile(schemaUrl, "utf8");
  const migration = await readFile(initialMigrationUrl, "utf8");

  assert.match(schema, /operationId\s+String\s+@unique/);
  assert.match(schema, /idempotencyKey\s+String\s+@unique/);
  assert.match(migration, /CREATE UNIQUE INDEX "ImportLine_operationId_key" ON "ImportLine"\("operationId"\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "ImportLine_idempotencyKey_key" ON "ImportLine"\("idempotencyKey"\)/);
});

test("New Import removes manual receipt entry and stays isolated from historical batches", async () => {
  const route = await readFile(importsRouteUrl, "utf8");
  const loader = route.slice(route.indexOf("export const loader"), route.indexOf("export const action"));
  const uploadForm = route.slice(route.indexOf('<Form method="post" encType="multipart/form-data"'));

  assert.doesNotMatch(route, /name=["']receiptKey["']/);
  assert.match(uploadForm, /name="submissionId"\s+value=\{data\.submissionId\}/);
  assert.doesNotMatch(loader, /prisma\.importBatch\.|prisma\.importLine\./,
    "New Import does not query historical batches when opened or reloaded");
});

test("receipt code is visible after preview, in merge confirmation, and in history", async () => {
  const [route, detail, history] = await Promise.all([
    readFile(importsRouteUrl, "utf8"),
    readFile(new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/routes/app.imports.history._index.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(history, /function\s+receiptCodeLabel\s*\([^)]*\)\s*\{[\s\S]*?receiptCode\?\.trim\(\)\s*\|\|\s*["'`]No receipt code recorded \(legacy batch\)["'`]/);
  assert.match(detail, /Receipt\s*\{batch\.receiptCode\}/,
    "the receipt detail heading must display its saved receipt code");
  assert.match(detail, /Confirm \$\{batch\.status === "PREVIEWED" \? "merge" : "resume"\} for receipt \$\{batch\.receiptCode\}/);
  assert.match(route, /return redirect\(`\/app\/imports\/history\/\$\{encodeURIComponent\(persisted\.batchId\)\}/,
    "a saved preview opens the receipt detail page that displays its generated code");
  assert.match(route, /This CSV matches an earlier upload in this store/);
  assert.match(route, /A new receipt was created for this submission/);
  assert.match(history, /receiptCodeLabel\(batch\.receiptCode\)/);
});

test("merge and resume submit the selected batch ID and do not create another receipt", async () => {
  const [route, detail] = await Promise.all([
    readFile(importsRouteUrl, "utf8"),
    readFile(new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url), "utf8"),
  ]);
  const mergeRoute = await readFile(mergeUrl, "utf8");
  const mergeAction = route.slice(
    route.indexOf('if (intent === "merge" || intent === "resume")'),
    route.indexOf('if (intent !== "preview")'),
  );

  assert.match(detail, /name="batchId"\s+value=\{batch\.id\}/);
  assert.match(mergeAction, /await mergeImportBatch\(\{\s*shop:\s*session\.shop,\s*batchId,\s*admin,\s*prisma,\s*\}\)/);
  assert.doesNotMatch(mergeAction, /persistImportPreview/);
  assert.match(mergeRoute, /referenceDocumentUri:\s*`stockhub:\/\/receipt\/\$\{encodeURIComponent\(batch\.receiptCode\)\}\/line\//);
  assert.match(mergeRoute, /export async function mergeImportBatch\([\s\S]*?where:\s*\{\s*id:\s*batchId,\s*shop\s*\}/);
});

test("merge still requires explicit confirmation and checks store-derived permissions server-side", async () => {
  const [route, detail] = await Promise.all([
    readFile(importsRouteUrl, "utf8"),
    readFile(new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(route, /if\s*\(intent\s*===\s*"merge"\s*\|\|\s*intent\s*===\s*"resume"\)\s*\{[\s\S]*formData\.get\("confirmed"\)\s*!==\s*"yes"/);
  assert.match(route, /where:\s*\{\s*id:\s*batchId,\s*shop:\s*session\.shop\s*\}/);
  assert.match(route, /const\s+neededScopes\s*=\s*new\s+Set\(\["read_products",\s*"read_inventory",\s*"read_locations",\s*"write_inventory"\]\)/);
  assert.match(route, /neededScopes\.add\("write_products"\)/);
  assert.match(detail, /window\.confirm\(`Confirm \$\{batch\.status === "PREVIEWED" \? "merge" : "resume"\}/);
});
