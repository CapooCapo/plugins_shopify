/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, root: resolve(process.cwd(), "app/utils"), appType: "custom", server: { middlewareMode: true }, logLevel: "error" });
const { evaluateCatalogQuality, SHOPIFY_MAX_PRODUCT_VARIANTS, SHOPIFY_MAX_PRODUCT_OPTIONS } = await vite.ssrLoadModule("/catalog-quality.shared.ts");
test.after(() => vite.close());

const row = (id, patch = {}) => ({ id, shop: "shop.myshopify.com", batchId: "batch-1", productName: "Shirt", sku: `SKU-${id}`, size: "M", color: null, price: "12.00", priceZeroConfirmed: false, sourceRowNumber: Number(id.replace(/\D/g, "")) || 2, ...patch });

test("derives missing/invalid price, unconfirmed zero, and explicit zero confirmation independently of group confirmation", () => {
  const rows = [row("r1", { price: null }), row("r2", { price: "0" }), row("r3", { price: "0", priceZeroConfirmed: true }), row("r4", { price: "-1" })];
  const result = evaluateCatalogQuality(rows);
  assert.deepEqual(result.rows.map((item) => item.state), ["WARNING", "WARNING", "READY", "ERROR"]);
  assert.equal(result.counts.warning, 2);
  assert.equal(result.counts.error, 1);
  assert.equal(result.counts.totalRows, 4);
  assert.equal(result.counts.totalGroups, 0);
  assert.equal(result.counts.totalIssues, 3);
  assert.match(result.issues.find((issue) => issue.code === "MISSING_PRICE").suggestion, /future|creating/i);
  assert.equal(result.issues.find((issue) => issue.code === "ZERO_PRICE_UNCONFIRMED").rowId, "r2");
});

test("reports missing name/SKU and duplicate batch SKUs on every affected row", () => {
  const result = evaluateCatalogQuality([row("r1", { sku: "DUP" }), row("r2", { sku: " dup " }), row("r3", { productName: "", sku: "" })]);
  assert.equal(result.rows[0].state, "ERROR");
  assert.equal(result.rows[1].state, "ERROR");
  assert.equal(result.issues.filter((issue) => issue.code === "DUPLICATE_SKU").length, 2);
  assert.equal(result.issues.filter((issue) => issue.code === "DUPLICATE_SKU").length, 2, "duplicate SKU is counted once for each affected row, not again as a group issue");
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_PRODUCT_NAME" && issue.rowId === "r3"));
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_SKU" && issue.rowId === "r3"));
});

test("retains invalid-price Error when draft persistence omits the unparseable decimal", () => {
  const result = evaluateCatalogQuality([row("r1", { price: null, errors: ["Price must be a non-negative decimal. The attempted value was “-3.00”."] })]);
  assert.equal(result.rows[0].state, "ERROR");
  assert.equal(result.issues.filter((issue) => issue.code === "INVALID_PRICE").length, 1);
  assert.ok(!result.issues.some((issue) => issue.code === "MISSING_PRICE"));
  const staleValidValue = evaluateCatalogQuality([row("r2", { price: "12.00", errors: ["Price must be a non-negative decimal. The attempted value was “-3.00”."] })]);
  assert.equal(staleValidValue.rows[0].state, "ERROR", "a retained previous price cannot mask an invalid attempted edit");
});

test("member row warnings/errors propagate into group state and summary without duplicate global issues", () => {
  const lines = [row("r1", { price: null, groupId: "g1", size: "M" }), row("r2", { productName: "", groupId: "g1", size: "L" })];
  const result = evaluateCatalogQuality(lines, [{ id: "g1", lines, issues: [] }]);
  assert.equal(result.groups[0].state, "ERROR");
  assert.ok(result.groups[0].issues.some((issue) => issue.code === "MISSING_PRICE" && issue.severity === "WARNING"));
  assert.ok(result.groups[0].issues.some((issue) => issue.code === "MISSING_PRODUCT_NAME" && issue.severity === "ERROR"));
  assert.equal(result.counts.totalIssues, 2, "group summary reuses member issues rather than duplicating them globally");
});

test("validates duplicate/missing option combinations over a merged group", () => {
  const lines = [row("r1", { size: "M", color: "Red" }), row("r2", { size: "M", color: "Red" }), row("r3", { size: "L", color: "" })];
  const result = evaluateCatalogQuality(lines, [{ id: "g1", lines, confirmedAt: new Date(), issues: [] }]);
  assert.ok(result.groups[0].issues.some((issue) => issue.code === "DUPLICATE_OPTION_COMBINATION"));
  assert.ok(result.groups[0].issues.some((issue) => issue.code === "MISSING_OPTION_VALUE"));
  assert.notEqual(result.groups[0].state, "READY");
});

test("missing image warning is configurable and group limits are explicit", () => {
  const base = [row("r1", { imageUrl: "" })];
  assert.equal(evaluateCatalogQuality(base).rows[0].state, "READY");
  assert.equal(evaluateCatalogQuality(base, [], { warnMissingImage: true }).rows[0].state, "WARNING");
  assert.equal(SHOPIFY_MAX_PRODUCT_VARIANTS, 2048);
  assert.equal(SHOPIFY_MAX_PRODUCT_OPTIONS, 3);
  const lines = Array.from({ length: 2 }, (_, i) => row(`r${i}`, { sku: `x${i}` }));
  const capped = evaluateCatalogQuality(lines, [{ id: "g1", lines, optionDimensions: ["Size", "Color", "Material", "Style"] }]);
  assert.ok(capped.groups[0].issues.some((issue) => issue.code === "OPTION_LIMIT_EXCEEDED"));
});

test("accepts the 2,048-variant boundary and errors at 2,049 without mutating proposals", () => {
  const atLimit = Array.from({ length: SHOPIFY_MAX_PRODUCT_VARIANTS }, (_, index) => row(`limit-${index}`, { sku: `LIMIT-${index}`, size: `Size ${index}` }));
  const atLimitResult = evaluateCatalogQuality(atLimit, [{ id: "at-limit", lines: atLimit }]);
  assert.ok(!atLimitResult.groups[0].issues.some((issue) => issue.code === "VARIANT_LIMIT_EXCEEDED"));
  const overLimit = [...atLimit, row("over-limit", { sku: "OVER-LIMIT", size: "Size over" })];
  const overLimitResult = evaluateCatalogQuality(overLimit, [{ id: "over-limit", lines: overLimit }]);
  assert.ok(overLimitResult.groups[0].issues.some((issue) => issue.code === "VARIANT_LIMIT_EXCEEDED"));
  assert.equal(atLimit.length, SHOPIFY_MAX_PRODUCT_VARIANTS);
  assert.equal(overLimit.length, SHOPIFY_MAX_PRODUCT_VARIANTS + 1);
});

test("quality evaluation is deterministic and does not mutate source rows or groups", () => {
  const lines = [row("r2"), row("r1")];
  const before = structuredClone(lines);
  const group = { id: "g1", lines, issues: [] };
  const first = evaluateCatalogQuality(lines, [group]);
  const second = evaluateCatalogQuality(lines, [group]);
  assert.deepEqual(first, second);
  assert.deepEqual(lines, before);
});
