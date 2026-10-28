/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const detailRoute = new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url);
const stylesheet = new URL("../app/styles/stockhub.css", import.meta.url);

async function loadProgressHelpers() {
  const source = await readFile(detailRoute, "utf8");
  const start = source.indexOf("type ReceiptProgressLine =");
  const end = source.indexOf("export default function ImportBatchDetail()", start);
  assert.ok(start >= 0 && end > start, "receipt progress helpers must remain a pure, separately testable block");
  const javascript = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

const line = (overrides = {}) => ({
  status: "SUCCEEDED",
  operationType: "ADJUST",
  stage: "COMPLETED",
  productId: null,
  errorCode: null,
  ...overrides,
});

test("15 completed existing-SKU lines report line success separately from product and inventory activation stages", async () => {
  const { summarizeReceiptProgress, noEligibleReceiptMessage } = await loadProgressHelpers();
  const summary = summarizeReceiptProgress(Array.from({ length: 15 }, () => line()));

  assert.equal(summary.successful, 15);
  assert.equal(summary.totalLines, 15);
  assert.equal(summary.completionPercent, 100);
  assert.equal(summary.confirmedProductsCreated, 0);
  assert.equal(summary.confirmedInventoryActivated, 0);
  assert.equal(summary.confirmedInventoryAdjustments, 15);
  assert.equal(summary.eligibleCount, 0);
  assert.deepEqual(noEligibleReceiptMessage(summary), {
    title: "Import lines complete",
    detail: "All 15 import lines completed. No lines remain eligible to merge or resume. Product creation and inventory stages are listed separately above.",
    tone: "success",
  });
});

test("a failed later stage can coexist with a confirmed Draft product and is not counted as a completed line", async () => {
  const { summarizeReceiptProgress } = await loadProgressHelpers();
  const summary = summarizeReceiptProgress([line({
    status: "FAILED",
    operationType: "CREATE_DRAFT",
    stage: "INVENTORY_ACTIVATING",
    productId: "gid://shopify/Product/123",
    errorCode: "INVENTORY_ACTIVATE_FAILED",
  })]);

  assert.equal(summary.successful, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.confirmedProductsCreated, 1);
  assert.equal(summary.confirmedInventoryActivated, 0);
  assert.equal(summary.createdDraftInventoryFailures, 1,
    "a failed create-draft operation at INVENTORY_ACTIVATING is surfaced as unresolved activation");
  assert.equal(summary.eligibleCount, 1, "existing Resume eligibility remains unchanged for failed lines");
});

test("new-product activation and existing-SKU adjustments have distinct persisted counters", async () => {
  const { summarizeReceiptProgress } = await loadProgressHelpers();
  const summary = summarizeReceiptProgress([
    line({ operationType: "CREATE_DRAFT", stage: "INVENTORY_ACTIVE", productId: "gid://shopify/Product/456" }),
    line({ operationType: "ADJUST" }),
  ]);

  assert.equal(summary.confirmedProductsCreated, 1);
  assert.equal(summary.confirmedInventoryActivated, 1);
  assert.equal(summary.confirmedInventoryAdjustments, 1);
  assert.equal(summary.successful, 2);
  const notYetCompletedAdjustment = summarizeReceiptProgress([
    line({ status: "SUCCEEDED", operationType: "ADJUST", stage: "INVENTORY_ADJUSTING" }),
  ]);
  assert.equal(notYetCompletedAdjustment.confirmedInventoryAdjustments, 0,
    "an adjustment only counts after both the persisted success status and COMPLETED stage are present");
});

test("uncertain product creation is counted separately while its outcome is running or uncertain", async () => {
  const { summarizeReceiptProgress } = await loadProgressHelpers();
  const summary = summarizeReceiptProgress([
    line({ status: "RUNNING", operationType: "CREATE_DRAFT", stage: "PRODUCT_CREATING" }),
    line({ status: "UNCERTAIN", operationType: "CREATE_DRAFT", stage: "PRODUCT_CREATING" }),
  ]);

  assert.equal(summary.uncertain, 2);
  assert.equal(summary.uncertainProductCreations, 2);
  assert.equal(summary.confirmedProductsCreated, 0,
    "a product still being created or with uncertain outcome is not reported as confirmed");
});

test("partial, failed, blocked, and in-progress outcomes remain distinct and retain existing eligibility", async () => {
  const { summarizeReceiptProgress } = await loadProgressHelpers();
  const summary = summarizeReceiptProgress([
    line(),
    line({ status: "FAILED", operationType: "CREATE_DRAFT", stage: "PRODUCT_CREATING" }),
    line({ status: "BLOCKED", operationType: "BLOCKED", stage: "BLOCKED" }),
    line({ status: "RUNNING", operationType: "ADJUST", stage: "INVENTORY_ADJUSTING" }),
  ]);

  assert.equal(summary.successful, 1);
  assert.equal(summary.completionPercent, 25);
  assert.equal(summary.failed, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.uncertain, 1);
  assert.equal(summary.eligibleCount, 2, "failed and running rows preserve existing Resume eligibility; blocked rows remain excluded");
});

test("a blocked terminal receipt with no eligible lines gives accurate read-only guidance", async () => {
  const { summarizeReceiptProgress, noEligibleReceiptMessage } = await loadProgressHelpers();
  const summary = summarizeReceiptProgress([
    line({ status: "BLOCKED", operationType: "BLOCKED", stage: "BLOCKED" }),
  ]);

  assert.equal(summary.eligibleCount, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.uncertain, 0);
  assert.deepEqual(noEligibleReceiptMessage(summary), {
    title: "No lines are eligible to resume",
    detail: "0 failed, 1 blocked, and 0 uncertain or in-progress. Review the line details below and verify Shopify state before taking further action.",
    tone: "attention",
  });
});

test("receipt UI uses accessible operation cards, hides zero-row confirmation, and keeps the server confirmation contract", async () => {
  const [source, css] = await Promise.all([
    readFile(detailRoute, "utf8"),
    readFile(stylesheet, "utf8"),
  ]);

  assert.match(source, /aria-label="Import line completion"/);
  assert.match(source, /Import line processing/);
  assert.match(source, /className="stockhub-receipt-summary-cards"/);
  assert.match(source, /Draft products created/);
  assert.match(source, /New-product inventory activations/);
  assert.match(source, /Existing SKU inventory adjustments/);
  assert.match(source, /Counts come from persisted receipt stages/);
  assert.match(source, /eligibleCount === 0 \? <section className=\{`stockhub-receipt-terminal/,
    "zero-eligible receipts must explain their terminal or unresolved status without an alert banner");
  assert.match(source, /mergeDisabledReason = !hasMergeable \? null/,
    "absence of eligible rows must not become an irrelevant warning banner");
  assert.match(source, /hideStaleMergeConfirmationError = eligibleCount === 0 &&\s*actionData\?\.error === "Confirm the current number of eligible rows and any excluded rows before merging\."/,
    "only the now-stale zero-eligible confirmation error is suppressed");
  assert.match(source, /actionData\?\.error && !hideStaleMergeConfirmationError/,
    "unrelated route errors remain visible");
  assert.match(source, /eligibleCount > 0 && !mergeConfirming \? <s-button type="button" variant="primary" disabled=\{mergeDisabled\}/,
    "an actionable Merge/Resume button is rendered only while rows are eligible");
  assert.match(source, /mergeConfirming \? <div className="stockhub-merge-confirmation"/,
    "the confirmation dialog must be gated by a revision-matched eligible state");
  assert.match(source, /batch\.updatedAt\.toISOString\(\)[\s\S]*?line\.id, line\.status, line\.stage, line\.operationType/,
    "an open confirmation revision includes receipt and line state so revalidation invalidates stale confirmation");
  assert.match(source, /name="intent" value=\{batch\.status === "PREVIEWED" \? "merge" : "resume"\}[\s\S]*?name="batchId" value=\{batch\.id\}[\s\S]*?name="confirmed" value="yes"[\s\S]*?name="confirmedCount" value=\{eligibleCount\}/,
    "the existing server-side confirmation fields remain intact");
  assert.match(source, /name="partialConfirmed" value="yes"/,
    "the existing explicit partial-confirmation contract remains intact");
  assert.match(source, /Verify Shopify State/,
    "read-only state verification remains available when no merge is possible");
  assert.match(css, /\.stockhub-receipt-summary-cards[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 1000px\)[\s\S]*?\.stockhub-receipt-summary-cards \{ grid-template-columns: repeat\(2/);
  assert.match(css, /\.stockhub-receipt-terminal--success/);
  assert.match(css, /\.stockhub-receipt-terminal--attention/);
});
