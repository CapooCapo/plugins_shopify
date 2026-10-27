/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = (name) => new URL(`../app/routes/${name}`, import.meta.url);
const newImportRoute = "app.imports._index.tsx";
const importsLayoutRoute = "app.imports.tsx";
const historyIndexRoute = "app.imports.history._index.tsx";
const historyDetailRoute = "app.imports.history.$batchId.tsx";

async function source(name) {
  return readFile(route(name), "utf8");
}

function loaderBody(text) {
  const start = text.indexOf("export const loader =");
  assert.notEqual(start, -1, "route must export a loader");
  const end = text.indexOf("\nexport ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

test("Imports split exposes deep-link route modules and preserves legacy batchId links", async () => {
  const routesConfig = await readFile(new URL("../app/routes.ts", import.meta.url), "utf8");
  const [layout, newImport, history, detail] = await Promise.all([
    source(importsLayoutRoute),
    source(newImportRoute),
    source(historyIndexRoute),
    source(historyDetailRoute),
  ]);

  assert.match(routesConfig, /flatRoutes\(\)/, "the split route filenames are discovered by filesystem routing");
  assert.match(layout, /<Outlet\s*\/>/, "the Imports layout renders nested routes");
  assert.match(layout, /href="\/app\/imports"/, "New Import has a direct deep link");
  assert.match(layout, /href="\/app\/imports\/history"/, "History has a direct deep link");
  assert.match(history, /historyDetailHref\(batch\.id/, "history receipts link to a detail deep link");
  assert.match(history, /`\/app\/imports\/history\/\$\{encodeURIComponent\(batchId\)\}/,
    "receipt detail URLs encode batch IDs");
  assert.match(detail, /export const loader/, "receipt detail is independently addressable");

  const loader = loaderBody(newImport);
  assert.ok(loader.indexOf("authenticate.admin(request)") < loader.indexOf("legacyBatchId"),
    "legacy redirects must authenticate before processing the request");
  assert.match(loader, /requestUrl\.pathname\s*=\s*`\/app\/imports\/history\/\$\{encodeURIComponent\(legacyBatchId\)\}`/);
  assert.match(loader, /requestUrl\.searchParams\.delete\("batchId"\)/,
    "legacy batchId is removed after redirect");
  assert.match(loader, /return redirect\(`\$\{requestUrl\.pathname\}\$\{requestUrl\.search\}`\)/,
    "unrelated query state is retained on redirect");
});

test("New Import loader is isolated from History reads and each route authenticates before shop data access", async () => {
  const [newImport, history, detail] = await Promise.all([
    source(newImportRoute),
    source(historyIndexRoute),
    source(historyDetailRoute),
  ]);
  const newImportLoader = loaderBody(newImport);
  const historyLoader = loaderBody(history);
  const detailLoader = loaderBody(detail);

  assert.ok(newImportLoader.indexOf("authenticate.admin(request)") < newImportLoader.indexOf("queryLocations(admin)"));
  assert.doesNotMatch(newImportLoader, /prisma\.importBatch\.(?:findMany|groupBy)|prisma\.importLine\.(?:findMany|groupBy)/,
    "opening New Import must not load History summaries or line aggregates");
  assert.ok(historyLoader.indexOf("authenticate.admin(request)") < historyLoader.indexOf("prisma.importBatch"));
  assert.match(historyLoader, /shop:\s*session\.shop/,
    "History batch reads must be scoped to the authenticated shop");
  assert.match(historyLoader, /batch:\s*\{\s*is:\s*\{\s*shop:\s*session\.shop\s*\}\s*\}/,
    "History line aggregates must be scoped to the authenticated shop");
  assert.ok(detailLoader.indexOf("authenticate.admin(request)") < detailLoader.indexOf("prisma.importBatch.findFirst"));
  assert.match(detailLoader, /where:\s*\{\s*id:\s*params\.batchId,\s*shop:\s*session\.shop\s*\}/,
    "detail reads must reject a receipt from another shop");
});

test("History index selects compact summaries, while selected detail alone loads ImportLines", async () => {
  const [history, detail] = await Promise.all([
    source(historyIndexRoute),
    source(historyDetailRoute),
  ]);
  const historyLoader = loaderBody(history);
  const detailLoader = loaderBody(detail);
  const indexQuery = historyLoader.slice(historyLoader.indexOf("prisma.importBatch.findMany"), historyLoader.indexOf("const lineGroups"));

  assert.match(indexQuery, /select:\s*\{[\s\S]*?id:\s*true[\s\S]*?receiptCode:\s*true[\s\S]*?status:\s*true[\s\S]*?\}/);
  assert.doesNotMatch(indexQuery, /include:\s*\{\s*lines/,
    "History index must not fetch all ImportLine details for each receipt");
  assert.match(historyLoader, /prisma\.importLine\.groupBy\(/,
    "History progress uses an aggregate rather than full line records");
  assert.match(detailLoader, /include:\s*\{\s*lines:\s*\{\s*orderBy:\s*\{\s*rowNumber:\s*"asc"\s*\}\s*\}\s*\}/,
    "only selected receipt detail loads its lines");
});

test("FAILED remains Failed, and Verify is explicit, read-only, and routed to its action", async () => {
  const [newImport, detail, verifier] = await Promise.all([
    source(newImportRoute),
    source(historyDetailRoute),
    readFile(new URL("../app/utils/import-state-verification.server.ts", import.meta.url), "utf8"),
  ]);
  const statusLabel = detail.match(/function\s+statusLabel\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1];
  const history = await source(historyIndexRoute);
  const batchStatusLabel = history.match(/function\s+batchStatusLabel\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(statusLabel, "detail route must define a status presentation mapping");
  assert.match(statusLabel, /status\s*===\s*"FAILED"\s*\?\s*"Failed"/);
  assert.doesNotMatch(statusLabel, /status\s*===\s*"FAILED"\s*\?\s*"Completed"/);
  assert.ok(batchStatusLabel, "History index must define a batch status presentation mapping");
  assert.match(batchStatusLabel, /status\s*===\s*"FAILED"\s*\?\s*"Failed"/);
  assert.doesNotMatch(batchStatusLabel, /status\s*===\s*"FAILED"\s*\?\s*"Completed"/);
  const statusMarker = history.indexOf("batchStatusLabel(batch.status)");
  const statusStart = history.lastIndexOf("<s-table-cell>", statusMarker);
  const statusEnd = history.indexOf("</s-table-cell>", statusMarker);
  const statusCell = statusStart >= 0 && statusEnd > statusStart
    ? history.slice(statusStart, statusEnd + "</s-table-cell>".length)
    : undefined;
  assert.ok(statusCell, "compact History rows retain a dedicated Status cell");
  const badges = statusCell.match(/<s-badge\b[^>]*>[\s\S]*?<\/s-badge>/g) ?? [];
  assert.equal(badges.length, 1,
    "compact History rows retain the receipt status in one badge with semantic tone/icon props");
  assert.match(badges[0], /\{batchStatusLabel\(batch\.status\)\}/);
  assert.equal(statusCell.replace(badges[0], "").replace(/<\/?s-table-cell>/g, "").trim(), "",
    "compact History status has no extra text or per-line progress details");
  assert.match(history, /<s-table-cell>\{batch\.rowCount\}<\/s-table-cell>/,
    "compact History rows retain the receipt's total line count");
  assert.doesNotMatch(history, /batch\.lineCounts\.(?:completed|failed|blocked|uncertain|pending)/,
    "History must not restore the removed dense per-line progress summary");

  const confirmedProductCount = detail.slice(
    detail.indexOf("const confirmedProductStages"),
    detail.indexOf("const uncertainProductCreations"),
  );
  assert.match(confirmedProductCount, /confirmedProductStages\.has\(line\.stage\)/);
  assert.match(confirmedProductCount, /"INVENTORY_ACTIVATING"/,
    "inventory-stage uncertainty follows confirmed product creation");
  assert.doesNotMatch(confirmedProductCount, /"PRODUCT_CREATING"/,
    "unresolved product creation is not counted as confirmed");
  assert.doesNotMatch(confirmedProductCount, /\["UNCERTAIN",\s*"RUNNING"\]/,
    "later line uncertainty must not erase a confirmed product creation");
  assert.match(confirmedProductCount, /Boolean\(line\.productId\)/);
  const unresolvedDraftSummaryStart = detail.indexOf('<tr><th scope="row">Unresolved Draft product creation</th>');
  const unresolvedDraftSummaryEnd = detail.indexOf("</tr>", unresolvedDraftSummaryStart);
  assert.ok(unresolvedDraftSummaryStart >= 0 && unresolvedDraftSummaryEnd > unresolvedDraftSummaryStart,
    "the receipt summary table must show an Unresolved Draft product creation row");
  const unresolvedDraftSummaryRow = detail.slice(unresolvedDraftSummaryStart, unresolvedDraftSummaryEnd);
  assert.match(unresolvedDraftSummaryRow, /\{uncertainProductCreations\}/,
    "the visible unresolved-Draft summary row must display the computed count");
  assert.match(unresolvedDraftSummaryRow, /stockhub-receipt-summary-count--warning/,
    "unresolved Draft creation counts must retain warning styling");

  assert.match(detail, /export\s*\{\s*action\s*\}\s*from\s*"\.\/app\.imports\._index"/,
    "detail route explicitly reuses the authenticated import action");
  assert.match(detail, /<Form method="post">\s*<input[^>]+name="intent"\s+value="verifyShopifyState"/,
    "Verify is initiated by an explicit POST form rather than the detail loader");
  const detailLoader = loaderBody(detail);
  assert.doesNotMatch(detailLoader, /verifyImportBatchShopifyState|verifyShopifyState/,
    "opening or refreshing detail must not automatically verify Shopify state");
  const verifyAction = newImport.slice(newImport.indexOf('if (intent === "verifyShopifyState")'), newImport.indexOf('if (intent === "merge" || intent === "resume")'));
  assert.match(verifyAction, /verifyImportBatchShopifyState\(/);
  assert.doesNotMatch(verifyAction, /mergeImportBatch\(|\.inventory(?:Activate|Adjust)|mutation\s+StockHub/i,
    "Verify action must remain read-only");
  assert.match(verifier, /query StockHubVerifyImportState/);
  assert.doesNotMatch(verifier, /mutation\s+StockHub/i,
    "verification helper must only issue Shopify queries");
  assert.match(detail, /Could not access the clipboard/);
  assert.match(detail, /textarea[^>]+aria-label="Sanitized verification result"[^>]+readOnly/,
    "copy failure must leave the sanitized result available for manual selection");
});

test("Preview, History filters, Verify, Merge, and Resume submit to the route that handles each action", async () => {
  const [newImport, history, detail] = await Promise.all([
    source(newImportRoute),
    source(historyIndexRoute),
    source(historyDetailRoute),
  ]);

  assert.match(newImport, /<Form method="post" encType="multipart\/form-data" data-import-preview-form=/,
    "New Import preview form defaults to the New Import index action");
  assert.match(newImport, /export const action = async/);
  assert.match(history, /<Form method="get">/,
    "History filters submit GET to the History index loader");
  assert.match(detail, /export\s*\{\s*action\s*\}\s*from\s*"\.\/app\.imports\._index"/);
  assert.match(detail, /name="intent"\s+value="verifyShopifyState"/);
  assert.match(detail, /name="intent"\s+value=\{batch\.status === "PREVIEWED" \? "merge" : "resume"\}/,
    "receipt mutations submit through the detail route's re-exported action");
  assert.match(newImport, /return redirect\(`\/app\/imports\/history\/\$\{encodeURIComponent\(batchId\)\}`\)/,
    "successful merge navigates to the correct selected receipt route");
});

test("Merge UI scope and blocked-row gates match the action's resumable workflow", async (t) => {
  const [detail, newImport] = await Promise.all([
    source(historyDetailRoute),
    source(newImportRoute),
  ]);
  const mergeDisabled = detail.match(/const mergeDisabled\s*=\s*([^;]+);/)?.[1] ?? "";
  const mergeAction = newImport.slice(
    newImport.indexOf('if (intent === "merge" || intent === "resume")'),
    newImport.indexOf("const attemptId", newImport.indexOf('if (intent === "merge" || intent === "resume")')),
  );

  await t.test("inventory-only batches do not require write_products", () => {
    assert.match(mergeAction, /const needsProductWrite\s*=\s*batch\.lines\.some\([\s\S]*?line\.operationType\s*===\s*"CREATE_DRAFT"[\s\S]*?\);[\s\S]*?if\s*\(needsProductWrite\)\s*neededScopes\.add\("write_products"\)/,
      "the action requires write_products only when eligible CREATE_DRAFT lines need it");
    assert.match(mergeDisabled, /write_products[\s\S]*(?:needsProductWrite|productWriteRequired)|(?:needsProductWrite|productWriteRequired)[\s\S]*write_products/,
      "the UI must not disable an inventory-only batch solely because write_products is absent");
  });

  await t.test("resuming INVENTORY_ITEM_CONFIGURING remains write_products-gated", () => {
    const exemptStages = mergeAction.match(/!\[([^\]]*)\]\.includes\(line\.stage\)/)?.[1] ?? "";
    assert.doesNotMatch(exemptStages, /INVENTORY_ITEM_CONFIGURING/,
      "this resume stage continues into productVariantsBulkUpdate and must not be exempt from write_products");
  });

  await t.test("blocked rows require explicit partial confirmation and stay excluded from processing", () => {
    assert.match(mergeAction, /const excludedLines = batch\.lines\.filter/);
    assert.match(mergeAction, /const eligibleLines = batch\.lines\.filter/);
    assert.match(mergeAction, /formData\.get\("partialConfirmed"\) !== "yes"/,
      "the server must require explicit partial-import confirmation when blocked rows exist");
    assert.doesNotMatch(mergeDisabled, /blocked\s*>\s*0/,
      "eligible rows can be merged while blocked rows remain excluded");
  });
});
