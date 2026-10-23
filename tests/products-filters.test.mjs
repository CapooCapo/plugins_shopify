/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const productsRoute = new URL("../app/routes/app.products.tsx", import.meta.url);
const productsCatalog = new URL("../app/components/ProductsCatalog.tsx", import.meta.url);

test("Products supports bounded name and SKU search, status filters, and cursor pagination", async () => {
  const source = await readFile(productsRoute, "utf8");
  const view = await readFile(productsCatalog, "utf8");

  assert.match(source, /PRODUCT_STATUS_FILTERS\s*=\s*\["active",\s*"draft",\s*"archived",\s*"unlisted"\]/);
  assert.match(source, /parseStatusFilter\(url\.searchParams\.get\("status"\)\)/);
  assert.match(source, /const PAGE_SIZES = \[10, 25, 50\] as const/);
  assert.match(source, /const pageSize = parsePageSize\(url\.searchParams\.get\("pageSize"\)\)/);
  assert.match(source, /first: movingBackward \? null : pageSize/);
  assert.match(source, /last: movingBackward \? pageSize : null/);
  assert.match(source, /pageSize=\{pageSize\}/,
    "selected page size must reach the catalog presentation");
  assert.match(source, /: "all";/,
    "unrecognized status parameters must fall back to All rather than enter the Shopify query");
  assert.match(source, /searchBy:\s*ProductSearchBy\s*=\s*url\.searchParams\.get\("searchBy"\) === "sku" \? "sku" : "name"/);
  assert.match(source, /search\s*\?\s*`title:\$\{JSON\.stringify\(search\)\}`/);
  assert.match(source, /search\s*\?\s*`sku:\$\{JSON\.stringify\(search\)\}`/);
  assert.match(source, /product_status:\$\{statusFilter\}/);
  assert.match(source, /if \(useSkuSearch\)[\s\S]*?productVariants\([\s\S]*?query:\s*\$query/);
  assert.match(source, /data\.productVariants\.edges\.map\(\(\{ node: variant \}\) => \(\{\s*\.\.\.variant\.product,\s*variants:\s*\{\s*edges:\s*\[\{\s*node:\s*variant\s*\}\]/,
    "SKU results must render the Shopify-matched variant, not the product's first ten variants");
  assert.match(source, /query StockHubProductsBySku[\s\S]*?productVariants\([\s\S]*?sku[\s\S]*?\)[\s\S]*?node \{[\s\S]*?sku[\s\S]*?\}/,
    "SKU lookup must query variant SKUs and return SKU identity with each variant result");
  assert.match(source, /pageInfo:\s*data\.productVariants\.pageInfo/,
    "SKU result pagination must preserve Shopify's exact variant cursor page information");
  assert.match(view, /const matchedVariant = searchBy === "sku" && Boolean\(search\)/);
  assert.match(view, /const sku = matchedVariant \|\| singleVariant \? variant\?\.sku \|\| "No SKU"/,
    "a SKU search result must identify the matched variant, not another product variant");
  assert.match(source, /`status:\$\{statusFilter\}`/);
  assert.match(source, /query:\s*queryTerms\.length\s*\?\s*queryTerms\.join\(" AND "\)\s*:\s*null/);
  assert.match(view, /<s-select label="Product status" name="status" value=\{statusFilter\}>[\s\S]*?<s-option value="all">All statuses<\/s-option>/);
  assert.match(view, /<s-select label="Page size" name="pageSize" value=\{String\(pageSize\)\}>[\s\S]*?<s-option value="10">10<\/s-option>[\s\S]*?<s-option value="25">25<\/s-option>[\s\S]*?<s-option value="50">50<\/s-option>/);
  assert.match(view, /<Form method="get" className="stockhub-products-filter-form">[\s\S]*?<s-text-field[\s\S]*?<s-select label="Search by"[\s\S]*?<s-select label="Product status"[\s\S]*?<s-button type="submit" variant="primary"/,
    "filter controls remain in one GET form and preserve search behavior");
  assert.match(view, /params\.set\("q",\s*search\)/);
  assert.match(view, /params\.set\("searchBy",\s*searchBy\)/);
  assert.match(view, /params\.set\("status",\s*statusFilter\)/);
  assert.match(view, /pageHref\(search,\s*searchBy,\s*statusFilter,\s*(?:pageSize,\s*)?"before"/);
  assert.match(view, /pageHref\(search,\s*searchBy,\s*statusFilter,\s*(?:pageSize,\s*)?"after"/);
  assert.match(view, /label=\{searchBy === "sku" \? "Search SKU" : "Search product name"\}/);
  assert.match(source, /shop\s*\{\s*currencyCode\s*\}/);
  assert.match(source, /price\s*\n\s*inventoryQuantity/);
  assert.equal((source.match(/totalInventory/g) ?? []).length >= 2, true,
    "both product and SKU lookup query Shopify's product-wide inventory total");
  assert.equal((source.match(/priceRangeV2/g) ?? []).length >= 2, true,
    "both lookup paths request product price range");
  assert.match(view, /product\.totalInventory\s*\?\?\s*"Unavailable"/,
    "unknown product inventory must not be presented as zero");
  assert.match(view, /Total across locations: \{item\.inventoryQuantity \?\? "Unavailable"\}/,
    "expanded variant inventory is labeled as cross-location total");
});

test("Products catalog has six scannable columns, collapsed details, and same-row actions", async () => {
  const view = await readFile(productsCatalog, "utf8");
  for (const heading of ["Product", "SKU / variants", "Status", "Price", "Total inventory", "Actions"]) {
    assert.match(view, new RegExp(`<th scope="col">${heading.replaceAll("/", "\\/")}</th>`));
  }
  assert.match(view, /useState<Set<string>>\(\(\) => new Set\(\)\)/,
    "detail rows must be collapsed initially");
  assert.match(view, /\{isExpanded \? <tr className="stockhub-product-detail-row"/,
    "variant details appear only on demand");
  assert.match(view, /<tr className="stockhub-product-row">[\s\S]*?<td data-label="Actions">[\s\S]*?<a href=\{editUrl\} target="_top"/,
    "the Shopify link belongs in the collapsed product row's Actions cell");
  assert.match(view, /results on this page|result\{products\.length === 1/,
    "the count must be explicitly page-scoped, not an invented store total");
});

test("Products pagination preserves search mode, status and the exact cursor", async () => {
  const view = await readFile(productsCatalog, "utf8");
  const functionSource = view.match(/function pageHref\([\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource);
  const javascript = ts.transpileModule(`${functionSource}\nexport { pageHref };`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { pageHref } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  assert.equal(pageHref("MATCH-204", "sku", "draft", 50, "after", "next-cursor"),
    "/app/products?q=MATCH-204&searchBy=sku&status=draft&pageSize=50&after=next-cursor");
  assert.equal(pageHref("MATCH-204", "sku", "draft", 50, "before", "prev-cursor"),
    "/app/products?q=MATCH-204&searchBy=sku&status=draft&pageSize=50&before=prev-cursor");
  assert.equal(pageHref("winter coat", "name", "active", 10, "before", "prev-cursor"),
    "/app/products?q=winter+coat&status=active&pageSize=10&before=prev-cursor");
  assert.equal(pageHref("winter coat", "name", "active", 10, "after", "next-cursor"),
    "/app/products?q=winter+coat&status=active&pageSize=10&after=next-cursor");
  assert.equal(pageHref("", "name", "all", 25), "/app/products");
  assert.equal(pageHref("", "name", "all", 50), "/app/products?pageSize=50");
});

test("Products page size accepts only 10, 25, and 50, defaulting invalid input to 25", async () => {
  const source = await readFile(productsRoute, "utf8");
  const prelude = source.match(/const PAGE_SIZES = [^\n]+\nconst DEFAULT_PAGE_SIZE: [^\n]+/)?.[0];
  const functionSource = source.match(/export function parsePageSize\([\s\S]*?\n\}/)?.[0];
  assert.ok(prelude && functionSource);
  const javascript = ts.transpileModule(`${prelude}\n${functionSource}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { parsePageSize } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  for (const size of ["10", "25", "50"]) assert.equal(parsePageSize(size), Number(size));
  for (const invalid of [null, "", "0", "100", "-1", "25.0", "abc"]) assert.equal(parsePageSize(invalid), 25);
});
