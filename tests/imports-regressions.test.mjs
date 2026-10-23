/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MAX_CSV_BYTES } from "../app/utils/csv-limits.js";

const importsRoute = new URL("../app/routes/app.imports._index.tsx", import.meta.url);
const historyRoute = new URL("../app/routes/app.imports.history._index.tsx", import.meta.url);
const historyDetailRoute = new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url);

async function getReadRequestBodyLimited() {
  let bodyReader;
  try {
    bodyReader = await import("../app/utils/request-body.server.ts");
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail(
        "Missing regression target app/utils/request-body.server.ts#readRequestBodyLimited",
      );
    }
    throw error;
  }

  assert.equal(
    typeof bodyReader.readRequestBodyLimited,
    "function",
    "request-body.server.ts must export readRequestBodyLimited(request, maxBytes)",
  );
  return bodyReader.readRequestBodyLimited;
}

test("CSV import exposes an accessible status while its submission is pending", async () => {
  const source = await readFile(importsRoute, "utf8");

  assert.ok(
    /useNavigation\s*\(/.test(source),
    "the import route must read the current navigation state",
  );
  assert.ok(
    /navigation\.state\s*={2,3}\s*["']submitting["']/.test(source),
    "the loading state must be reachable while the CSV form is submitting",
  );
  assert.ok(
    /role\s*=\s*["']status["']/.test(source),
    "the loading state must be exposed to assistive technology",
  );
});

test("Import History uses a truthful legacy receipt fallback and keeps line outcomes on detail", async () => {
  const [source, detail] = await Promise.all([
    readFile(historyRoute, "utf8"),
    readFile(historyDetailRoute, "utf8"),
  ]);

  assert.match(source, /legacy|receipt\s+unavailable|unknown\s+receipt/i,
    "blank historical receipt codes must be labeled as unavailable rather than assigned an invented code");
  assert.match(source, /<s-table-cell>\{batch\.rowCount\}<\/s-table-cell>/,
    "history should retain only the total receipt line count");
  assert.doesNotMatch(source, /lineCounts\.(?:completed|failed|blocked|uncertain|pending)/,
    "history should not expand line-level outcomes into dense table rows");
  assert.match(detail, /errorDetail|errorCode/,
    "the selected batch view should expose each line's saved failure reason");
  assert.match(source, /function\s+receiptCodeLabel\s*\([^)]*\)\s*\{[\s\S]*?receiptCode\?\.trim\(\)\s*\|\|\s*["'`][^"'`]+["'`]/,
    "receipt display fallback must be presentation-only and must not mutate stored historical data");
  assert.match(source, /receiptCodeLabel\(batch\.receiptCode\)/,
    "Import History must apply the presentation fallback to legacy rows");
  assert.match(source, /rowCount/);
  assert.match(detail, /Import lines completed:\s*\{successful\}/);
  assert.match(detail, /Unresolved Draft product creation:\s*\{uncertainProductCreations\}/);
  assert.match(detail, /Failed:\s*\{failed\}.*Blocked:\s*\{blocked\}.*Uncertain:\s*\{uncertain\}/);
});

test("Import History explains progress for created, failed, and completed lines", async () => {
  const source = await readFile(historyDetailRoute, "utf8");
  const progressLabel = source.match(/function\s+stageLabel\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1];

  assert.ok(progressLabel, "the route must define a pure per-line progress label helper");

  assert.match(
    progressLabel,
    /stage\s*===\s*["']PRODUCT_CREATED["'][\s\S]*?Draft product created/,
    "PRODUCT_CREATED must be described as a created Draft product without implying line completion",
  );
  assert.match(
    progressLabel,
    /if\s*\(status\s*===\s*["']FAILED["']\)\s*\{[\s\S]*?stage\s*===\s*["']INVENTORY_ACTIVATING["'][\s\S]*?return\s+["']Inventory activation failed["']/,
    "a failed INVENTORY_ACTIVATING line must identify the inventory activation failure",
  );
  assert.match(
    progressLabel,
    /status\s*===\s*["']SUCCEEDED["'][\s\S]*?return\s+["']Import line completed["']/,
    "a SUCCEEDED/COMPLETED line must be identified as completed",
  );
  assert.match(
    source,
    /stageLabel\(line\.stage,\s*line\.status,\s*line\.errorCode\)/,
    "the selected batch row must render the per-line stage progress label",
  );
});

test("confirmed Draft creation survives later inventory uncertainty but unresolved creation is separate", async () => {
  const source = await readFile(historyDetailRoute, "utf8");
  const confirmedProductStages = source.match(/const confirmedProductStages\s*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1];
  const confirmedProductFilter = source.slice(
    source.indexOf("const confirmedProductsCreated"),
    source.indexOf("const uncertainProductCreations"),
  );
  const unresolvedProductFilter = source.slice(
    source.indexOf("const uncertainProductCreations"),
    source.indexOf("const confirmedInventoryActivated"),
  );

  assert.ok(confirmedProductStages, "confirmed product stages must be explicit");
  assert.match(confirmedProductStages, /"INVENTORY_ACTIVATING"/,
    "a line reaching inventory activation has already confirmed product creation");
  assert.doesNotMatch(confirmedProductStages, /"PRODUCT_CREATING"/,
    "an unresolved create call is not evidence of a created Draft");
  assert.match(confirmedProductFilter, /line\.operationType === "CREATE_DRAFT"/);
  assert.match(confirmedProductFilter, /Boolean\(line\.productId\)/);
  assert.match(confirmedProductFilter, /confirmedProductStages\.has\(line\.stage\)/);
  assert.doesNotMatch(confirmedProductFilter, /status\s*===\s*"UNCERTAIN"|\["UNCERTAIN",\s*"RUNNING"\]/,
    "overall line uncertainty during a later inventory stage must not erase confirmed product creation");
  assert.match(unresolvedProductFilter, /line\.stage === "PRODUCT_CREATING"/);
  assert.match(unresolvedProductFilter, /"UNCERTAIN",\s*"RUNNING"/,
    "uncertain in-flight product creation remains separately unresolved");
  assert.match(source, /statusLabel\(line\.status\)/,
    "the ImportLine itself continues to display its own uncertain status");
});

test("Import History loads compact batch metadata and one shop-scoped batched line aggregate", async () => {
  const source = await readFile(historyRoute, "utf8");
  const historyLoader = source.slice(
    source.indexOf("export const loader ="),
    source.indexOf("function receiptCodeLabel"),
  );

  assert.ok(historyLoader.includes("prisma.importBatch.findMany"), "history batch query must exist");
  assert.match(historyLoader, /select:\s*\{[\s\S]*?receiptCode:\s*true[\s\S]*?status:\s*true/);
  assert.doesNotMatch(historyLoader, /include:\s*\{\s*lines/,
    "history metadata must not load all ImportLine records per batch");
  assert.match(historyLoader, /prisma\.importLine\.groupBy\s*\(/,
    "line counts must be fetched in one grouped query rather than N+1 queries");
  assert.match(historyLoader, /batchId:\s*\{\s*in:\s*batches\.map/);
  assert.match(historyLoader, /batch:\s*\{\s*is:\s*\{\s*shop:\s*session\.shop\s*\}\s*\}/,
    "the aggregate query must retain authenticated shop isolation");
  assert.match(historyLoader, /by:\s*\["batchId",\s*"status",\s*"operationType"\]/);
  assert.match(historyLoader, /const rowCounts = new Map\(batches\.map\(\(batch\) => \[batch\.id, 0\]\)\)/);
  assert.match(historyLoader, /rowCounts\.set\(group\.batchId,\s*\(rowCounts\.get\(group\.batchId\)\s*\?\?\s*0\)\s*\+\s*group\._count\._all\)/,
    "all grouped outcomes are summed into a single row total per receipt");
  assert.match(source, /batch\.rowCount/);
  assert.equal((source.match(/<s-table-header\s/g) ?? []).length, 5,
    "the compact History index has receipt, location, date, rows, and status columns");
  const statusMarker = source.indexOf("batchStatusLabel(batch.status)");
  const statusStart = source.lastIndexOf("<s-table-cell>", statusMarker);
  const statusEnd = source.indexOf("</s-table-cell>", statusMarker);
  const statusCell = statusStart >= 0 && statusEnd > statusStart
    ? source.slice(statusStart, statusEnd + "</s-table-cell>".length)
    : undefined;
  assert.ok(statusCell, "History status has a dedicated table cell");
  const statusBadges = statusCell.match(/<s-badge\b[^>]*>[\s\S]*?<\/s-badge>/g) ?? [];
  assert.equal(statusBadges.length, 1,
    "History status is kept as one concise badge with optional semantic props");
  assert.match(statusBadges[0], /\{batchStatusLabel\(batch\.status\)\}/);
  assert.equal(statusCell.replace(statusBadges[0], "").replace(/<\/?s-table-cell>/g, "").trim(), "",
    "the status cell must not add separate text or progress details");
});

test("Import History filters and keyset cursors are whitelisted, shop-scoped, bounded, and preserved in links", async () => {
  const source = await readFile(historyRoute, "utf8");
  const pageHref = source.match(/function\s+historyPageHref\s*\([\s\S]*?\n\}/)?.[0];
  const historyQuery = source.slice(
    source.indexOf("const where ="),
    source.indexOf("type HistoryBatchSummary", source.indexOf("const where =")),
  );

  assert.match(source, /HISTORY_STATUSES\s*=\s*\["PREVIEWED",\s*"RUNNING",\s*"COMPLETED",\s*"PARTIAL",\s*"UNCERTAIN",\s*"FAILED"\]/);
  assert.match(source, /parseHistoryStatus\(url\.searchParams\.get\("historyStatus"\)\)/);
  assert.match(source, /\?\s*value\s+as\s+HistoryStatusFilter\s*:\s*"ALL"/);
  assert.match(historyQuery, /shop:\s*session\.shop/);
  assert.match(historyQuery, /receiptCode:\s*\{\s*contains:\s*historySearch\s*\}/);
  assert.match(source, /where:\s*\{\s*\.\.\.where,\s*id:\s*cursorId\s*\}/,
    "cursor validation must be constrained by the authenticated shop and active filters");
  assert.match(source, /take:\s*HISTORY_PAGE_SIZE\s*\+\s*1/);
  assert.match(source, /const\s+HISTORY_PAGE_SIZE\s*=\s*25/);
  assert.doesNotMatch(historyQuery, /skip:/,
    "receipt history must use keyset pagination rather than deep offsets");
  assert.ok(pageHref, "a shared URL builder must preserve receipt history context");
  assert.match(pageHref, /params\.set\("historySearch",\s*search\)/);
  assert.match(pageHref, /params\.set\("historyStatus",\s*status\)/);
  assert.match(pageHref, /params\.set\("historyCursor",\s*cursor\)/);
  assert.match(pageHref, /params\.set\("historyDirection",\s*direction\)/);
  assert.match(source, /historyDetailHref\(batch\.id,\s*data\.historySearch,\s*data\.historyStatus,\s*data\.pageCursor,\s*data\.pageDirection\)/,
    "receipt details retain the selected history page and filters");
  assert.match(source, /olderCursor,\s*"older"/);
  assert.match(source, /newerCursor,\s*"newer"/);
  assert.match(source, /cursorError[\s\S]*?Return to the newest history page/);
});

test("rejects an oversized Content-Length before reading the request body", async () => {
  const readRequestBodyLimited = await getReadRequestBodyLimited();
  let pulls = 0;
  const request = {
    headers: new Headers({ "Content-Length": String(MAX_CSV_BYTES + 1) }),
    body: new ReadableStream({
      pull() {
        pulls += 1;
      },
    }),
  };

  await assert.rejects(readRequestBodyLimited(request, MAX_CSV_BYTES));
  assert.equal(pulls, 0, "Content-Length rejection must precede body reads");
});

test("rejects an oversized chunked upload before buffering the full stream", async () => {
  const readRequestBodyLimited = await getReadRequestBodyLimited();
  const chunkSize = 8 * 1024;
  const totalBytes = MAX_CSV_BYTES + 512 * 1024;
  let bytesRead = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (bytesRead >= totalBytes) {
        controller.close();
        return;
      }

      const size = Math.min(chunkSize, totalBytes - bytesRead);
      bytesRead += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
  const request = new Request("http://localhost/app/imports", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
    duplex: "half",
  });

  assert.equal(request.headers.has("Content-Length"), false);
  await assert.rejects(readRequestBodyLimited(request, MAX_CSV_BYTES));
  assert.ok(
    bytesRead < totalBytes,
    `expected early rejection before all ${totalBytes} streamed bytes were read; read ${bytesRead}`,
  );
  assert.ok(
    bytesRead <= MAX_CSV_BYTES + chunkSize,
    `expected at most one chunk beyond the ${MAX_CSV_BYTES}-byte limit; read ${bytesRead}`,
  );
});
