/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const overviewRoute = new URL("../app/routes/app._index.tsx", import.meta.url);
const overviewComponent = new URL("../app/components/OverviewDashboard.tsx", import.meta.url);

test("Overview import KPIs and recent activity are bounded and scoped to the authenticated shop", async () => {
  const source = await readFile(overviewRoute, "utf8");
  const view = await readFile(overviewComponent, "utf8");

  assert.match(source, /authenticate\.admin\(request\)[\s\S]*?session/);
  assert.match(source, /prisma\.importBatch\.groupBy\(\{\s*by:\s*\["status"\],\s*where:\s*\{\s*shop:\s*session\.shop\s*\},\s*_count:\s*\{\s*_all:\s*true\s*\},?\s*\}\)/,
    "batch status aggregation must use one strict authenticated-shop query");
  assert.doesNotMatch(source, /prisma\.importBatch\.count\(/,
    "the prior independent total and failed count queries should remain consolidated");
  assert.match(source, /summarizeImportBatchStatusCounts\(statusCounts\)/,
    "KPIs should be derived from grouped status counts");
  assert.match(source, /where:\s*\{\s*shop:\s*session\.shop\s*\}[\s\S]*?take:\s*5[\s\S]*?select:/,
    "recent activity must be shop-scoped, limited to five, and select only displayed fields");
  assert.match(source, /<OverviewDashboard data=\{data\} error=\{error\} imports=\{imports\}/,
    "the route must render the production dashboard component with live loader data");
  assert.match(view, />Import batches</);
  assert.match(view, />Needs attention</);
  assert.match(view, /failed, uncertain or partial imports/);
  assert.match(view, /stockhub-overview-attention/);
  assert.match(view, />Recent imports</);
  assert.match(view, />At a glance</);
  assert.match(view, /data\.shop\.name[\s\S]*?data\.shop\.myshopifyDomain/,
    "the dashboard identifies the currently authenticated shop");
  assert.doesNotMatch(view, /Total SKUs|store-wide SKU total/i,
    "the dashboard must not imply that it computed a store-wide SKU count");
  assert.match(view, /className="stockhub-overview-metrics"/,
    "metrics use the app-owned responsive grid");
  assert.match(view, /aria-label="Overview quick actions"/);
  for (const [label, path] of [
    ["New import", "/app/imports"],
    ["Browse products", "/app/products"],
    ["Import history", "/app/imports/history"],
    ["Store details", "/app/stores"],
  ]) {
    assert.match(view, new RegExp(`(?:<s-button href=|<Link to=)"${path.replaceAll("/", "\\/")}"[^>]*>${label}`),
      `${label} must lead to its real destination`);
  }
  assert.match(view, /\/app\/imports\/history\/\$\{encodeURIComponent\(batch\.id\)\}/,
    "recent receipts should open their dedicated history detail route");
  assert.match(view, /Import activity is currently unavailable/,
    "a failed DB read must not be presented as a fabricated zero count");
  assert.match(view, /data\.all|formatCount\(data\.all\)/,
    "the existing live Shopify product-count presentation must remain");
  assert.match(view, /data\.all\.count - data\.active\.count - data\.draft\.count/,
    "a status breakdown should account for products beyond active and draft");
});

test("Overview status aggregation handles empty, failed, mixed, and unknown statuses", async () => {
  const source = await readFile(overviewRoute, "utf8");
  const functionSource = source.match(/export function summarizeImportBatchStatusCounts\([\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, "pure status aggregation helper should be exported");

  const javascript = ts.transpileModule(functionSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { summarizeImportBatchStatusCounts } = await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  );

  assert.deepEqual(summarizeImportBatchStatusCounts([]), { batchCount: 0, attentionBatchCount: 0 });
  assert.deepEqual(summarizeImportBatchStatusCounts([
    { status: "FAILED", _count: { _all: 3 } },
  ]), { batchCount: 3, attentionBatchCount: 3 });
  assert.deepEqual(summarizeImportBatchStatusCounts([
    { status: "COMPLETED", _count: { _all: 4 } },
    { status: "FAILED", _count: { _all: 2 } },
    { status: "UNCERTAIN", _count: { _all: 3 } },
    { status: "PARTIAL", _count: { _all: 2 } },
    { status: "RUNNING", _count: { _all: 1 } },
  ]), { batchCount: 12, attentionBatchCount: 7 });
  assert.deepEqual(summarizeImportBatchStatusCounts([
    { status: "FUTURE_STATUS", _count: { _all: 5 } },
    { status: "failed", _count: { _all: 2 } },
  ]), { batchCount: 7, attentionBatchCount: 0 },
  "unknown and differently-cased statuses contribute to total but not attention counts");
});
