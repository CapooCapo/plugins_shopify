/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: "custom",
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [], entries: [] },
  logLevel: "error",
});
test.after(async () => vite.close());

const { summarizeCatalogExecution } = await vite.ssrLoadModule("/app/utils/overview-import-status.ts");
const { importStatusLabel } = await vite.ssrLoadModule("/app/components/overview/format.ts");

test("catalog import labels summarize operation state without implying inventory completion", () => {
  const cases = [
    ["DRAFT", [], "CATALOG_DRAFT", "Draft"],
    ["MAPPING", [], "CATALOG_MAPPING", "Mapping columns"],
    ["DRAFT", ["READY"], "CATALOG_DRAFT", "Draft"],
    ["DRAFT", ["RUNNING"], "CATALOG_IN_PROGRESS", "In progress"],
    ["DRAFT", ["RECONCILING"], "CATALOG_IN_PROGRESS", "In progress"],
    ["DRAFT", ["UNKNOWN"], "CATALOG_UNCERTAIN", "Outcome uncertain"],
    ["DRAFT", ["FAILED"], "CATALOG_ATTENTION", "Needs attention"],
    ["DRAFT", ["CONFLICT"], "CATALOG_ATTENTION", "Needs attention"],
    ["DRAFT", ["SUCCEEDED"], "CATALOG_EXECUTION_COMPLETE", "Catalog execution complete"],
    ["DRAFT", ["SUCCEEDED", "SKIPPED"], "CATALOG_EXECUTION_COMPLETE", "Catalog execution complete"],
    ["DRAFT", ["SUCCEEDED", "FAILED"], "CATALOG_ATTENTION", "Needs attention"],
  ];
  for (const [batchStatus, operationStatuses, expectedStatus, expectedLabel] of cases) {
    const status = summarizeCatalogExecution(batchStatus, operationStatuses);
    assert.equal(status, expectedStatus);
    assert.equal(importStatusLabel(status, "catalog"), expectedLabel);
  }
  assert.equal(importStatusLabel("COMPLETED", "catalog"), "Catalog status · COMPLETED",
    "a catalog lifecycle never reuses inventory's Completed label");
});
