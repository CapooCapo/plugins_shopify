/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: "custom",
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [], entries: [] },
  logLevel: "error",
});
test.after(async () => vite.close());

let alerts;
let importError;
try {
  alerts = await vite.ssrLoadModule("/app/utils/inventory-alerts.shared.ts");
} catch (error) {
  importError = error;
}
const { classifyInventoryAlert, filterInventoryAlertRows, paginateInventoryAlertRows,
  handleInventoryAlertsTableArrowKey, selectInventoryAlertExportRows, buildInventoryAlertsCsv } = alerts ?? {};
const helpersAvailable = [classifyInventoryAlert, filterInventoryAlertRows, paginateInventoryAlertRows,
  handleInventoryAlertsTableArrowKey, selectInventoryAlertExportRows, buildInventoryAlertsCsv]
  .every((helper) => typeof helper === "function");

function row(id, overrides = {}) {
  const quantity = overrides.availableQuantity ?? 2;
  const tracked = overrides.tracked ?? true;
  const complete = overrides.complete ?? true;
  return {
    productId: `gid://shopify/Product/${Math.ceil(id / 10)}`,
    variantId: `gid://shopify/ProductVariant/${id}`,
    inventoryItemId: `gid://shopify/InventoryItem/${id}`,
    productName: "Polo Shirt",
    productType: "Polo",
    sku: `POLO-${id}`,
    color: "Red",
    size: "S",
    availableQuantity: quantity,
    tracked,
    complete,
    status: classifyInventoryAlert({ tracked, availableQuantity: quantity, complete }),
    ...overrides,
  };
}

function parseCsv(csv) {
  const records = [];
  let fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (quoted && char === '"' && csv[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') quoted = !quoted;
    else if (!quoted && char === ",") { fields.push(field); field = ""; }
    else if (!quoted && char === "\n") { fields.push(field.replace(/\r$/, "")); records.push(fields); fields = []; field = ""; }
    else field += char;
  }
  if (field || fields.length) records.push([...fields, field]);
  return records;
}

test("Inventory Alerts shared helper contract is present", () => {
  assert.ok(helpersAvailable,
    `Expected /app/utils/inventory-alerts.shared.ts to export classification, filtering, pagination and CSV helpers${importError ? `; module load failed: ${importError.message}` : ""}`);
});

if (helpersAvailable) {
test("fixed threshold classifies zero/negative, 1–4, 5+, untracked, missing and partial distinctly", () => {
  const classify = (availableQuantity, extra = {}) => classifyInventoryAlert({
    tracked: true, availableQuantity, complete: true, ...extra,
  });
  assert.equal(classify(0), "OUT_OF_STOCK");
  assert.equal(classify(-3), "OUT_OF_STOCK", "negative quantity is preserved as an out-of-stock exception");
  assert.equal(classify(1), "LOW_STOCK");
  assert.equal(classify(4), "LOW_STOCK");
  assert.equal(classify(5), "IN_STOCK");
  assert.equal(classify(88), "IN_STOCK");
  assert.equal(classify(0, { tracked: false }), "UNTRACKED", "untracked is not zero stock");
  assert.equal(classify(null), "UNKNOWN", "missing quantity is not coerced to zero");
  assert.equal(classify(8, { complete: false }), "PARTIAL_DATA", "partial reads cannot become green");
});

test("variant identity, option values and duplicate SKUs survive normalization and filtering", () => {
  const redSmall = row(1, { sku: "DUPLICATE", color: "Red", size: "S", availableQuantity: 2 });
  const redMedium = row(2, { sku: "DUPLICATE", color: "Red", size: "M", availableQuantity: 0 });
  const blueMedium = row(3, { color: "Blue", size: "M", availableQuantity: 0 });
  const noOptions = row(4, { productType: null, color: null, size: null, selectedOptions: [{ name: "Material", value: "Linen" }] });
  assert.notEqual(redSmall.variantId, redMedium.variantId);
  assert.notEqual(redSmall.inventoryItemId, redMedium.inventoryItemId);
  assert.equal(redSmall.sku, redMedium.sku, "SKU is not an identity key");
  assert.deepEqual(filterInventoryAlertRows([redSmall, redMedium, blueMedium, noOptions], {
    status: "OUT_OF_STOCK", productType: "Polo", color: "Red", size: "M", search: "duplicate",
  }).map((item) => item.variantId), [redMedium.variantId], "filters compose over individual variants");
  assert.deepEqual(filterInventoryAlertRows([redSmall, redMedium, blueMedium, noOptions], {
    status: "ALL", productType: "", color: "", size: "", search: "gid://shopify/ProductVariant/4",
  }).map((item) => item.variantId), [noOptions.variantId], "search can match Shopify identity");
});

test("search, independent filters and pagination return accurate totals and bounded pages", () => {
  const rows = Array.from({ length: 25 }, (_, index) => row(index + 1, {
    productType: index % 2 ? "Polo" : "Tee",
    color: index % 3 ? "Red" : "Blue",
    size: index % 2 ? "M" : "S",
    sku: `SKU-${String(index + 1).padStart(2, "0")}`,
    availableQuantity: index % 5,
  }));
  const filtered = filterInventoryAlertRows(rows, {
    status: "LOW_STOCK", productType: "Polo", color: "Red", size: "M", search: "SKU-",
  });
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((item) => item.status === "LOW_STOCK" && item.productType === "Polo"
    && item.color === "Red" && item.size === "M" && item.sku.includes("SKU-")));
  const page = paginateInventoryAlertRows(rows, { page: 2, pageSize: 10 });
  assert.equal(page.total, 25);
  assert.equal(page.page, 2);
  assert.equal(page.pageSize, 10);
  assert.equal(page.pageCount, 3);
  assert.deepEqual(page.rows.map((item) => item.variantId), rows.slice(10, 20).map((item) => item.variantId));
  assert.equal(paginateInventoryAlertRows(rows, { page: 99, pageSize: 10 }).page, 3,
    "out-of-range pages clamp to the final valid page");
});

test("table region arrow keys scroll horizontally and leave boundaries and non-overflow alone", () => {
  const region = { scrollLeft: 0, scrollWidth: 1200, clientWidth: 300 };
  let prevented = 0;
  const key = (value) => handleInventoryAlertsTableArrowKey({
    key: value, currentTarget: region, preventDefault: () => { prevented += 1; },
  });

  assert.equal(key("ArrowRight"), true);
  assert.equal(region.scrollLeft, 60);
  assert.equal(prevented, 1);
  assert.equal(key("ArrowLeft"), true);
  assert.equal(region.scrollLeft, 0);
  assert.equal(prevented, 2);
  assert.equal(key("ArrowLeft"), false, "left boundary does not consume the key");
  assert.equal(prevented, 2);

  region.scrollLeft = region.scrollWidth - region.clientWidth;
  assert.equal(key("ArrowRight"), false, "right boundary does not consume the key");
  assert.equal(region.scrollLeft, 900);
  const noOverflow = { scrollLeft: 0, scrollWidth: 300, clientWidth: 300 };
  assert.equal(handleInventoryAlertsTableArrowKey({
    key: "ArrowRight", currentTarget: noOverflow, preventDefault: () => { prevented += 1; },
  }), false, "a non-overflowing region keeps ordinary key behavior");
  assert.equal(key("Enter"), false, "other keys are not intercepted");
  assert.equal(prevented, 2);
});

test("alert export uses the full filtered result, retains duplicate identities, and excludes non-alert or uncertain rows", () => {
  const rows = Array.from({ length: 30 }, (_, index) => row(index + 1, {
    sku: index < 2 ? "DUP-SKU" : `SKU-${index + 1}`,
    productType: "Polo", color: "Red", size: "M", availableQuantity: index % 3 === 0 ? 0 : 2,
  }));
  rows.push(row(31, { availableQuantity: 4, complete: false, status: "LOW_STOCK" }));
  rows.push(row(32, { availableQuantity: null, status: "UNKNOWN" }));
  rows.push(row(33, { availableQuantity: null, tracked: false, status: "UNTRACKED" }));
  const filters = { status: "ALL", productType: "Polo", color: "Red", size: "M", search: "" };
  const firstPage = paginateInventoryAlertRows(filterInventoryAlertRows(rows, filters), { page: 1, pageSize: 5 });
  const exportRows = selectInventoryAlertExportRows(rows, filters);
  assert.ok(firstPage.rows.length < exportRows.length, "CSV source is not limited to the visible page");
  assert.equal(exportRows.length, 30);
  assert.ok(exportRows.every((item) => ["OUT_OF_STOCK", "LOW_STOCK"].includes(item.status)
    && item.tracked === true && item.complete === true));
  assert.equal(new Set(exportRows.filter((item) => item.sku === "DUP-SKU").map((item) => item.variantId)).size, 2);
  assert.equal(selectInventoryAlertExportRows(rows, { ...filters, status: "LOW_STOCK" }).every((item) => item.status === "LOW_STOCK"), true);
  assert.deepEqual(selectInventoryAlertExportRows(rows, { ...filters, status: "IN_STOCK" }), []);
  assert.deepEqual(selectInventoryAlertExportRows(rows, { ...filters, status: "UNKNOWN" }), []);
});

test("CSV contains required Shopify identity/context, escapes text safely, and protects spreadsheet formulas", () => {
  const items = [
    row(101, { productId: "gid://shopify/Product/1001", variantId: "gid://shopify/ProductVariant/2001",
      inventoryItemId: "gid://shopify/InventoryItem/3001", productName: '=HYPERLINK("x","Polo, Red")\nLine 2',
      productType: "+Polo", sku: "-SKU", color: "@Red", size: "S", availableQuantity: -2,
      status: "OUT_OF_STOCK" }),
    row(102, { productId: "gid://shopify/Product/1001", variantId: "gid://shopify/ProductVariant/2002",
      inventoryItemId: "gid://shopify/InventoryItem/3002", productName: "Polo Shirt", sku: "DUP-SKU",
      color: "Red", size: "M", availableQuantity: 2, status: "LOW_STOCK" }),
  ];
  const csv = buildInventoryAlertsCsv(items, {
    locationScope: "All eligible active locations", checkedAt: "2026-10-29T08:00:00.000Z", dataSource: "LIVE",
  });
  const records = parseCsv(csv);
  const headers = records[0];
  const required = ["product_id", "variant_id", "inventory_item_id", "product_name", "product_type", "sku",
    "color", "size", "available_quantity", "status", "data_source", "location_scope", "checked_at"];
  for (const header of required) assert.ok(headers.includes(header), `CSV missing ${header}`);
  assert.equal(records.length, 3, "only provided OUT/LOW variants are emitted");
  const byVariant = (id) => records.slice(1).find((record) => record[headers.indexOf("variant_id")] === id);
  const out = byVariant("gid://shopify/ProductVariant/2001");
  assert.equal(out[headers.indexOf("product_id")], "gid://shopify/Product/1001");
  assert.equal(out[headers.indexOf("inventory_item_id")], "gid://shopify/InventoryItem/3001");
  assert.equal(out[headers.indexOf("available_quantity")], "-2", "numeric negative quantities stay numeric");
  assert.equal(out[headers.indexOf("product_name")], "'=HYPERLINK(\"x\",\"Polo, Red\")\nLine 2");
  assert.equal(out[headers.indexOf("product_type")], "'+Polo");
  assert.equal(out[headers.indexOf("sku")], "'-SKU");
  assert.equal(out[headers.indexOf("color")], "'@Red");
  assert.equal(out[headers.indexOf("data_source")], "LIVE");
  assert.equal(out[headers.indexOf("location_scope")], "All eligible active locations");
  assert.equal(out[headers.indexOf("checked_at")], "2026-10-29T08:00:00.000Z");
  const low = byVariant("gid://shopify/ProductVariant/2002");
  assert.equal(low[headers.indexOf("status")], "LOW_STOCK");

  const sampleCsv = buildInventoryAlertsCsv(items, {
    locationScope: "All eligible active locations", checkedAt: "2026-10-29T08:00:00.000Z", dataSource: "SAMPLE",
  });
  const sampleRecords = parseCsv(sampleCsv);
  const sampleHeaders = sampleRecords[0];
  assert.equal(sampleRecords[1][sampleHeaders.indexOf("data_source")], "SAMPLE",
    "downloaded demo data explicitly identifies itself as sample");
});
}
