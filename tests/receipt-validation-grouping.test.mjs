/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const detailRoute = new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url);

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

test("same validation code with different row causes is not collapsed into one misleading issue group", async () => {
  const source = await readFile(detailRoute, "utf8");
  const validationIssueKey = await loadPureFunction(
    source,
    "function validationIssueKey(",
    "\nfunction validationIssueLabel(",
    "validationIssueKey",
  );
  const validationIssueLabel = await loadPureFunction(
    source,
    "function validationIssueLabel(",
    "\nfunction verificationClassificationLabel(",
    "validationIssueLabel",
  );

  const missingSku = { errorCode: "CSV_INVALID_ROW", errorDetail: "Missing required SKU" };
  const invalidQuantity = { errorCode: "CSV_INVALID_ROW", errorDetail: "Quantity must be a positive integer" };
  assert.notEqual(validationIssueKey(missingSku), validationIssueKey(invalidQuantity),
    "different causes sharing CSV_INVALID_ROW must remain separate groups");
  assert.notEqual(validationIssueLabel(missingSku), validationIssueLabel(invalidQuantity),
    "each separate group must identify its own actionable row cause");
  assert.equal(
    validationIssueKey({ errorCode: "CSV_INVALID_ROW", errorDetail: "  MISSING   required SKU " }),
    validationIssueKey({ errorCode: "CSV_INVALID_ROW", errorDetail: "missing required sku" }),
    "whitespace and case variants of the same cause should group consistently",
  );
});

test("Show affected rows clears search and operation filters so its count matches the displayed group", async () => {
  const source = await readFile(detailRoute, "utf8");
  const label = "Show {group.lines.length} affected rows";
  const labelIndex = source.indexOf(label);
  assert.ok(labelIndex >= 0, "each validation issue group should expose its affected-row action");
  const buttonStart = source.lastIndexOf("<button", labelIndex);
  const buttonEnd = source.indexOf("</button>", labelIndex);
  assert.ok(buttonStart >= 0 && buttonEnd > labelIndex, "affected-row action should be a complete button");
  const button = source.slice(buttonStart, buttonEnd);
  const handler = button.match(/onClick=\{\(\) => \{([\s\S]*?)\}\}/)?.[1];
  assert.ok(handler, "affected-row button should have a readable filter action");

  assert.match(handler, /setLineStatusFilter\("ERROR"\)/,
    "the affected validation rows should be selected by error status");
  assert.match(handler, /setErrorGroupFilter\(group\.key\)/,
    "the selected validation issue group should be applied");
  assert.match(handler, /setLineSearch\(""\)/,
    "a prior search must not silently hide members of the selected group");
  assert.match(handler, /setLineTypeFilter\("ALL"\)/,
    "a prior operation-type filter must not silently hide members of the selected group");
  assert.match(button, /Show \{group\.lines\.length\} affected rows/,
    "the action count should continue to describe the full selected issue group");
});
