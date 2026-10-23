/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyReceivingMatch, parseReceivingCsv } from "../app/utils/csv.server.ts";

test("suggests Vietnamese and English headers and preserves leading zero SKU/source values", () => {
  const preview = parseReceivingCsv("Mã SKU,Số lượng,Tên sản phẩm,Màu sắc\n00123,2,Áo sơ mi,Đỏ\n");
  assert.deepEqual(preview.fileErrors, []);
  assert.equal(preview.mapping.sku, "Mã SKU");
  assert.equal(preview.rows[0].sku, "00123");
  assert.equal(preview.rows[0].rawValues["Mã SKU"], "00123");
  assert.equal(preview.rows[0].color, "Đỏ");
});

test("manual column override resolves ambiguous header suggestions, while absent required mapping stays file-blocked", () => {
  const selected = parseReceivingCsv("SKU,Mã SKU,Quantity\nWRONG,00123,2\n", { sku: "Mã SKU" });
  assert.deepEqual(selected.fileErrors, []);
  assert.equal(selected.rows[0].sku, "00123");
  const unresolved = parseReceivingCsv("SKU,Mã SKU,Quantity\nA,B,2\n");
  assert.ok(unresolved.fileErrors.some((error) => error.includes("choose manually")));
  const missing = parseReceivingCsv("Name,Count\nHat,2\n");
  assert.ok(missing.fileErrors.some((error) => error.includes("Map both SKU and Quantity")));
});

test("blocks duplicate semantic mappings and ragged CSV rows as unreliable file structure", () => {
  const reused = parseReceivingCsv("SKU,Quantity\nA,2\n", { sku: "SKU", quantity: "SKU" });
  assert.ok(reused.fileErrors.some((error) => error.includes("mapped to more than one field")));
  const ragged = parseReceivingCsv("SKU,Quantity\nA,2,unexpected\nB\n");
  assert.equal(ragged.rows[0].rawValues.SKU, "A");
  assert.ok(ragged.fileErrors.some((error) => error.includes("file-level structure is unreliable")));
  assert.ok(ragged.rows.every((row) => row.errors.some((error) => error.includes("structure is unreliable"))));
});

test("separates file mapping failures from row-level errors and retains all 100 source rows", () => {
  const rows = Array.from({ length: 100 }, (_, i) => `${i < 95 ? `SKU-${i}` : ""},${i < 95 ? "1" : "bad"}`).join("\n");
  const preview = parseReceivingCsv(`SKU,Quantity\n${rows}`);
  assert.deepEqual(preview.fileErrors, []);
  assert.equal(preview.rows.length, 100);
  assert.equal(preview.rows.filter((row) => !row.errors.length).length, 95);
  assert.equal(preview.rows.filter((row) => row.errors.length).length, 5);
  assert.equal(preview.rows[99].rowNumber, 101);
  assert.equal(parseReceivingCsv("Name,Count\nHat,2").fileErrors.length > 0, true);
});

test("duplicate SKU source rows require explicit merge and conflicting product fields are blocked", () => {
  const same = parseReceivingCsv("SKU,Quantity,Product Name\nA,2,Hat\nA,3,Hat\n");
  assert.ok(same.rows.every((row) => row.duplicateDecisionRequired && !row.duplicateConflict));
  const conflict = parseReceivingCsv("SKU,Quantity,Product Name\nA,2,Hat\nA,3,Cap\n");
  assert.ok(conflict.rows.every((row) => row.duplicateConflict && row.errors.length));
});

test("matching never auto-selects ambiguous variants and new entity outcomes require confirmation", () => {
  assert.equal(classifyReceivingMatch({ variants: [{ productId: "p1", variantId: "v1", sku: "A" }, { productId: "p2", variantId: "v2", sku: "A" }], lookupComplete: true }).outcome, "NEEDS_REVIEW");
  assert.equal(classifyReceivingMatch({ variants: [], lookupComplete: true, productName: "Hat" }).outcome, "NEW_PRODUCT");
  assert.equal(classifyReceivingMatch({ variants: [], lookupComplete: true, productName: "Shirt", productGroup: "G", size: "XL" }).requiresConfirmation, true);
  assert.equal(classifyReceivingMatch({ variants: [], lookupComplete: false, productName: "Hat" }).outcome, "NEEDS_REVIEW");
});
