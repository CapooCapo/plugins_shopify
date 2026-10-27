/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: resolve(process.cwd(), "app/utils"),
  appType: "custom",
  server: { middlewareMode: true },
  logLevel: "error",
});
const grouping = await vite.ssrLoadModule("/catalog-grouping.shared.ts");
test.after(() => vite.close());

const { normalizeCatalogGroupingValue, proposeCatalogProductGroups, validateCatalogVariantOptions } = grouping;
const line = (id, overrides = {}) => ({
  id,
  shop: "shop-a.myshopify.com",
  batchId: "batch-1",
  sourceRowNumber: Number(id.replace(/\D/g, "")) || 1,
  productName: " Classic Tee ",
  sku: `TEE-${id}`,
  sourceValues: [`original-${id}`],
  ...overrides,
});

test("normalizes deterministically while preserving accents and punctuation", () => {
  assert.equal(normalizeCatalogGroupingValue("  Ａ́o   Dài—Mẫu!  "), "áo dài—mẫu!");
  assert.equal(normalizeCatalogGroupingValue("MiXeD   Case"), "mixed case");
});

test("groups by normalized Group Code first and never confirms automatically", () => {
  const proposals = proposeCatalogProductGroups([
    line("row-2", { productGroupCode: " STYLE   01 ", size: "M" }),
    line("row-1", { productGroupCode: "style 01", size: "S" }),
    line("row-3", { productGroupCode: "other", productName: "Classic Tee", size: "S" }),
  ]);
  const style = proposals.find((proposal) => proposal.normalizedValue === "style 01");

  assert.equal(proposals.length, 2);
  assert.equal(style.source, "productGroupCode");
  assert.match(style.reason, /Product Group Code matches/);
  assert.deepEqual(style.lines.map(({ id }) => id), ["row-1", "row-2"]);
  assert.equal(style.optionMode, "size");
  assert.equal(style.confirmed, false);
  assert.equal(proposals.every((proposal) => proposal.confirmed === false), true);
});

test("falls back to normalized Product Name and does not derive grouping or options from SKU", () => {
  const proposals = proposeCatalogProductGroups([
    line("r1", { productName: "  Classic   Tee ", sku: "TEE-RED-S" }),
    line("r2", { productName: "classic tee", sku: "TEE-BLUE-M" }),
  ]);

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].source, "productName");
  assert.equal(proposals[0].normalizedValue, "classic tee");
  assert.equal(proposals[0].optionMode, "single");
  assert.equal(proposals[0].valid, false);
  assert.equal(proposals[0].issues[0].code, "MISSING_OPTION_VALUE");
});

test("supports Size × Color options and detects duplicate combinations and missing values", () => {
  const proposals = proposeCatalogProductGroups([
    line("r1", { size: "M", color: "Blue" }),
    line("r2", { size: "M", color: " blue " }),
    line("r3", { size: "L", color: "" }),
  ]);
  const [proposal] = proposals;

  assert.equal(proposal.optionMode, "sizeColor");
  assert.equal(proposal.issues.some(({ code }) => code === "DUPLICATE_OPTION_COMBINATION"), true);
  assert.equal(proposal.issues.some(({ code, lineIds }) => code === "MISSING_OPTION_VALUE" && lineIds.includes("r3")), true);
});

test("flags duplicate SKU across different proposed groups in the same batch", () => {
  const proposals = proposeCatalogProductGroups([
    line("r1", { productName: "First", sku: " shared-1 " }),
    line("r2", { productName: "Second", sku: "SHARED-1" }),
  ]);
  assert.equal(proposals.length, 2);
  assert.equal(proposals.every((proposal) => proposal.issues.some(({ code }) => code === "DUPLICATE_SKU")), true);
});

test("marks product-level conflicts within a Group Code proposal", () => {
  const [proposal] = proposeCatalogProductGroups([
    line("r1", { productGroupCode: "STYLE-01", productName: "Shirt", vendor: "Vendor A", size: "S" }),
    line("r2", { productGroupCode: "style-01", productName: "Top", vendor: "Vendor B", size: "M" }),
  ]);
  assert.equal(proposal.issues.filter(({ code }) => code === "PRODUCT_FIELD_CONFLICT").length, 2);
  assert.equal(proposal.valid, false);
});

test("isolates shop and batch scopes, preserves source data, and returns stable order", () => {
  const inputs = [
    line("same-2", { size: "M" }),
    line("same-1", { size: "S" }),
    line("shop-b", { shop: "shop-b.myshopify.com", size: "L" }),
    line("batch-b", { batchId: "batch-2", size: "XL" }),
  ];
  const original = structuredClone(inputs);
  const first = proposeCatalogProductGroups(inputs);
  const second = proposeCatalogProductGroups(inputs);

  assert.deepEqual(inputs, original);
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.equal(first.every((proposal) => proposal.lines.every((member) => member.shop === proposal.shop && member.batchId === proposal.batchId)), true);
  assert.deepEqual(first.flatMap((proposal) => proposal.lines.map(({ id }) => id)).sort(), ["batch-b", "same-1", "same-2", "shop-b"]);
  assert.equal(first[0].lines[0].sourceValues[0], "original-same-1");
});

test("a single variant is valid without Size or Color; missing SKU/name is explicit", () => {
  const [proposal] = proposeCatalogProductGroups([
    line("only", { productName: "Hat", sku: "HAT-1", size: null, color: null }),
  ]);
  assert.equal(proposal.optionMode, "single");
  assert.equal(proposal.valid, true);

  const [invalid] = proposeCatalogProductGroups([line("bad", { productName: " ", sku: " " })]);
  assert.equal(invalid.issues.some(({ code }) => code === "MISSING_PRODUCT_NAME"), true);
  assert.equal(invalid.issues.some(({ code }) => code === "MISSING_SKU"), true);
});

test("a Product Group Code beginning with the former missing-name marker remains valid", () => {
  const [proposal] = proposeCatalogProductGroups([
    line("code-prefix", { productName: "A real product", sku: "P-1", productGroupCode: "__missing_name__:legacy-code" }),
  ]);
  assert.equal(proposal.source, "productGroupCode");
  assert.equal(proposal.normalizedValue, "__missing_name__:legacy-code");
  assert.equal(proposal.issues.some(({ code }) => code === "MISSING_PRODUCT_NAME"), false);
});

test("merchant-merged variant validation catches duplicate Size across source groups", () => {
  const merged = [
    line("source-a", { productName: "Style A", sku: "SKU-A", size: "M" }),
    line("source-b", { productName: "Style B", sku: "SKU-B", size: "m" }),
  ];
  assert.equal(proposeCatalogProductGroups(merged).length, 2, "source rows begin in separate suggested groups");
  const issues = validateCatalogVariantOptions(merged);
  assert.equal(issues.some(({ code, lineIds }) => code === "DUPLICATE_OPTION_COMBINATION" && lineIds.length === 2), true);
});

test("merchant-merged validation catches missing Size across source groups", () => {
  const merged = [
    line("source-with-size", { productName: "Style A", sku: "SKU-A", size: "M" }),
    line("source-without-size", { productName: "Style B", sku: "SKU-B", size: " " }),
  ];
  assert.equal(proposeCatalogProductGroups(merged).length, 2, "source rows begin in separate suggested groups");
  const issues = validateCatalogVariantOptions(merged);
  assert.equal(issues.some(({ code, lineIds, field }) => code === "MISSING_OPTION_VALUE" && lineIds.includes("source-without-size") && field === "size"), true);
});
