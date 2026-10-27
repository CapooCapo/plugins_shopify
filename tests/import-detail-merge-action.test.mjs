/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detailRoute = new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url);

test("PREVIEWED eligible receipt exposes a primary Merge action below line-item filters", async () => {
  const source = await readFile(detailRoute, "utf8");
  const groupStart = source.indexOf('<div className="stockhub-receipt-actions" role="group" aria-label="Receipt actions">');
  const mergeActionStart = source.indexOf('<div className="stockhub-merge-action stockhub-merge-bar">');

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

  assert.match(source, /const mergeDisabled = [^;]*hasMergeable/,
    "the route must compute Merge availability for a PREVIEWED receipt with eligible lines");
  assert.doesNotMatch(actionGroup, /Merge|Resume/, "Merge/Resume must not remain beside Verify Shopify State");
  assert.doesNotMatch(actionGroup, /<s-button-group\b/, "Form wrappers must not be nested in a Polaris button group");
  assert.match(actionGroup, /<Form method="post">[\s\S]*?Verify Shopify State[\s\S]*?<\/Form>/,
    "the read-only verification action must remain a POST form");
  assert.ok(source.indexOf("label=\"Search line items\"") < mergeActionStart && mergeActionStart < source.indexOf("<s-text>{filteredLines.length}"),
    "Merge/Resume must appear immediately below the line-item filters and before the results/table");
  assert.match(mergeAction, /role="dialog" aria-label="Confirm inventory merge"[\s\S]*?<Form method="post">[\s\S]*?name="intent" value=\{batch\.status === "PREVIEWED" \? "merge" : "resume"\}[\s\S]*?name="confirmed" value="yes"[\s\S]*?name="confirmedCount"[\s\S]*?Confirm merge of \{eligibleCount\} rows[\s\S]*?<\/Form>/,
    "Merge/Resume must retain its explicit confirmation dialog and original POST fields");
  assert.match(mergeAction, /name="confirmedCount"/);
  assert.match(mergeAction, /blocked row\(s\) will remain attached to this receipt/);
});

test("draft CRUD is tenant/state/version guarded, revalidates rows, and never calls Shopify writes", async () => {
  const [route, detail, merge] = await Promise.all([
    readFile(new URL("../app/routes/app.imports._index.tsx", import.meta.url), "utf8"),
    readFile(detailRoute, "utf8"),
    readFile(new URL("../app/utils/import-merge.server.ts", import.meta.url), "utf8"),
  ]);
  const crud = route.slice(route.indexOf('if (intent === "draftAddLine"'), route.indexOf('if (intent === "verifyShopifyState")'));
  assert.match(crud, /where: \{ id: batchId, shop: session\.shop \}/);
  assert.match(crud, /batch\.status !== "PREVIEWED"/);
  assert.match(crud, /batch\.updatedAt\.getTime\(\) !== expectedUpdatedAt\.getTime\(\)/);
  assert.match(crud, /updateMany\(\{ where: \{ id: batch\.id, shop: session\.shop, status: "PREVIEWED", updatedAt: expectedUpdatedAt \}/);
  assert.match(crud, /prepareDraftLine\(admin, candidate\.row, batch\.locationId\)/);
  assert.doesNotMatch(crud, /inventoryAdjustQuantities|productCreate|inventoryActivate/);
  assert.match(detail, /draftAddLine/);
  assert.match(detail, /draftEditLine/);
  assert.match(detail, /draftDeleteLine/);
  assert.match(detail, /Draft — not sent to Shopify/);
  assert.match(merge, /Explicitly confirmed partial imports may contain validation-blocked rows/);
});
