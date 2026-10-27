/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createServer } from "vite";
import { suggestCatalogField } from "../app/utils/catalog-import.shared.ts";

const vite = await createServer({
  configFile: false,
  root: resolve(process.cwd(), "app/utils"),
  appType: "custom",
  server: { middlewareMode: true },
  logLevel: "error",
});
const catalog = await vite.ssrLoadModule("/catalog-import.server.ts");
test.after(() => vite.close());

const {
  checksumCatalogCsv,
  normalizeCatalogRows,
  parseCatalogCsv,
  validateCatalogMapping,
  validateCatalogUpload,
} = catalog;

test("suggests canonical fields from normalized English and Vietnamese aliases", () => {
  assert.equal(suggestCatalogField("Tên sản phẩm"), "productName");
  assert.equal(suggestCatalogField("Mã SKU"), "sku");
  assert.equal(suggestCatalogField("Đơn giá"), "price");
  assert.equal(suggestCatalogField("Nhà cung cấp"), "vendor");
  assert.equal(suggestCatalogField("Image URL"), "imageUrl");
  assert.equal(suggestCatalogField("Quantity"), null);
  assert.equal(suggestCatalogField("Stock Qty"), null);
  assert.equal(suggestCatalogField("Supplier-specific unknown"), null);
});

test("parses duplicate headers as distinct positional source columns and preserves source text", () => {
  const source = '\uFEFF"Tên sản phẩm",SKU,SKU,Color\r\n"Áo dài, xanh",VN-01,alternate,Đỏ\r\n';
  const parsed = parseCatalogCsv(source);

  assert.deepEqual(parsed.headers, ["Tên sản phẩm", "SKU", "SKU", "Color"]);
  assert.deepEqual(parsed.rows, [{
    rowNumber: 2,
    values: ["Áo dài, xanh", "VN-01", "alternate", "Đỏ"],
    sourceErrors: [],
  }]);
  assert.equal(checksumCatalogCsv(source).length, 64);
  assert.notEqual(checksumCatalogCsv(source), checksumCatalogCsv(source.trimEnd()));

  const mapped = validateCatalogMapping(parsed.headers, {
    "0": "productName",
    "1": "sku",
    "2": null,
    "3": "color",
  });
  assert.deepEqual(mapped, { 0: "productName", 1: "sku", 2: null, 3: "color" });
  const [normalized] = normalizeCatalogRows(parsed, mapped);
  assert.deepEqual(normalized.sourceValues, parsed.rows[0].values);
  assert.equal(normalized.normalized.productName, "Áo dài, xanh");
  assert.equal(normalized.normalized.color, "Đỏ");
  assert.equal(normalized.normalized.sku, "VN-01");
});

test("requires Product Name and SKU and rejects duplicate or invalid canonical mappings", () => {
  assert.throws(
    () => validateCatalogMapping(["Title", "SKU"], { 0: "productName" }),
    /map a source column to SKU/i,
  );
  assert.throws(
    () => validateCatalogMapping(["Name", "Product name", "SKU"], { 0: "productName", 1: "productName", 2: "sku" }),
    /productName is mapped more than once/i,
  );
  assert.throws(
    () => validateCatalogMapping(["Name", "SKU"], { 0: "title", 1: "sku" }),
    /invalid field mapping/i,
  );
  assert.throws(
    () => validateCatalogMapping(["Name", "SKU"], null),
    /choose a mapping/i,
  );
});

test("keeps Price optional and distinguishes blank, intentional-zero confirmation, and invalid values", () => {
  const csv = parseCatalogCsv("Product Name,SKU,Price\nHat,HAT-1,\nZero,ZERO-1,0\nNegative,NEG-1,-1\nBad,BAD-1,free\n");
  const rows = normalizeCatalogRows(csv, { 0: "productName", 1: "sku", 2: "price" });

  assert.equal(rows[0].price, null);
  assert.equal(rows[0].status, "READY");
  assert.equal(rows[1].price, "0");
  assert.equal(rows[1].status, "ERROR");
  assert.match(rows[1].errors.join(" "), /confirm.*zero/i);
  assert.equal(rows[2].status, "ERROR");
  assert.match(rows[2].errors.join(" "), /non-negative decimal/i);
  assert.equal(rows[3].status, "ERROR");
  assert.match(rows[3].errors.join(" "), /non-negative decimal/i);
});

test("upload parser rejects malformed CSV structure and validates extension", () => {
  assert.throws(() => parseCatalogCsv('Name,SKU\n"unterminated,SKU-1\n'), /malformed CSV/i);
  assert.throws(() => parseCatalogCsv('Name,SKU\n"Hat"oops,H-1\n'), /malformed CSV/i);
  const malformedRow = parseCatalogCsv("Name,SKU\nHat\n").rows[0];
  assert.match(malformedRow.sourceErrors.join(" "), /row 2 has 1 cells; expected 2/i);
  assert.throws(() => validateCatalogUpload("supplier.txt", "Name,SKU\nHat,HAT-1\n"), /\.csv/i);
});
