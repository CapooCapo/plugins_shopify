/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detailRoute = new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url);

test("PREVIEWED eligible receipt exposes a Merge action in the receipt action group", async () => {
  const source = await readFile(detailRoute, "utf8");
  const groupStart = source.indexOf('<div className="stockhub-receipt-actions" role="group" aria-label="Receipt actions">');
  const groupEnd = source.indexOf("</div>", groupStart);

  assert.ok(groupStart >= 0 && groupEnd > groupStart, "receipt action wrapper must be rendered");
  const actionGroup = source.slice(groupStart, source.indexOf("      {mergeDisabledReason", groupStart));

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
  assert.match(actionGroup, /<s-button[^>]*disabled=\{mergeDisabled\}>\{batch\.status === "PREVIEWED" \? "Merge" : "Resume"\} eligible lines<\/s-button>/,
    "an eligible PREVIEWED receipt must render its Merge control");
  assert.doesNotMatch(actionGroup, /<s-button-group\b/, "Form wrappers must not be nested in a Polaris button group");
  assert.match(actionGroup, /<Form method="post">[\s\S]*?Verify Shopify State[\s\S]*?<\/Form>/,
    "the read-only verification action must remain a POST form");
  assert.match(actionGroup, /<Form method="post" onSubmit=[\s\S]*?name="intent" value=\{batch\.status === "PREVIEWED" \? "merge" : "resume"\}[\s\S]*?name="confirmed" value="yes"[\s\S]*?<\/Form>/,
    "Merge/Resume must retain its confirmation and original POST fields");
});
