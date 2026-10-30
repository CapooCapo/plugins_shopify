/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CsvFormatError,
  MAX_CSV_ROWS,
  parseCsvPreview,
  resolveCsvMatch,
} from "../app/utils/csv.server.ts";

test("parses a BOM, CRLF, quoted commas, escaped quotes, and quoted newlines", () => {
  const source =
    '\uFEFF"sku","title","price","quantity"\r\n"SKU-1","A, ""quoted"" item\r\nSecond line","12.50","3"\r\n';

  const [row] = parseCsvPreview(source);

  assert.equal(row.rowNumber, 2);
  assert.equal(row.sku, "SKU-1");
  assert.equal(row.title, 'A, "quoted" item\r\nSecond line');
  assert.equal(row.price, "12.50");
  assert.equal(row.quantity, 3);
  assert.deepEqual(row.errors, []);
});

test("preserves description and image_url from a full product CSV row", () => {
  const source =
    'sku,title,description,price,quantity,image_url\n' +
    'SP-AOSOMI-001,Áo Sơ Mi Ngắn Tay Form Rộng (Oversized),"Áo sơ mi cổ bẻ tay ngắn chất liệu cotton thoáng mát, thiết kế form rộng thoải mái (Size L/XL).",250000,50,https://placehold.co/600x600/png?text=Oversized+Shirt\n';

  const [row] = parseCsvPreview(source);

  assert.equal(row.sku, "SP-AOSOMI-001");
  assert.equal(row.title, "Áo Sơ Mi Ngắn Tay Form Rộng (Oversized)");
  assert.equal(
    row.description,
    "Áo sơ mi cổ bẻ tay ngắn chất liệu cotton thoáng mát, thiết kế form rộng thoải mái (Size L/XL).",
  );
  assert.equal(row.price, "250000");
  assert.equal(row.quantity, 50);
  assert.equal(
    row.image_url,
    "https://placehold.co/600x600/png?text=Oversized+Shirt",
  );
  assert.deepEqual(row.errors, []);
});

test("marks every repeated exact upload SKU as invalid", () => {
  const rows = parseCsvPreview(
    "sku,title,quantity\nSKU-2,Hat,2\nSKU-2,Cap,1\n",
  );

  assert.equal(rows.length, 2);
  assert.ok(
    rows.every((row) =>
      row.errors.some((error) => error.includes("appears more than once")),
    ),
  );
});

test("reports missing required values and rejects invalid quantity and price", () => {
  const [row] = parseCsvPreview("sku,title,price,quantity\n,Hat,-1,0\n");

  assert.equal(row.quantity, null);
  assert.equal(row.price, null);
  assert.ok(row.errors.some((error) => error.includes("SKU is required")));
  assert.ok(
    row.errors.some((error) => error.includes("positive whole number")),
  );
  assert.ok(row.errors.some((error) => error.includes("non-negative decimal")));
});

test("rejects quantities above the signed GraphQL Int maximum", () => {
  const [maxRow, overflowRow] = parseCsvPreview(
    "sku,quantity\nSKU-INT-MAX,2147483647\nSKU-INT-OVERFLOW,2147483648\n",
  );

  assert.equal(maxRow.quantity, 2147483647);
  assert.deepEqual(maxRow.errors, []);
  assert.equal(overflowRow.quantity, null);
  assert.ok(
    overflowRow.errors.some((error) => /2147483647|GraphQL Int/i.test(error)),
    `expected an actionable GraphQL Int bound error, got: ${overflowRow.errors.join("; ")}`,
  );
});

test("rejects malformed quoting and empty/header-only files", () => {
  assert.throws(
    () => parseCsvPreview('sku,quantity\n"SKU-3,5\n'),
    CsvFormatError,
  );
  assert.throws(() => parseCsvPreview("\uFEFF\r\n"), CsvFormatError);
  assert.throws(() => parseCsvPreview("sku,quantity\n"), CsvFormatError);
});

test("rejects 1,001 inventory data rows instead of truncating the source", () => {
  const rows = Array.from(
    { length: 1001 },
    (_, index) => `SKU-${index},Item,1`,
  );
  assert.throws(
    () => parseCsvPreview(`sku,title,quantity\n${rows.join("\n")}`),
    /1,000|1000|row limit/i,
  );
});

test("accepts a complete 1,000-row inventory file with stable source row identities", () => {
  assert.equal(MAX_CSV_ROWS, 1000, "Inventory and Catalog uploads share a 1,000-row logical-file limit");
  const sourceRows = Array.from({ length: 1000 }, (_, index) =>
    `CAP-${String(index + 1).padStart(4, "0")},Capacity item ${index + 1},${index + 1}`,
  );
  const parsed = parseCsvPreview(`sku,title,quantity\n${sourceRows.join("\n")}`);

  assert.equal(parsed.length, 1000, "every CSV data row must be represented exactly once");
  assert.equal(parsed[0].rowNumber, 2);
  assert.equal(parsed[0].sku, "CAP-0001");
  assert.equal(parsed[0].quantity, 1);
  assert.equal(parsed.at(-1).rowNumber, 1001);
  assert.equal(parsed.at(-1).sku, "CAP-1000");
  assert.equal(parsed.at(-1).quantity, 1000);
  assert.ok(parsed.every((row) => row.errors.length === 0));
  assert.equal(new Set(parsed.map((row) => row.rowNumber)).size, 1000);
  assert.equal(new Set(parsed.map((row) => row.sku)).size, 1000);
});

test("accounts for duplicate SKUs at opposite ends of a 1,000-row inventory upload", () => {
  const sourceRows = Array.from({ length: 1000 }, (_, index) =>
    `${index === 999 ? "LATE-DUPLICATE" : index === 0 ? "LATE-DUPLICATE" : `UNIQUE-${index}`},Item ${index + 1},1`,
  );
  const parsed = parseCsvPreview(`sku,title,quantity\n${sourceRows.join("\n")}`);

  assert.equal(parsed.length, 1000);
  assert.equal(parsed[0].rowNumber, 2);
  assert.equal(parsed.at(-1).rowNumber, 1001);
  for (const row of [parsed[0], parsed.at(-1)]) {
    assert.ok(row.errors.some((error) => error.includes("appears more than once")),
      `duplicate SKU on source row ${row.rowNumber} must be blocked`);
  }
  assert.equal(parsed.slice(1, -1).filter((row) => row.errors.length > 0).length, 0);
});

test("calculates an aggregate proposed delta only for one exact match", () => {
  const resolved = resolveCsvMatch(
    { title: "Hat", quantity: 8 },
    [{ id: "variant-1", inventoryQuantity: 3 }],
    false,
  );

  assert.equal(resolved.matchStatus, "matched");
  assert.equal(resolved.proposedAdjustment, 5);
});

test("marks multiple exact matches ambiguous and incomplete lookups unresolved", () => {
  const ambiguous = resolveCsvMatch(
    { title: null, quantity: 4 },
    [
      { id: "variant-1", inventoryQuantity: 2 },
      { id: "variant-2", inventoryQuantity: 8 },
    ],
    false,
  );
  const unresolved = resolveCsvMatch({ title: null, quantity: 4 }, [], true);

  assert.equal(ambiguous.matchStatus, "ambiguous");
  assert.equal(ambiguous.proposedAdjustment, null);
  assert.equal(unresolved.matchStatus, "unresolved");
  assert.deepEqual(unresolved.missingFields, []);
});

test("identifies an unmatched row as a draft candidate only after lookup completes", () => {
  const complete = resolveCsvMatch({ title: null, quantity: 1 }, [], false);
  const incomplete = resolveCsvMatch({ title: null, quantity: 1 }, [], true);

  assert.equal(complete.matchStatus, "unmatched");
  assert.deepEqual(complete.missingFields, ["title"]);
  assert.equal(incomplete.matchStatus, "unresolved");
});
