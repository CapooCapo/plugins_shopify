/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const sharedUrl = new URL("../app/utils/size-guides.shared.ts", import.meta.url);
const liquidUrl = new URL("../extensions/stockhub-size-guide/blocks/size_guide.liquid", import.meta.url);
const projection = {
  title: "Everyday shirt",
  unit: "cm",
  columns: [
    { name: "Size", kind: "label" },
    { name: "Chest", kind: "measurement" },
    { name: "Length", kind: "measurement" },
  ],
  rows: [["S", "88", "64"], ["M", "94.5", "66"]],
};

async function loadShared() {
  const source = await readFile(sharedUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("Size Guide accepts arbitrary measurement columns and positive finite values", async () => {
  const { validateSizeGuideDraft } = await loadShared();
  const result = validateSizeGuideDraft(projection);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.columns, projection.columns);
  assert.deepEqual(result.value.rows, projection.rows);
});

test("Size Guide rejects invalid units, duplicate labels, malformed charts, and nonpositive measurements", async () => {
  const { validateSizeGuideDraft } = await loadShared();
  for (const measurement of ["0", "-1", "Infinity", "NaN", "0x10", ""]) {
    const result = validateSizeGuideDraft({ ...projection, rows: [["S", measurement, "64"]] });
    assert.equal(result.ok, false, `measurement ${JSON.stringify(measurement)} is rejected`);
    assert.match(result.errors.join(" "), /positive finite/);
  }
  assert.match(validateSizeGuideDraft({ ...projection, unit: "yards" }).errors.join(" "), /unit/);
  assert.match(validateSizeGuideDraft({ ...projection, rows: [["S", "88", "64"], ["s", "90", "65"]] }).errors.join(" "), /unique/);
  assert.match(validateSizeGuideDraft({ ...projection, columns: projection.columns.map((column) => ({ ...column, kind: "measurement" })) }).errors.join(" "), /exactly one/);
  assert.match(validateSizeGuideDraft({ ...projection, rows: [["S", "88"]] }).errors.join(" "), /every column/);
});

test("Storefront projection contains only public size-chart fields", async () => {
  const { sizeGuideStorefrontProjection } = await loadShared();
  const projected = sizeGuideStorefrontProjection({
    ...projection,
    id: "private-guide-id",
    updatedAt: "2026-10-29T00:00:00.000Z",
    shop: "private-store.myshopify.com",
    products: [{ productId: "private-product-id" }],
  });
  assert.deepEqual(Object.keys(projected), ["title", "unit", "columns", "rows"]);
  assert.equal(JSON.stringify(projected).includes("private-store"), false);
  assert.equal(JSON.stringify(projected).includes("private-guide-id"), false);
});

test("Theme block reads the current product's app-owned chart and provides dialog accessibility", async () => {
  const source = await readFile(liquidUrl, "utf8");
  assert.match(source, /product\.metafields\["\$app:size_guide"\]\.chart\.value/);
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /<dialog[\s\S]*?data-size-guide-dialog/);
  assert.match(source, /A size guide is not available for this product yet/);
  assert.match(source, /trigger_background/);
  assert.match(source, /trigger_text_colour/);
});

test("Theme block assigns row headers to the configured label column", async () => {
  const source = await readFile(liquidUrl, "utf8");
  assert.match(source, /assign cell_column = guide\.columns\[forloop\.index0\]/);
  assert.match(source, /if cell_column\.kind == "label" %}<th scope="row">/);
  assert.doesNotMatch(source, /if forloop\.first/);
});
