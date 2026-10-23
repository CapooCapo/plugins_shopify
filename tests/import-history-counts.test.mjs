/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const historyRoute = new URL("../app/routes/app.imports.history._index.tsx", import.meta.url);

test("Import History sums grouped line totals without expanding per-line outcomes", async () => {
  const source = await readFile(historyRoute, "utf8");

  assert.match(source, /by:\s*\["batchId",\s*"status",\s*"operationType"\]/,
    "history aggregates line groups in one query");
  assert.match(source, /_count:\s*\{\s*_all:\s*true\s*\}/,
    "each grouped status/operation contributes its full line count");
  assert.match(source, /for\s*\(const group of lineGroups\)\s*rowCounts\.set\(group\.batchId,\s*\(rowCounts\.get\(group\.batchId\)\s*\?\?\s*0\)\s*\+\s*group\._count\._all\)/,
    "all outcome groups are summed into the receipt's total row count");
  assert.match(source, /<s-table-cell>\{batch\.rowCount\}<\/s-table-cell>/,
    "the compact History row displays its total line count");
  assert.doesNotMatch(source, /lineCounts\.(?:failed|blocked|uncertain|pending)/,
    "the compact History list does not reintroduce per-line outcome counts");
});
