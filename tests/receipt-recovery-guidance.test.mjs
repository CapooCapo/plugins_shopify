/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const detailRoute = new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url);
const overviewComponent = new URL("../app/components/OverviewDashboard.tsx", import.meta.url);

async function loadPureFunction(source, startMarker, endMarker, exportName) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${exportName} source block must remain discoverable`);
  let block = source.slice(start, end).trim();
  if (!block.startsWith("export ")) block = `export ${block}`;
  const javascript = ts.transpileModule(block, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  return module[exportName];
}

test("untracked inventory validation gives row-level Shopify correction and revalidation guidance without auto-enabling tracking", async () => {
  const source = await readFile(detailRoute, "utf8");
  const correctionHint = await loadPureFunction(
    source,
    "function correctionHint(",
    "\nfunction verificationClassificationLabel(",
    "correctionHint",
  );

  const guidance = correctionHint("INVENTORY_NOT_TRACKED");
  assert.match(guidance, /enable (?:inventory )?tracking in Shopify/i);
  assert.match(guidance, /revalidat/i,
    "the merchant must be told to revalidate after changing tracking in Shopify");

  const qualityCell = source.match(/<td data-label="Validation"><s-badge[^>]*>\{validationPresentation\(line, executionStarted\)\.label\}<\/s-badge><\/td>/)?.[0] ?? "";
  assert.ok(qualityCell, "the semantic desktop table retains a validation status cell for each line");
  const mobileIssue = source.match(/line\.errorDetail && validationGroup\(line\) !== "COMPLETED" \? <p className="stockhub-mobile-line-card__issue">\{line\.errorDetail\}<\/p>/)?.[0] ?? "";
  assert.ok(mobileIssue, "the mobile line card keeps the specific saved error detail visible");
  const drawerErrorDetails = source.match(/selectedLine\.errorDetail \|\| selectedLine\.errorCode \? <details><summary>Error details<\/summary>[\s\S]*?<\/details>\s*: null/)?.[0] ?? "";
  assert.ok(drawerErrorDetails, "opening the line drawer exposes a dedicated Error details disclosure");
  assert.match(drawerErrorDetails, /selectedLine\.errorDetail \?\? selectedLine\.errorCode/,
    "the expanded details show the specific Shopify error when available");
  assert.match(drawerErrorDetails, /correctionHint\(selectedLine\.errorCode\)/,
    "the drawer keeps actionable Shopify correction guidance when an error detail is present");
  assert.doesNotMatch(drawerErrorDetails, /selectedLine\.errorDetail\s*\?\?\s*correctionHint\(selectedLine\.errorCode\)/,
    "actionable guidance must not disappear whenever Shopify supplied an error detail");
  assert.doesNotMatch(source, /inventoryItemUpdate|tracked:\s*true|setInventoryTracking/i,
    "validation guidance must not silently enable Shopify inventory tracking");
});

test("zero-eligible Previewed drafts use Merge/validation wording; Resume is reserved for execution recovery", async () => {
  const source = await readFile(detailRoute, "utf8");
  const noEligibleReceiptMessage = await loadPureFunction(
    source,
    "export function noEligibleReceiptMessage(",
    "\n\nexport default function ImportBatchDetail()",
    "noEligibleReceiptMessage",
  );
  const previewedBlocked = {
    totalLines: 10,
    successful: 0,
    failed: 0,
    blocked: 10,
    uncertain: 0,
  };

  const previewMessage = noEligibleReceiptMessage(previewedBlocked, {
    batchStatus: "PREVIEWED",
    executionStarted: false,
  });
  assert.match(previewMessage.title, /no rows are ready to merge/i);
  assert.match(previewMessage.detail, /validation|blocked/i,
    "a preview with validation errors should explain why no rows can be merged");
  assert.doesNotMatch(`${previewMessage.title} ${previewMessage.detail}`, /resume/i,
    "a PREVIEWED receipt has not begun execution and must not be described as resumable");

  const recovering = noEligibleReceiptMessage({
    totalLines: 2,
    successful: 0,
    failed: 1,
    blocked: 0,
    uncertain: 1,
  }, { batchStatus: "PARTIAL", executionStarted: true });
  assert.match(`${recovering.title} ${recovering.detail}`, /resume/i,
    "Resume wording remains available for an actual interrupted execution");
});

test("row action icons are recognizable but hidden from assistive technology, with labels and tooltips", async () => {
  const source = await readFile(detailRoute, "utf8");
  const actionsStart = source.indexOf('<div className="stockhub-row-actions">');
  const actionsEnd = source.indexOf("</div>", actionsStart);
  assert.ok(actionsStart >= 0 && actionsEnd > actionsStart, "line action controls must remain grouped in one reusable action component");
  const actions = source.slice(actionsStart, actionsEnd + "</div>".length);
  assert.match(source, /<td data-label="Actions" className="stockhub-lines-table__actions-cell">\{renderRowActions\(line\)\}<\/td>/,
    "the desktop semantic table keeps line controls grouped in its Actions cell");
  assert.match(source, /stockhub-mobile-line-card__actions">\{renderRowActions\(line\)\}<\/div>/,
    "mobile cards reuse the same accessible line actions");
  const buttons = [...actions.matchAll(/<button\b[^>]*className="stockhub-icon-action"[^>]*>[\s\S]*?<\/button>/g)]
    .map(([button]) => button);
  assert.ok(buttons.length >= 3, "details, edit, and delete icon actions should be present for editable draft rows");
  for (const button of buttons) {
    assert.match(button, /title=/, "each icon action needs a descriptive tooltip");
    assert.match(button, /aria-label=/, "each icon action needs an accessible name");
    assert.match(button, /<(?:svg|s-icon)\b[\s\S]*?aria-hidden="true"/,
      "recognizable visual icons must be decorative to assistive technology; the button label names the action");
  }
});

test("delete keeps an explicit destructive confirmation and a safe cancel path", async () => {
  const source = await readFile(detailRoute, "utf8");
  const confirmationStart = source.indexOf('className="stockhub-delete-confirm" role="alert"');
  const confirmationEnd = source.indexOf("</div>", confirmationStart);
  assert.ok(confirmationStart >= 0 && confirmationEnd > confirmationStart,
    "draft deletion must remain behind a confirmation prompt");
  const confirmation = source.slice(confirmationStart, confirmationEnd);
  assert.match(confirmation, /Remove draft row/);
  assert.match(confirmation, /This does not change Shopify/);
  assert.match(confirmation, /Confirm delete/);
  assert.match(confirmation, />Cancel</);
});

test("Overview defines attention as execution outcomes and distinguishes Previewed validation errors", async () => {
  const source = await readFile(overviewComponent, "utf8");
  const attentionStart = source.indexOf('className="stockhub-overview-section stockhub-overview-panel stockhub-overview-attention"');
  const recentStart = source.indexOf('className="stockhub-overview-section stockhub-overview-panel stockhub-overview-recent"', attentionStart);
  assert.ok(attentionStart >= 0 && recentStart > attentionStart, "Overview attention panel should remain separate from recent receipts");
  const attentionPanel = source.slice(attentionStart, recentStart);

  assert.match(attentionPanel, /execution|mutation/i,
    "the panel should scope attention counts to execution outcomes, not draft validation");
  assert.match(attentionPanel, /Previewed[\s\S]{0,160}(?:validation|draft)[\s\S]{0,160}(?:not|does not)[\s\S]{0,100}(?:failed|failure|Shopify write|mutation)/i,
    "the empty or explanatory state should make clear that Previewed validation errors are not failed Shopify mutations");
});
