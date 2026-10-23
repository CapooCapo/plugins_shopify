/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = (name) => new URL(`../app/routes/${name}`, import.meta.url);

async function source(name) {
  return readFile(routeUrl(name), "utf8");
}

function disclosure(sourceText, summary) {
  const escapedSummary = summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return sourceText.match(new RegExp(`<details>\\s*<summary>${escapedSummary}<\\/summary>[\\s\\S]*?<\\/details>`))?.[0] ?? "";
}

test("New Import dirty state includes both a selected CSV and a selected location", async () => {
  const [layout, imports] = await Promise.all([
    source("app.imports.tsx"),
    source("app.imports._index.tsx"),
  ]);
  const guard = layout.slice(
    layout.indexOf("function confirmLeavingNewImport"),
    layout.indexOf("\n  return (", layout.indexOf("function confirmLeavingNewImport")),
  );

  assert.match(guard, /input\[type=["']file["']\]/,
    "selecting a CSV must mark the New Import form as dirty");
  assert.ok(/location(?:Id|Select|Input)/.test(guard),
    "choosing a Shopify location must also mark the New Import form as dirty");
  assert.match(imports, /name="locationId"/,
    "the location control whose changes are protected must remain part of New Import");
});

test("New Import Stay/Leave confirmation covers router and browser-back navigation", async () => {
  const layout = await source("app.imports.tsx");

  assert.ok(/useBlocker\s*\(/.test(layout),
    "router navigation, including back/forward transitions, must be blocked while New Import is dirty");
  assert.ok(/blocker\.state[\s\S]{0,80}["']blocked["']/.test(layout),
    "the in-app confirmation must render only for the React Router blocked state");
  assert.ok(/blocker\.state\s*!==\s*["']blocked["'][\s\S]{0,120}shopify\.modal\.show/.test(layout),
    "the Polaris modal must be shown in response to a blocked router navigation");
  const modal = layout.match(/<s-modal\b[\s\S]*?<\/s-modal>/)?.[0];
  assert.ok(modal, "the confirmation must use Shopify Polaris s-modal semantics");
  assert.match(modal, /accessibilityLabel="Leave New Import confirmation"/,
    "the Polaris modal must have an accessible label");
  assert.match(modal, /heading="Leave New Import\?"/,
    "the Polaris modal must present a clear confirmation heading");
  assert.match(modal, /<s-button\b[^>]*slot="primary-action"[^>]*onClick=\{leaveNewImport\}[^>]*>\s*Leave\s*<\/s-button>/,
    "the slotted primary Leave action must call the leave handler");
  assert.match(modal, /<s-button\b[^>]*slot="secondary-actions"[^>]*onClick=\{stayOnNewImport\}[^>]*>\s*Stay\s*<\/s-button>/,
    "the slotted secondary Stay action must call the stay handler");
  assert.match(layout, /function stayOnNewImport\(\)[\s\S]*?blocker\.reset\s*\(\)/,
    "Stay must cancel the blocked navigation");
  assert.match(layout, /async function leaveNewImport\(\)[\s\S]*?blocker\.proceed\s*\(\)/,
    "Leave must proceed with the blocked navigation");
  assert.doesNotMatch(layout, /window\.confirm\s*\(/,
    "an embedded Shopify app must not depend on the native browser confirm dialog");
});

test("successful New Import preview exits the dirty form and opens its saved receipt", async () => {
  const [layout, imports] = await Promise.all([
    source("app.imports.tsx"),
    source("app.imports._index.tsx"),
  ]);

  assert.match(imports, /return redirect\(`\/app\/imports\/history\/\$\{encodeURIComponent\(persisted\.batchId\)\}/,
    "a successful preview must leave New Import for the newly persisted receipt");
  assert.match(imports, /submissionId:\s*randomUUID\(\)/,
    "returning to New Import must receive a fresh submission token");
  assert.match(imports, /<input[\s\S]*?id="csv-file"[\s\S]*?type="file"[\s\S]*?name="file"[\s\S]*?accept="\.csv,text\/csv"[\s\S]*?required/,
    "returning to New Import must start with a fresh, uncontrolled file input");
  assert.match(imports, /<select id="location-id" name="locationId" required[^>]*defaultValue=""[^>]*>/,
    "returning to New Import must start with no prior location selected");
  assert.match(layout, /historyActive/,
    "the dirty-form guard must no longer consider the New Import form active after that redirect");
});

test("receipt detail offers a separately labeled copy action for each Shopify ID", async (t) => {
  const detail = await source("app.imports.history.$batchId.tsx");
  const technicalDetails = disclosure(detail, "Technical details");
  assert.ok(technicalDetails, "receipt lines must place Shopify identifiers in a Technical details disclosure");
  const identifiers = [
    ["Product ID", "productId"],
    ["Variant ID", "variantId"],
    ["Inventory Item ID", "inventoryItemId"],
  ];

  for (const [label, property] of identifiers) {
    await t.test(label, () => {
      assert.ok(new RegExp(`(?:Copy ${label}|aria-label=["']Copy ${label}["'])`).test(technicalDetails),
        `${label} must have its own clearly labeled copy action`);
      assert.ok(new RegExp(`writeText\\([^)]*line\\.${property}`).test(technicalDetails),
        `${label} copy action must copy that identifier, not a different result payload`);
    });
  }
});

test("receipt ID copy controls expose local success and clipboard-failure feedback", async () => {
  const detail = await source("app.imports.history.$batchId.tsx");
  const technicalDetails = disclosure(detail, "Technical details");

  assert.ok(/role=["']status["'][^>]*>\s*Copied/.test(technicalDetails),
    "successful ID copying must be announced beside the ID controls");
  assert.ok(/catch\s*(?:\([^)]*\))?\s*\{/.test(technicalDetails),
    "a rejected clipboard write must be caught by the ID-copy flow");
  assert.ok(/Could not access the clipboard[\s\S]{0,160}(?:select and copy|copy manually|select the ID)/i.test(technicalDetails),
    "clipboard rejection must explain how to manually copy the ID");
  for (const [label, property] of [
    ["Product ID", "productId"],
    ["Variant ID", "variantId"],
    ["Inventory Item ID", "inventoryItemId"],
  ]) {
    assert.ok(new RegExp(`${label}:\\s*\\{line\\.${property}\\}`).test(technicalDetails),
      `${label} must remain available as the manual-copy fallback`);
  }
});

test("receipt errors expand separately from technical identifiers", async () => {
  const detail = await source("app.imports.history.$batchId.tsx");
  const errorDetails = detail.match(/line\.errorDetail \|\| line\.errorCode \? <details>[\s\S]*?<\/details>\s*: null/)?.[0] ?? "";
  const technicalDetails = disclosure(detail, "Technical details");

  assert.ok(errorDetails,
    "saved line errors must have their own conditional disclosure");
  assert.match(errorDetails, /<summary>Error details<\/summary>/,
    "the error disclosure must be labeled separately from technical information");
  assert.match(errorDetails, /line\.errorDetail \?\? line\.errorCode/,
    "expanding Error details must reveal the saved line error or its code");
  assert.doesNotMatch(errorDetails, /Product ID|Variant ID|Inventory Item ID/,
    "the error disclosure must not expose technical identifiers");
  assert.match(technicalDetails, /<summary>Technical details<\/summary>/,
    "Shopify identifiers remain under a separate Technical details disclosure");
  assert.match(technicalDetails, /Product ID: \{line\.productId\}[\s\S]*?Variant ID: \{line\.variantId\}[\s\S]*?Inventory Item ID: \{line\.inventoryItemId\}/,
    "the technical disclosure continues to expose the exact saved IDs for manual review");
});

test("Import History keeps status badge-only for a compact row", async () => {
  const history = await source("app.imports.history._index.tsx");
  const statusMarker = history.indexOf("batchStatusLabel(batch.status)");
  const statusStart = history.lastIndexOf("<s-table-cell>", statusMarker);
  const statusEnd = history.indexOf("</s-table-cell>", statusMarker);
  const statusCell = statusStart >= 0 && statusEnd > statusStart
    ? history.slice(statusStart, statusEnd + "</s-table-cell>".length)
    : undefined;

  assert.ok(statusCell, "History rows must render a dedicated Status cell");
  const badges = statusCell.match(/<s-badge\b[^>]*>[\s\S]*?<\/s-badge>/g) ?? [];
  assert.equal(badges.length, 1,
    "the compact Status cell should contain exactly one badge, including any semantic tone/icon props");
  assert.match(badges[0], /\{batchStatusLabel\(batch\.status\)\}/,
    "the badge should retain the human-readable batch status");
  const outsideBadge = statusCell
    .replace(badges[0], "")
    .replace(/<\/?s-table-cell>/g, "")
    .trim();
  assert.equal(outsideBadge, "",
    "the compact Status cell should not add text or another progress detail beside the badge");
  assert.doesNotMatch(statusCell, /lineCounts\./,
    "the compact row status should not include per-line progress counts");
});

test("History announces the current result count, filters, and newer/older availability", async () => {
  const history = await source("app.imports.history._index.tsx");
  const announcement = history.match(/<(?:div|p|s-paragraph)[^>]*role=["']status["'][^>]*>[\s\S]*?<\/(?:div|p|s-paragraph)>/)?.[0];
  assert.ok(announcement, "filtering and paging results must be announced in a status region");
  assert.match(announcement, /aria-live=["']polite["']/,
    "result updates must use a polite live announcement");
  assert.match(announcement, /data\.history\.length/,
    "the announcement must report the number of receipts on the current result page");
  assert.match(announcement, /data\.historySearch/,
    "the announcement must identify the active receipt search");
  assert.match(announcement, /data\.historyStatus/,
    "the announcement must identify the active filter context");
  assert.match(announcement, /data\.hasNewer/,
    "the announcement must say whether newer results are available");
  assert.match(announcement, /data\.hasOlder/,
    "the announcement must say whether older results are available");
});

test("History filters retain GET fields and stack at the narrow embedded-app viewport", async () => {
  const history = await source("app.imports.history._index.tsx");
  const styles = await readFile(new URL("../app/styles/stockhub.css", import.meta.url), "utf8");
  const formStart = history.indexOf('<Form method="get">');
  const formEnd = history.indexOf("</Form>", formStart);
  const filterForm = history.slice(formStart, formEnd);

  assert.match(filterForm, /<Form method="get">/,
    "History filters remain GET navigation so search/filter state stays in the URL");
  assert.match(filterForm, /name="historySearch"/);
  assert.match(filterForm, /name="historyStatus"/);
  assert.match(styles, /\.stockhub-history-toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.5fr\)\s+minmax\(180px,\s*1fr\)\s+auto/s,
    "History filters retain the desktop toolbar grid");
  assert.match(styles, /@media\s*\(max-width:\s*600px\)[\s\S]*?\.stockhub-history-toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    "History filter controls stack into one column at mobile widths");
});

test("raw installed-scope diagnostics are not exposed in the upload UI", async () => {
  const imports = await source("app.imports._index.tsx");
  assert.doesNotMatch(imports, /Installed scopes from Shopify:/,
    "raw Shopify scope diagnostics should stay out of the upload UI");
});

test("New Import presents a safe upload-to-receipt workflow without adding merge behavior", async () => {
  const imports = await source("app.imports._index.tsx");

  assert.match(imports, /<s-badge tone="info">1<\/s-badge><s-text type="strong">Upload<\/s-text>[\s\S]*?<s-badge>2<\/s-badge><s-text>Validate<\/s-text>[\s\S]*?<s-badge>3<\/s-badge><s-text>Review receipt<\/s-text>/,
    "the redesigned upload page must show the current Upload → Validate → Review receipt sequence");
  assert.match(imports, /Validate and create preview receipt/,
    "the primary upload action must make clear that validation saves a review receipt");
  assert.match(imports, /Import destination[\s\S]*?Store: \{data\.shop\}[\s\S]*?Shopify location/,
    "the authenticated store and selected location must be clear before validating");
  assert.match(imports, /Required columns:[\s\S]*?sku[\s\S]*?quantity[\s\S]*?title[\s\S]*?price[\s\S]*?Optional columns:[\s\S]*?description[\s\S]*?image_url/,
    "the upload page must state the required and optional CSV columns");
  assert.match(imports, /Before you upload[\s\S]*?MAX_CSV_BYTES[\s\S]*?MAX_CSV_ROWS/,
    "the upload page must state the enforced file and row limits");
  assert.match(imports, /Selected: <strong>\{selectedFile\.name\}<\/strong> · \{selectedFile\.size\.toLocaleString\(\)\} bytes/,
    "the selected CSV name and size should be visible before submission");
  assert.match(imports, /aria-live="polite"[\s\S]*?Validating CSV, checking Shopify SKU matches, and saving the preview receipt/,
    "submission progress must be announced without implying a Shopify mutation");
  assert.match(imports, /Validation does not write to Shopify; Merge is a separate, explicitly confirmed action/i,
    "the UI must distinguish validation from the later confirmed merge");
  assert.match(imports, /data\.maxMergeLines/);
  assert.match(imports, /confirmed=yes|confirmed.*yes|Explicit confirmation is required/,
    "existing server-side explicit merge confirmation must remain intact");
  assert.doesNotMatch(imports.slice(imports.indexOf("export default function Imports()")), /name="intent" value="merge"|name="intent" value="resume"/,
    "New Import must not introduce merge or resume controls");
});
