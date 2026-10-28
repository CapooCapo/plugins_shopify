/* eslint-env node */
/* global globalThis */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const databaseUrl = process.env.STOCKHUB_TEST_DATABASE_URL;
const catalogCsv = "Tên sản phẩm,SKU,SKU,Price,Quantity\nÁo Sơ Mi,VN-01,duplicate,12.50,8\nZero Price,VN-02,ignored,0,4\nMalformed,VN-03,ignored,9\n";
const mapping = { 0: "productName", 1: "sku", 2: null, 3: "price", 4: null };

async function setup(t, shop) {
  assert.ok(databaseUrl, "STOCKHUB_TEST_DATABASE_URL must point to the disposable local PostgreSQL database");
  const parsed = new URL(databaseUrl);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/stockhub_regression");
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  await prisma.$connect();
  const identity = await prisma.$queryRaw`SELECT current_database() AS database, version() AS version`;
  assert.equal(identity[0].database, "stockhub_regression");
  assert.match(identity[0].version, /PostgreSQL 16/i);
  t.after(async () => prisma.$disconnect());

  const calls = [];
  globalThis.__stockhubCatalogTest = {
    prisma,
    auth: async () => ({ session: { shop }, admin: { graphql: async (query) => { calls.push(query); throw new Error("Catalog draft routes must never call Shopify GraphQL"); } } }),
  };
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [{
      name: "stockhub-catalog-route-test-mocks",
      enforce: "pre",
      resolveId(source) {
        if (source === "../shopify.server") return "\0stockhub-catalog-test-shopify.server";
        if (source === "../db.server") return "\0stockhub-catalog-test-db.server";
        return null;
      },
      load(id) {
        if (id === "\0stockhub-catalog-test-shopify.server") return `export const authenticate = { admin: async (request) => globalThis.__stockhubCatalogTest.auth(request) };`;
        if (id === "\0stockhub-catalog-test-db.server") return `const prisma = globalThis.__stockhubCatalogTest.prisma; export default prisma;`;
        return null;
      },
    }],
    server: { middlewareMode: true, hmr: false },
    ssr: { noExternal: ["@shopify/shopify-app-react-router"] },
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    logLevel: "error",
  });
  t.after(async () => vite.close());
  const indexRoute = await vite.ssrLoadModule("/app/routes/app.imports.catalog._index.tsx");
  const detailRoute = await vite.ssrLoadModule("/app/routes/app.imports.catalog.$batchId.tsx");
  return { prisma, calls, indexAction: indexRoute.action, detailAction: detailRoute.action, detailLoader: detailRoute.loader };
}

function actionArgs(action, request, batchId) {
  return action({ request, params: batchId ? { batchId } : {}, context: {} });
}

function loaderArgs(loader, batchId, query = "") {
  return loader({ request: new Request(`http://localhost/app/imports/catalog/${batchId}${query}`), params: { batchId }, context: {} });
}

function mappingRequest(batchId, intent, version, value = mapping) {
  const form = new URLSearchParams({ intent, draftVersion: String(version), mapping: JSON.stringify(value) });
  return new Request(`http://localhost/app/imports/catalog/${batchId}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
  });
}

function catalogActionRequest(batchId, intent, version, fields = {}) {
  const form = new URLSearchParams({ intent, draftVersion: String(version), ...fields });
  return new Request(`http://localhost/app/imports/catalog/${batchId}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
  });
}

test("Catalog upload, mapping preview, confirmation, and draft CRUD stay isolated from inventory and Shopify", { skip: !databaseUrl }, async (t) => {
  const shop = `catalog-${crypto.randomUUID()}.myshopify.com`;
  const { prisma, calls, indexAction, detailAction, detailLoader } = await setup(t, shop);
  t.after(async () => prisma.catalogImportBatch.deleteMany({ where: { shop } }));

  const upload = new FormData();
  upload.set("file", new File([catalogCsv], "supplier.csv", { type: "text/csv" }));
  const uploaded = await actionArgs(indexAction, new Request("http://localhost/app/imports/catalog", { method: "POST", body: upload }));
  assert.equal(uploaded.status, 302);
  const batchId = decodeURIComponent(uploaded.headers.get("Location").split("/").at(-1));
  let batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });
  assert.equal(batch.status, "MAPPING");
  assert.equal(batch.originalCsv, catalogCsv, "uploaded source bytes decoded as UTF-8 are retained verbatim");
  assert.equal(batch.fileChecksum.length, 64);
  assert.deepEqual(batch.sourceHeaders, ["Tên sản phẩm", "SKU", "SKU", "Price", "Quantity"]);
  assert.equal(await prisma.catalogImportLine.count({ where: { shop, batchId } }), 0);

  const preview = await actionArgs(detailAction, mappingRequest(batchId, "preview-mapping", 0), batchId);
  assert.equal(preview.mappingPreview.rows[0].normalized.productName, "Áo Sơ Mi");
  assert.equal(preview.mappingPreview.rows[0].normalized.sku, "VN-01");
  assert.deepEqual(preview.mappingPreview.rows[0].sourceValues, ["Áo Sơ Mi", "VN-01", "duplicate", "12.50", "8"]);
  assert.equal(preview.mappingPreview.rows[1].price, "0");
  assert.ok(preview.mappingPreview.rows[1].errors.some((error) => /confirm.*zero/i.test(error)));
  assert.ok(preview.mappingPreview.rows[2].errors.some((error) => /row 4 has 4 cells; expected 5/i.test(error)));
  batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });
  assert.equal(batch.status, "MAPPING", "preview must not persist a draft or mutate source/mapping state");
  assert.equal(await prisma.catalogImportLine.count({ where: { shop, batchId } }), 0);

  const mapped = await actionArgs(detailAction, mappingRequest(batchId, "save-mapping", 0), batchId);
  assert.equal(mapped.status, 302);
  batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId }, include: { lines: { orderBy: { rowNumber: "asc" } } } });
  assert.equal(batch.status, "DRAFT");
  assert.equal(batch.draftVersion, 1);
  assert.equal(batch.lines.length, 3);
  assert.equal(batch.lines[0].sourceRowNumber, 2);
  assert.deepEqual(batch.lines[0].sourceValues, ["Áo Sơ Mi", "VN-01", "duplicate", "12.50", "8"]);
  assert.equal(batch.lines[0].price.toString(), "12.5");
  assert.equal(batch.lines[0].status, "READY");
  assert.equal(batch.lines[1].price.toString(), "0");
  assert.equal(batch.lines[1].status, "ERROR");
  assert.equal(batch.lines[2].status, "ERROR", "malformed-width source row is retained with its row-level error");
  const quality = await loaderArgs(detailLoader, batchId);
  assert.equal(quality.quality.counts.totalRows, 3);
  assert.equal(quality.quality.counts.totalGroups, quality.groups.length);
  assert.equal(quality.quality.counts.totalIssues, 2, "the fixture has one zero-price Warning and one malformed-row Error; group summaries do not duplicate either issue");
  assert.deepEqual(quality.quality.issues.map((issue) => issue.code).sort(), ["SOURCE_ROW_ERROR", "ZERO_PRICE_UNCONFIRMED"]);
  assert.equal(quality.quality.rows.find((row) => row.id === batch.lines[1].id).state, "WARNING", "unconfirmed zero price is warning severity, not Error");
  assert.equal(quality.quality.rows.find((row) => row.id === batch.lines[2].id).state, "ERROR", "malformed source row remains an Error");
  const imageWarningQuality = await loaderArgs(detailLoader, batchId, "?warnMissingImage=1");
  assert.ok(imageWarningQuality.quality.counts.warning > quality.quality.counts.warning, "image warning toggle adds Warning rows without inflating Errors");
  assert.equal(imageWarningQuality.quality.counts.error, quality.quality.counts.error);
  const sourceChecksum = batch.fileChecksum;

  const wrongShop = `other-${crypto.randomUUID()}.myshopify.com`;
  globalThis.__stockhubCatalogTest.auth = async () => ({ session: { shop: wrongShop }, admin: { graphql: async () => { throw new Error("Wrong-tenant request called Shopify"); } } });
  const crossShop = await actionArgs(detailAction, mappingRequest(batchId, "add", batch.draftVersion), batchId);
  assert.match(crossShop.error, /not found/i);
  assert.equal(await prisma.catalogImportBatch.count({ where: { shop: wrongShop, id: batchId } }), 0);

  globalThis.__stockhubCatalogTest.auth = async () => ({ session: { shop }, admin: { graphql: async (query) => { calls.push(query); throw new Error("Catalog draft routes must never call Shopify GraphQL"); } } });
  const stale = await actionArgs(detailAction, mappingRequest(batchId, "add", batch.draftVersion - 1), batchId);
  assert.match(stale.error, /changed in another tab/i);

  const zeroWithoutConfirmation = new URLSearchParams({ intent: "add", draftVersion: String(batch.draftVersion), productName: "Free sample", sku: "FREE-1", price: "0" });
  const rejectedZero = await actionArgs(detailAction, new Request(`http://localhost/app/imports/catalog/${batchId}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: zeroWithoutConfirmation }), batchId);
  assert.equal(rejectedZero.status, 302, "drafts preserve invalid input as an ERROR row for correction");
  let rows = await prisma.catalogImportLine.findMany({ where: { shop, batchId }, orderBy: { rowNumber: "asc" } });
  let manual = rows.at(-1);
  assert.equal(manual.sourceRowNumber, null);
  assert.deepEqual(manual.sourceValues, []);
  assert.equal(manual.status, "ERROR");
  assert.match(manual.errors.join(" "), /confirm.*zero/i);
  assert.equal(manual.price.toString(), "0");
  assert.equal(manual.priceZeroConfirmed, false);
  const manualId = manual.id;

  const zeroWithConfirmation = new URLSearchParams({ intent: "edit", draftVersion: String(batch.draftVersion + 1), lineId: manualId, productName: "Free sample", sku: "FREE-1", price: "0", priceZeroConfirmed: "on" });
  assert.equal((await actionArgs(detailAction, new Request(`http://localhost/app/imports/catalog/${batchId}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: zeroWithConfirmation }), batchId)).status, 302);
  rows = await prisma.catalogImportLine.findMany({ where: { shop, batchId }, orderBy: { rowNumber: "asc" } });
  manual = rows.at(-1);
  assert.equal(manual.id, manualId, "editing preserves the manual line's stable ID");
  assert.equal(manual.status, "READY");
  assert.equal(manual.priceZeroConfirmed, true);

  const edit = new URLSearchParams({ intent: "edit", draftVersion: String(batch.draftVersion + 2), lineId: manualId, productName: "Free sample corrected", sku: "FREE-1", price: "", description: "Edited" });
  assert.equal((await actionArgs(detailAction, new Request(`http://localhost/app/imports/catalog/${batchId}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: edit }), batchId)).status, 302);
  rows = await prisma.catalogImportLine.findMany({ where: { shop, batchId }, orderBy: { rowNumber: "asc" } });
  assert.equal(rows.at(-1).id, manualId, "editing preserves the manual line's stable ID");
  assert.equal(rows.at(-1).price, null, "blank Price remains absent, never zero");
  assert.equal(rows.at(-1).productName, "Free sample corrected");

  const beforeDeleteVersion = batch.draftVersion + 3;
  const remove = new URLSearchParams({ intent: "delete", draftVersion: String(beforeDeleteVersion), lineId: manualId });
  assert.equal((await actionArgs(detailAction, new Request(`http://localhost/app/imports/catalog/${batchId}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: remove }), batchId)).status, 302);
  assert.equal(await prisma.catalogImportLine.count({ where: { shop, batchId, id: manualId } }), 0);
  const finalBatch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });
  assert.equal(finalBatch.fileChecksum, sourceChecksum, "draft CRUD does not rewrite uploaded source/checksum");
  assert.equal(calls.length, 0, "Catalog upload, map, preview, and CRUD do not invoke Shopify GraphQL");
  assert.equal(await prisma.importBatch.count({ where: { shop } }), 0, "Catalog flow never creates an inventory ImportBatch");
});

test("PostgreSQL: one Catalog upload persists all 1,000 mapped source rows with stable identities and no Inventory receipt", { skip: !databaseUrl }, async (t) => {
  const shop = `catalog-capacity-${crypto.randomUUID()}.myshopify.com`;
  const { prisma, calls, indexAction, detailAction } = await setup(t, shop);
  t.after(async () => prisma.catalogImportBatch.deleteMany({ where: { shop } }));
  const sourceRows = Array.from({ length: 1000 }, (_, index) => {
    const group = Math.floor(index / 4) + 1;
    const size = ["S", "M", "L", "XL"][index % 4];
    return [`Style ${group}`, `CAP-${String(index + 1).padStart(4, "0")}`, `GROUP-${group}`, size, "Blue"].join(",");
  });
  const originalCsv = `Product Name,SKU,Product Group Code,Size,Color\n${sourceRows.join("\n")}`;
  const upload = new FormData();
  upload.set("file", new File([originalCsv], "catalog-capacity.csv", { type: "text/csv" }));
  const uploaded = await actionArgs(indexAction, new Request("http://localhost/app/imports/catalog", { method: "POST", body: upload }));
  assert.equal(uploaded.status, 302);
  const batchId = decodeURIComponent(uploaded.headers.get("Location").split("/").at(-1));
  const capacityMapping = { 0: "productName", 1: "sku", 2: "productGroupCode", 3: "size", 4: "color" };

  const mapped = await actionArgs(detailAction, mappingRequest(batchId, "save-mapping", 0, capacityMapping), batchId);
  assert.equal(mapped.status, 302);
  const batch = await prisma.catalogImportBatch.findFirstOrThrow({
    where: { shop, id: batchId },
    include: { lines: { orderBy: { rowNumber: "asc" } } },
  });
  assert.equal(batch.status, "DRAFT");
  assert.equal(batch.originalCsv, originalCsv, "the complete original source remains available for review/history");
  assert.equal(batch.lines.length, 1000);
  assert.equal(batch.lines[0].sourceRowNumber, 2);
  assert.deepEqual(batch.lines[0].sourceValues, ["Style 1", "CAP-0001", "GROUP-1", "S", "Blue"]);
  assert.equal(batch.lines[0].productGroupCode, "GROUP-1");
  assert.equal(batch.lines.at(-1).sourceRowNumber, 1001);
  assert.deepEqual(batch.lines.at(-1).sourceValues, ["Style 250", "CAP-1000", "GROUP-250", "XL", "Blue"]);
  assert.equal(batch.lines.filter((line) => line.status === "READY").length, 1000);
  assert.equal(await prisma.catalogImportLine.count({ where: { shop: `other-${shop}`, batchId } }), 0,
    "rows stay tenant-scoped even when an ID is known");
  assert.equal(await prisma.importBatch.count({ where: { shop, id: batchId } }), 0,
    "Catalog review persists to CatalogImport models and cannot create an Inventory receipt");
  assert.equal(calls.length, 0, "upload/mapping persistence performs no Shopify GraphQL request");
});

test("PostgreSQL: Catalog upload retry is idempotent by submissionId and identical shop-scoped checksum", { skip: !databaseUrl }, async (t) => {
  const shop = `catalog-upload-replay-${crypto.randomUUID()}.myshopify.com`;
  const { prisma, indexAction } = await setup(t, shop);
  t.after(async () => prisma.catalogImportBatch.deleteMany({ where: { shop } }));
  const submissionId = crypto.randomUUID();
  const content = "Product Name,SKU\nReplay item,REPLAY-1\n";
  const submit = async ({ id, fileName, csv = content }) => {
    const form = new FormData();
    form.set("submissionId", id);
    form.set("file", new File([csv], fileName, { type: "text/csv" }));
    return actionArgs(indexAction, new Request("http://localhost/app/imports/catalog", { method: "POST", body: form }));
  };

  const first = await submit({ id: submissionId, fileName: "supplier-a.csv" });
  assert.equal(first.status, 302);
  const firstLocation = first.headers.get("Location");
  const firstBatchId = decodeURIComponent(firstLocation.split("/").at(-1));
  const stored = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: firstBatchId } });
  assert.equal(stored.submissionId, submissionId, "the durable row must use the caller's stable upload identity");

  const replay = await submit({ id: submissionId, fileName: "supplier-a.csv" });
  assert.equal(replay.status, 302);
  assert.equal(replay.headers.get("Location"), firstLocation,
    "replaying the exact upload request must return the original mapping draft, not create another batch");

  const sameContent = await submit({ id: crypto.randomUUID(), fileName: "renamed-supplier.csv" });
  if (sameContent.status === 302) {
    assert.equal(sameContent.headers.get("Location"), firstLocation,
      "same-shop identical content may resolve to the existing draft, but not a duplicate batch");
  } else {
    assert.match(sameContent.error ?? "", /already|duplicate|existing|uploaded/i,
      "a duplicate checksum response must tell the merchant the source was already uploaded");
  }

  const conflictingReplay = await submit({
    id: submissionId,
    fileName: "supplier-a.csv",
    csv: "Product Name,SKU\nChanged content,REPLAY-2\n",
  });
  assert.notEqual(conflictingReplay.headers?.get("Location"), firstLocation,
    "a reused idempotency key with different file content must not silently resolve as the original request");
  assert.equal(await prisma.catalogImportBatch.count({ where: { shop } }), 1,
    "all retries and checksum duplicates leave exactly one CatalogImportBatch");
});

test("catalog mapping action rejects duplicate and missing required field mappings without persistence", { skip: !databaseUrl }, async (t) => {
  const shop = `catalog-mapping-guards-${crypto.randomUUID()}.myshopify.com`;
  const { prisma, indexAction, detailAction } = await setup(t, shop);
  t.after(async () => prisma.catalogImportBatch.deleteMany({ where: { shop } }));
  const upload = new FormData();
  upload.set("file", new File(["Name,Product name,SKU\nHat,Cap,HAT-1\n"], "mapping.csv", { type: "text/csv" }));
  const response = await actionArgs(indexAction, new Request("http://localhost/app/imports/catalog", { method: "POST", body: upload }));
  const batchId = decodeURIComponent(response.headers.get("Location").split("/").at(-1));
  const duplicate = await actionArgs(detailAction, mappingRequest(batchId, "preview-mapping", 0, { 0: "productName", 1: "productName", 2: "sku" }), batchId);
  assert.match(duplicate.error, /mapped more than once/i);
  const missing = await actionArgs(detailAction, mappingRequest(batchId, "preview-mapping", 0, { 0: null, 1: null, 2: "sku" }), batchId);
  assert.match(missing.error, /Product Name/i);
  assert.equal(await prisma.catalogImportLine.count({ where: { shop, batchId } }), 0);
  assert.equal((await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } })).status, "MAPPING");
});

test("catalog product groups persist as unconfirmed proposals with scoped accept, resolve, merge, split, and edit invalidation", { skip: !databaseUrl }, async (t) => {
  const shop = `catalog-groups-${crypto.randomUUID()}.myshopify.com`;
  const { prisma, calls, indexAction, detailAction, detailLoader } = await setup(t, shop);
  t.after(async () => prisma.catalogImportBatch.deleteMany({ where: { shop } }));
  const csv = [
    "Product Name,SKU,Product Group Code,Size,Color,Vendor",
    "Shirt,SH-1,STYLE-1,S,Blue,Maker",
    "Shirt,SH-2,STYLE-1,M,Blue,Maker",
    "Hat,HAT-1,,M,,Maker",
    "Hat,HAT-1,,M,,Maker",
  ].join("\n");
  const upload = new FormData();
  upload.set("file", new File([csv], "grouping.csv", { type: "text/csv" }));
  const uploaded = await actionArgs(indexAction, new Request("http://localhost/app/imports/catalog", { method: "POST", body: upload }));
  const batchId = decodeURIComponent(uploaded.headers.get("Location").split("/").at(-1));
  const mappingValue = { 0: "productName", 1: "sku", 2: "productGroupCode", 3: "size", 4: "color", 5: "vendor" };
  assert.equal((await actionArgs(detailAction, mappingRequest(batchId, "save-mapping", 0, mappingValue), batchId)).status, 302);
  let batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });
  let groups = await prisma.catalogImportGroup.findMany({ where: { shop, batchId, state: "ACTIVE" }, include: { lines: true } });
  assert.equal(groups.length, 2);
  const byCode = groups.find((group) => group.source === "productGroupCode");
  const byName = groups.find((group) => group.source === "productName");
  assert.ok(byCode && byName);
  assert.equal(byCode.confirmedAt, null);
  assert.equal(byName.confirmedAt, null);
  assert.deepEqual(byCode.lines.map((line) => line.sku).sort(), ["SH-1", "SH-2"]);
  assert.ok(Array.isArray(byName.validation));
  assert.ok(byName.validation.some((issue) => issue.code === "DUPLICATE_SKU"));
  assert.ok(byName.validation.some((issue) => issue.code === "DUPLICATE_OPTION_COMBINATION"));

  const otherUpload = new FormData();
  otherUpload.set("file", new File(["Product Name,SKU\nOther,O-1\n"], "other-batch.csv", { type: "text/csv" }));
  const otherCreated = await actionArgs(indexAction, new Request("http://localhost/app/imports/catalog", { method: "POST", body: otherUpload }));
  const otherBatchId = decodeURIComponent(otherCreated.headers.get("Location").split("/").at(-1));
  assert.equal((await actionArgs(detailAction, mappingRequest(otherBatchId, "save-mapping", 0, { 0: "productName", 1: "sku" }), otherBatchId)).status, 302);
  const otherGroup = await prisma.catalogImportGroup.findFirstOrThrow({ where: { shop, batchId: otherBatchId, state: "ACTIVE" } });
  const crossBatch = await actionArgs(detailAction, catalogActionRequest(batchId, "accept-group", batch.draftVersion, { groupId: otherGroup.id }), batchId);
  assert.match(crossBatch.error, /not found/i, "group IDs cannot cross import batches even within one shop");

  assert.equal((await actionArgs(detailAction, catalogActionRequest(batchId, "accept-group", batch.draftVersion, { groupId: byCode.id }), batchId)).status, 302);
  batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });
  let accepted = await prisma.catalogImportGroup.findFirstOrThrow({ where: { shop, batchId, id: byCode.id } });
  assert.ok(accepted.confirmedAt);
  const editRow = byCode.lines.find((line) => line.id === byCode.selections.productName.sourceLineId);
  assert.ok(editRow);
  const edited = catalogActionRequest(batchId, "edit", batch.draftVersion, {
    lineId: editRow.id, productName: "Top", sku: editRow.sku, productGroupCode: editRow.productGroupCode,
    size: editRow.size, color: editRow.color, vendor: editRow.vendor,
  });
  assert.equal((await actionArgs(detailAction, edited, batchId)).status, 302);
  accepted = await prisma.catalogImportGroup.findFirstOrThrow({ where: { shop, batchId, id: byCode.id } });
  assert.equal(accepted.confirmedAt, null, "editing a confirmed member invalidates group acceptance");
  assert.ok(accepted.validation.some((issue) => issue.code === "PRODUCT_FIELD_CONFLICT"));

  batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });
  const resolve = catalogActionRequest(batchId, "resolve-field", batch.draftVersion, { groupId: byCode.id, field: "productName", sourceLineId: byCode.lines.find((line) => line.id !== editRow.id).id });
  assert.equal((await actionArgs(detailAction, resolve, batchId)).status, 302);
  batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });
  assert.equal((await actionArgs(detailAction, catalogActionRequest(batchId, "accept-group", batch.draftVersion, { groupId: byCode.id }), batchId)).status, 302);
  batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });

  const wrongShop = `catalog-groups-other-${crypto.randomUUID()}.myshopify.com`;
  globalThis.__stockhubCatalogTest.auth = async () => ({ session: { shop: wrongShop }, admin: { graphql: async (query) => { calls.push(query); throw new Error("Group route called Shopify GraphQL"); } } });
  const crossShop = await actionArgs(detailAction, catalogActionRequest(batchId, "accept-group", batch.draftVersion, { groupId: byCode.id }), batchId);
  assert.match(crossShop.error, /not found/i);
  globalThis.__stockhubCatalogTest.auth = async () => ({ session: { shop }, admin: { graphql: async (query) => { calls.push(query); throw new Error("Catalog draft routes must never call Shopify GraphQL"); } } });

  const stale = await actionArgs(detailAction, catalogActionRequest(batchId, "merge-groups", batch.draftVersion - 1, { groupIds: JSON.stringify([byCode.id, byName.id]) }), batchId);
  assert.match(stale.error, /changed in another tab/i);
  assert.equal((await actionArgs(detailAction, catalogActionRequest(batchId, "merge-groups", batch.draftVersion, { groupIds: JSON.stringify([byCode.id, byName.id]) }), batchId)).status, 302);
  batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });
  groups = await prisma.catalogImportGroup.findMany({ where: { shop, batchId, state: "ACTIVE" }, include: { lines: true } });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].source, "MANUAL");
  assert.equal(groups[0].confirmedAt, null);
  assert.equal(groups[0].lines.length, 4);
  const afterMergeReload = await loaderArgs(detailLoader, batchId);
  assert.equal(afterMergeReload.groups.length, 1);
  assert.equal(afterMergeReload.groups[0].source, "MANUAL");
  assert.equal(afterMergeReload.groups[0].lines.length, 4, "a fresh loader read restores merged membership from PostgreSQL");
  assert.ok(groups[0].validation.some((issue) => issue.code === "DUPLICATE_OPTION_COMBINATION"), "merged validation compares Size combinations across the original suggested groups");
  const blockedAccept = await actionArgs(detailAction, catalogActionRequest(batchId, "accept-group", batch.draftVersion, { groupId: groups[0].id }), batchId);
  assert.match(blockedAccept.error, /resolve all group and row validation issues/i, "a merged group with duplicate Size values cannot be accepted");
  batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });
  assert.equal((await actionArgs(detailAction, catalogActionRequest(batchId, "split-selected", batch.draftVersion, { groupId: groups[0].id, lineIds: JSON.stringify([groups[0].lines[0].id]) }), batchId)).status, 302);
  groups = await prisma.catalogImportGroup.findMany({ where: { shop, batchId, state: "ACTIVE" }, include: { lines: true } });
  assert.equal(groups.length, 2);
  assert.equal(groups.reduce((total, group) => total + group.lines.length, 0), 4);
  assert.equal(groups.every((group) => group.confirmedAt === null), true);
  const afterSplitReload = await loaderArgs(detailLoader, batchId);
  assert.equal(afterSplitReload.groups.length, 2);
  assert.deepEqual(afterSplitReload.groups.map((group) => group.lines.length).sort(), [1, 3], "a fresh loader read restores split memberships from PostgreSQL");

  batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });
  const sameVersion = batch.draftVersion;
  const concurrentAdds = await Promise.all([
    actionArgs(detailAction, catalogActionRequest(batchId, "add", sameVersion, { productName: "Concurrent A", sku: "CONCURRENT-A" }), batchId),
    actionArgs(detailAction, catalogActionRequest(batchId, "add", sameVersion, { productName: "Concurrent B", sku: "CONCURRENT-B" }), batchId),
  ]);
  assert.equal(concurrentAdds.filter((result) => result.status === 302).length, 1, "exactly one same-version Add request wins");
  assert.equal(concurrentAdds.filter((result) => /changed in another tab/i.test(result.error ?? "")).length, 1, "the losing Add request is rejected as stale");
  const concurrentLines = await prisma.catalogImportLine.findMany({ where: { shop, batchId, sku: { in: ["CONCURRENT-A", "CONCURRENT-B"] } } });
  assert.equal(concurrentLines.length, 1, "only one concurrent row is persisted");
  assert.equal(calls.length, 0, "grouping actions never invoke Shopify GraphQL");
});

test("catalog Shopify comparison is shop-scoped, version-checked, paginated read-only, and never eligible for writes", { skip: !databaseUrl }, async (t) => {
  const shop = `catalog-compare-${crypto.randomUUID()}.myshopify.com`;
  const { prisma, calls, indexAction, detailAction } = await setup(t, shop);
  t.after(async () => {
    await prisma.catalogImportReview.deleteMany({ where: { shop } });
    await prisma.catalogImportBatch.deleteMany({ where: { shop } });
  });
  let graphqlCalls = 0;
  let mutateDuringRead = false;
  const graphql = async (query, options) => {
    graphqlCalls += 1;
    calls.push(query);
    assert.match(query, /^\s*#graphql\s*query/i, "comparison may only send a read query");
    assert.equal(options.variables.after, null);
    if (mutateDuringRead) {
      mutateDuringRead = false;
      await prisma.catalogImportBatch.updateMany({ where: { shop, id: batchId, draftVersion: { gt: 0 } }, data: { draftVersion: { increment: 1 } } });
    }
    return Response.json({ data: { shop: { myshopifyDomain: shop }, productVariants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
  };
  globalThis.__stockhubCatalogTest.auth = async () => ({ session: { shop }, admin: { graphql }, scopes: { query: async () => ({ granted: ["read_products"] }) } });
  const upload = new FormData();
  upload.set("file", new File(["Product Name,SKU,Price\nDesk Lamp,LAMP-1,25.00\n"], "compare.csv", { type: "text/csv" }));
  const uploaded = await actionArgs(indexAction, new Request("http://localhost/app/imports/catalog", { method: "POST", body: upload }));
  const batchId = decodeURIComponent(uploaded.headers.get("Location").split("/").at(-1));
  assert.equal((await actionArgs(detailAction, mappingRequest(batchId, "save-mapping", 0, { 0: "productName", 1: "sku", 2: "price" }), batchId)).status, 302);
  let batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId }, include: { groups: { where: { state: "ACTIVE" } } } });
  const accepted = await actionArgs(detailAction, catalogActionRequest(batchId, "accept-group", batch.draftVersion, { groupId: batch.groups[0].id }), batchId);
  assert.equal(accepted.status, 302);
  batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });
  const compared = await actionArgs(detailAction, catalogActionRequest(batchId, "compare-shopify", batch.draftVersion), batchId);
  assert.equal(compared.compareResult.draftVersion, batch.draftVersion);
  assert.equal(compared.compareResult.proposals[0].disposition, "CREATE");
  assert.equal(compared.compareResult.proposals[0].eligible, false);
  assert.equal(compared.compareResult.fingerprint.length, 64);
  assert.equal(graphqlCalls, 1);
  assert.ok(calls.every((query) => !/\bmutation\b/i.test(query)));

  globalThis.__stockhubCatalogTest.auth = async () => ({ session: { shop }, admin: { graphql }, scopes: { query: async () => ({ granted: [] }) } });
  const missingScope = await actionArgs(detailAction, catalogActionRequest(batchId, "compare-shopify", batch.draftVersion), batchId);
  assert.match(missingScope.error, /read_products/i);
  assert.equal(graphqlCalls, 1, "current read_products grant is checked before Shopify GraphQL");
  globalThis.__stockhubCatalogTest.auth = async () => ({ session: { shop }, admin: { graphql }, scopes: { query: async () => { throw new Error("scope API unavailable"); } } });
  const unavailableScope = await actionArgs(detailAction, catalogActionRequest(batchId, "compare-shopify", batch.draftVersion), batchId);
  assert.match(unavailableScope.error, /could not verify.*permission/i);
  assert.equal(graphqlCalls, 1, "unavailable scope verification fails closed before Shopify GraphQL");
  globalThis.__stockhubCatalogTest.auth = async () => ({ session: { shop }, admin: { graphql }, scopes: { query: async () => ({ granted: ["read_products"] }) } });

  mutateDuringRead = true;
  const concurrent = await actionArgs(detailAction, catalogActionRequest(batchId, "compare-shopify", batch.draftVersion), batchId);
  assert.match(concurrent.error, /changed while Shopify was being read/i);
  assert.equal(graphqlCalls, 2, "draft changes during Shopify pagination invalidate the preview");
  batch = await prisma.catalogImportBatch.findFirstOrThrow({ where: { shop, id: batchId } });

  const stale = await actionArgs(detailAction, catalogActionRequest(batchId, "compare-shopify", batch.draftVersion - 1), batchId);
  assert.match(stale.error, /changed in another tab/i);
  assert.equal(graphqlCalls, 2, "stale draft versions are rejected before Shopify reads");
  globalThis.__stockhubCatalogTest.auth = async () => ({ session: { shop: `other-${shop}` }, admin: { graphql }, scopes: { query: async () => ({ granted: ["read_products"] }) } });
  const crossShop = await actionArgs(detailAction, catalogActionRequest(batchId, "compare-shopify", batch.draftVersion), batchId);
  assert.match(crossShop.error, /not found/i);
  assert.equal(graphqlCalls, 2, "another shop cannot discover this draft or trigger its Shopify query");
  globalThis.__stockhubCatalogTest.auth = async () => ({ session: { shop }, admin: { graphql: async (query) => { calls.push(query); throw new Error("Unexpected Shopify query"); } }, scopes: { query: async () => ({ granted: ["read_products"] }) } });
});
