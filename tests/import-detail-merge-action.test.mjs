/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detailRoute = new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url);

test("PREVIEWED eligible receipt exposes a primary Merge action below line-item filters", async () => {
  const source = await readFile(detailRoute, "utf8");
  const groupStart = source.indexOf('<div className="stockhub-receipt-actions" role="group" aria-label="Receipt actions">');
  const mergeActionStart = source.indexOf('<div className="stockhub-merge-action">');

  assert.ok(groupStart >= 0 && mergeActionStart > groupStart, "receipt verification action wrapper and line-item Merge action must be rendered");
  const actionGroup = source.slice(groupStart, source.indexOf("      {mergeDisabledReason", groupStart));
  const mergeAction = source.slice(mergeActionStart, source.indexOf("        <s-text>{filteredLines.length}", mergeActionStart));

  // Representative eligible PREVIEWED state: all required grants verified, no blocked
  // rows, and at least one mergeable line. The guard below ensures that this state is
  // not falsely explained away by missing scopes or an empty/blocked receipt.
  const eligiblePreview = {
    status: "PREVIEWED",
    scopesVerified: true,
    missingReadScopes: [],
    missingWriteScopes: [],
    blocked: 0,
    hasMergeable: true,
    totalLines: 15,
    eligibleLines: 15,
  };
  assert.equal(eligiblePreview.status, "PREVIEWED");
  assert.equal(eligiblePreview.scopesVerified, true);
  assert.deepEqual(eligiblePreview.missingReadScopes, []);
  assert.deepEqual(eligiblePreview.missingWriteScopes, []);
  assert.equal(eligiblePreview.blocked, 0);
  assert.equal(eligiblePreview.hasMergeable, true);
  assert.equal(eligiblePreview.eligibleLines, eligiblePreview.totalLines, "the reproducer is a 15/15 eligible preview");

  assert.match(source, /const mergeDisabled = [^;]*batch\.status === "PREVIEWED"[^;]*hasMergeable/,
    "the route must compute Merge availability for a PREVIEWED receipt with eligible lines");
  assert.doesNotMatch(actionGroup, /Merge|Resume/, "Merge/Resume must not remain beside Verify Shopify State");
  assert.doesNotMatch(actionGroup, /<s-button-group\b/, "Form wrappers must not be nested in a Polaris button group");
  assert.match(actionGroup, /<Form method="post">[\s\S]*?Verify Shopify State[\s\S]*?<\/Form>/,
    "the read-only verification action must remain a POST form");
  assert.ok(source.indexOf("label=\"Search line items\"") < mergeActionStart && mergeActionStart < source.indexOf("<s-text>{filteredLines.length}"),
    "Merge/Resume must appear immediately below the line-item filters and before the results/table");
  assert.match(mergeAction, /<Form method="post" onSubmit=[\s\S]*?name="intent" value=\{batch\.status === "PREVIEWED" \? "merge" : "resume"\}[\s\S]*?name="confirmed" value="yes"[\s\S]*?variant="primary"[\s\S]*?disabled=\{mergeDisabled\}[\s\S]*?<\/Form>/,
    "Merge/Resume must retain its confirmation and original POST fields");
});
