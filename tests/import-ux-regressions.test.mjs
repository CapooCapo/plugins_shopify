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
      assert.ok(technicalDetails.includes(`["${label}", selectedLine.${property}]`) && /accessibilityLabel=\{"Copy " \+ label\}/.test(technicalDetails),
        `${label} must have its own clearly labeled copy action`);
      assert.ok(new RegExp(`copyIdentifier\\(label, value\\)`).test(technicalDetails),
        `${label} copy action must use the selected identifier value`);
    });
  }
});

test("receipt ID copy controls expose local success and clipboard-failure feedback", async () => {
  const detail = await source("app.imports.history.$batchId.tsx");
  const technicalDetails = disclosure(detail, "Technical details");

  assert.ok(/role=["']status["'][^>]*>\s*Copied/.test(technicalDetails),
    "successful ID copying must be announced beside the ID controls");
  assert.ok(/const copyIdentifier = async[\s\S]*?catch\s*\{/.test(detail),
    "a rejected clipboard write must be caught by the ID-copy flow");
  assert.ok(/Could not access the clipboard[\s\S]{0,160}(?:select and copy|copy manually|select the ID)/i.test(technicalDetails),
    "clipboard rejection must explain how to manually copy the ID");
  for (const [label, property] of [
    ["Product ID", "productId"],
    ["Variant ID", "variantId"],
    ["Inventory Item ID", "inventoryItemId"],
  ]) {
    assert.ok(technicalDetails.includes(`["${label}", selectedLine.${property}]`),
      `${label} must remain available as the manual-copy fallback`);
  }
});

test("receipt errors expand separately from technical identifiers", async () => {
  const detail = await source("app.imports.history.$batchId.tsx");
  const errorDetails = detail.match(/selectedLine\.errorDetail \|\| selectedLine\.errorCode \? <details>[\s\S]*?<\/details>\s*: null/)?.[0] ?? "";
  const technicalDetails = disclosure(detail, "Technical details");

  assert.ok(errorDetails,
    "saved line errors must have their own conditional disclosure");
  assert.match(errorDetails, /<summary>Error details<\/summary>/,
    "the error disclosure must be labeled separately from technical information");
  assert.match(errorDetails, /selectedLine\.errorDetail \?\? selectedLine\.errorCode/,
    "expanding Error details must reveal the saved line error or its code");
  assert.doesNotMatch(errorDetails, /Product ID|Variant ID|Inventory Item ID/,
    "the error disclosure must not expose technical identifiers");
  assert.match(technicalDetails, /<summary>Technical details<\/summary>/,
    "Shopify identifiers remain under a separate Technical details disclosure");
  assert.match(technicalDetails, /Product ID", selectedLine\.productId[\s\S]*?Variant ID", selectedLine\.variantId[\s\S]*?Inventory Item ID", selectedLine\.inventoryItemId/,
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

test("receipt workspace keeps the table primary and uses one accessible product drawer for row CRUD", async () => {
  const [detail, styles] = await Promise.all([
    source("app.imports.history.$batchId.tsx"),
    readFile(new URL("../app/styles/stockhub.css", import.meta.url), "utf8"),
  ]);

  assert.match(detail, /className="stockhub-line-toolbar__summary"><strong>\{filteredLines\.length\}<\/strong><span>shown of \{batch\.lines\.length\}/,
    "the current filtered count and receipt total must lead the line-item workspace");
  assert.match(detail, /stockhub-line-toolbar__filters[\s\S]*?Search line items[\s\S]*?Quality status/,
    "search and quality filters must share the consolidated line-item toolbar");
  assert.match(detail, /<table className="stockhub-lines-table" aria-label="Receipt line items">[\s\S]*?<th scope="col">Product \/ Variant<\/th>[\s\S]*?<th scope="col">SKU<\/th>[\s\S]*?<th scope="col">Quantity<\/th>[\s\S]*?<th scope="col">\{executionStarted \? "Preview check" : "Validation"\}<\/th>[\s\S]*?<th scope="col">Execution status<\/th>[\s\S]*?stockhub-visually-hidden">Row actions/,
    "desktop uses a named semantic table with product, SKU, quantity, validation, execution, and accessible action columns");
  assert.match(detail, /<ul className="stockhub-mobile-lines" aria-label="Receipt line items">[\s\S]*?<article className="stockhub-mobile-line-card">[\s\S]*?stockhub-mobile-line-card__badges[\s\S]*?stockhub-mobile-line-card__actions/,
    "mobile uses readable line cards instead of compressing the desktop table");
  assert.match(detail, /onClick=\{\(\) => \{ setLineStatusFilter\("ERROR"\); setErrorGroupFilter\(group\.key\); setLineSearch\(""\); setLineTypeFilter\("ALL"\);/,
    "a validation-group action clears incompatible search and operation filters before showing the issue group");
  assert.match(detail, /Show \{group\.lines\.length\} affected rows/,
    "the validation-group action count names the full selected issue group");
  assert.match(detail, /className="stockhub-validation-issue-list__content"[\s\S]*?\{group\.label\}[\s\S]*?\{group\.hint\}/,
    "each repeated validation issue group states its own cause and correction guidance");
  assert.match(detail, /className="stockhub-row-open"[\s\S]*?openInspector\(line\.id, "details"/,
    "clicking a product/variant must open the same product details surface");
  assert.match(detail, /className="stockhub-row-inspector" role="dialog" aria-modal="true"/,
    "the inspector must use modal drawer semantics when opened");
  assert.match(detail, /event\.key === "Escape"[\s\S]*?requestCloseInspector\(\)/,
    "the product drawer must close through Escape");
  assert.match(styles, /\.stockhub-row-inspector\s*\{[^}]*position:\s*fixed[^}]*width:\s*min\(500px/s,
    "desktop drawer must be fixed to the right edge instead of consuming permanent table width");
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.stockhub-row-inspector\s*\{[^}]*width:\s*100vw/s,
    "mobile drawer must use the full viewport width");
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.stockhub-lines-table-wrap\s*\{\s*display:\s*none;\s*\}[\s\S]*?\.stockhub-mobile-lines\s*\{\s*display:\s*grid/s,
    "the responsive breakpoint hides the semantic desktop table and displays mobile row cards");
});

test("draft editing gives truthful pending, conflict, close, and safe product-draft feedback", async () => {
  const detail = await source("app.imports.history.$batchId.tsx");

  assert.match(detail, /savingDraft \? "Saving…"[\s\S]*?Save and revalidate/,
    "save must show a pending state rather than claim success early");
  assert.match(detail, /draftNotice[\s\S]*?setSelectedLineId\(null\)[\s\S]*?stockhub-toast/,
    "the success redirect must close the drawer and show a visible toast");
  assert.match(detail, /draftSaveInFlightRef[\s\S]*?savingDraft[\s\S]*?setSelectedLineId\(null\)/,
    "a later save to the same redirect URL must still close the reopened drawer");
  assert.match(detail, /draftConflict[\s\S]*?Refresh draft/,
    "a stale draft conflict must be surfaced with an explicit refresh path");
  assert.match(detail, /Discard unsaved changes\?[\s\S]*?Discard changes[\s\S]*?Keep editing/,
    "closing a dirty form must require an explicit discard decision");
  assert.match(detail, /Prepare product draft in Product Catalog[\s\S]*?does not create a Shopify product/,
    "missing-SKU guidance must route to the draft-only catalog workflow");
  assert.match(detail, /INVENTORY_NOT_TRACKED[\s\S]*?do not create another product[\s\S]*?Shopify Admin/i,
    "untracked existing variants must direct merchants to safe review instead of duplicate creation");
  assert.match(detail, /name="confirmedCount" value=\{eligibleCount\}/,
    "the existing merge confirmation count contract must remain intact");
});

test("receipt revalidation reuses the guarded draft action and invalidates the open merge confirmation", async () => {
  const detail = await source("app.imports.history.$batchId.tsx");
  const toolbarActionsStart = detail.indexOf('<div className="stockhub-line-toolbar__actions">');
  const toolbarActionsEnd = detail.indexOf('</div>\n            {errorGroupFilter', toolbarActionsStart);
  const toolbarActions = detail.slice(toolbarActionsStart, toolbarActionsEnd);

  assert.ok(toolbarActionsStart >= 0 && toolbarActionsEnd > toolbarActionsStart,
    "the revalidation control remains in the line-item toolbar action area");
  assert.match(toolbarActions, /name="intent" value="draftEditLine"[\s\S]*?name="expectedUpdatedAt" value=\{batch\.updatedAt\.toISOString\(\)\}[\s\S]*?name="image_url"/,
    "revalidate must submit the existing version-guarded draft edit contract with all persisted CSV fields");
  assert.match(toolbarActions, /onSubmit=\{\(\) => setMergeConfirmationRevision\(null\)\}/,
    "revalidation must invalidate any client-side merge confirmation before the server refresh");
  assert.match(detail, /className="stockhub-draft-form"[\s\S]*?onSubmit=\{\(\) => setMergeConfirmationRevision\(null\)\}/,
    "editing a draft row must also invalidate any stale merge confirmation");
  assert.match(toolbarActions, /disabled=\{!revalidationLine \|\| savingDraft\}[\s\S]*?Revalidate selected row/,
    "revalidation is disabled until a draft row is selected and while it is saving");
  assert.match(detail, /Select a draft row above to revalidate it/,
    "the action area must explain why revalidation is disabled until a row is selected");
  assert.match(detail, /Draft row saved and validation refreshed/,
    "the redirect result must give specific validation-refresh feedback");
});

test("missing-SKU preparation posts CSV values into a draft-only catalog workflow", async () => {
  const [detail, catalogIndex, catalogDetail] = await Promise.all([
    source("app.imports.history.$batchId.tsx"),
    source("app.imports.catalog._index.tsx"),
    source("app.imports.catalog.$batchId.tsx"),
  ]);

  const preparation = detail.match(/selectedLine\.operationType === "CREATE_DRAFT" \? <s-banner[\s\S]*?<\/s-banner>/)?.[0] ?? "";
  assert.match(preparation, /<Form method="post" action="\/app\/imports\/catalog">/,
    "missing-SKU data must travel by POST, not a query string");
  for (const name of ["productName", "sku", "price", "description", "imageUrl", "sourceReceiptCode", "sourceRowNumber"]) {
    assert.match(preparation, new RegExp(`name="${name}"`), `${name} must be carried to the catalog draft`);
  }
  assert.doesNotMatch(preparation, /INVENTORY_NOT_TRACKED/,
    "the product-draft affordance must not be used for an existing untracked variant");
  assert.match(catalogIndex, /form\.get\("intent"\) === "prepare-import-draft"[\s\S]*?status: "DRAFT"[\s\S]*?catalogImportLine\.create/,
    "catalog intake must create a local DRAFT row only after the authenticated POST");
  assert.doesNotMatch(catalogIndex, /prepare-import-draft[\s\S]{0,2000}admin\.graphql/,
    "preparing a catalog draft must not call Shopify");
  assert.match(catalogDetail, /prepared === "inventory"[\s\S]*?does not create a Shopify product/,
    "the destination draft must disclose its safe, non-executing state");
});

test("drawer focus starts on a native control and traps Polaris focus hosts", async () => {
  const detail = await source("app.imports.history.$batchId.tsx");

  assert.match(detail, /const drawerCloseRef = useRef<HTMLButtonElement>/,
    "drawer focus must start from a native close button rather than a non-tabbable heading");
  assert.match(detail, /drawerCloseRef\.current\?\.focus\(\)/,
    "opening the drawer must focus its close control");
  assert.match(detail, /s-button:not\(\[disabled\]\), s-text-field:not\(\[disabled\]\), s-select:not\(\[disabled\]\)/,
    "the Tab cycle must include Polaris custom-element focus hosts");
});
