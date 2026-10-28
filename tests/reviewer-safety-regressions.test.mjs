/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: resolve(process.cwd(), "app/utils"),
  appType: "custom",
  server: { middlewareMode: true },
  logLevel: "error",
});
const { aggregateInventoryVariants } = await vite.ssrLoadModule("/overview-analytics.shared.ts");
const { compareCatalogGroups } = await vite.ssrLoadModule("/catalog-compare.shared.ts");
const { buildCatalogExecutionPlan } = await vite.ssrLoadModule("/catalog-execution.shared.ts");
test.after(() => vite.close());

const repoFile = (path) => new URL(`../${path}`, import.meta.url);

test("changed-snapshot recompare does not reassign the review identity referenced by prior execution history", async () => {
  const route = await readFile(repoFile("app/routes/app.imports.catalog.$batchId.tsx"), "utf8");
  const executionMigration = await readFile(repoFile("prisma/migrations/20261028200000_catalog_execution/migration.sql"), "utf8");
  const historyCopy = route.indexOf("await tx.catalogImportReviewHistory.create");
  assert.notEqual(historyCopy, -1, "changed comparisons archive the previous review first");
  const reviewUpdate = route.indexOf("tx.catalogImportReview.update", historyCopy);
  const branchEnd = route.indexOf("records.push(record)", reviewUpdate);
  assert.ok(reviewUpdate > historyCopy && branchEnd > reviewUpdate, "the changed-snapshot branch updates the current review after archiving it");
  const changedSnapshotBranch = route.slice(historyCopy, branchEnd);

  assert.match(executionMigration, /CatalogExecutionOperation_review_fkey[\s\S]*?FOREIGN KEY \("shop", "batchId", "groupId", "reviewId"\)[\s\S]*?ON UPDATE CASCADE/,
    "the execution relation currently follows updates to the review primary key");
  assert.doesNotMatch(changedSnapshotBranch, /\bid:\s*randomUUID\(\)/,
    "recompare must not move old execution records onto a new snapshot identity; preserve/archive the prior operation identity instead");
});

test("untracked-only inventory is explicitly partial and is not presented as verified availability", async () => {
  const result = aggregateInventoryVariants([{
    id: "variant-untracked",
    title: "Small",
    sku: "SKU-UNTRACKED",
    product: { id: "product-1", title: "Test Shirt" },
    tracked: false,
    levels: [],
  }]);

  assert.equal(result.status, "partial", "untracked variants cannot make the inventory summary appear fully verified");
  assert.match(result.reason ?? "", /untracked|unknown/i);
  assert.equal(result.untrackedCount, 1);
  assert.equal(result.lowStockSkuCount, 0);
  assert.equal(result.outOfStockSkuCount, 0);
  assert.equal(result.totalTrackedKnown, 0);
  assert.deepEqual(result.lowStockVariants, []);
  assert.deepEqual(result.outOfStockVariants, []);
});

test("Overview labels partial inventory counts as observed data, not as a guaranteed lower bound", async () => {
  const dashboard = await readFile(repoFile("app/components/OverviewDashboard.tsx"), "utf8");
  assert.match(dashboard, /function inventorySkuCountLabel\(value: number, partial: boolean\)[\s\S]*?partial \? "Observed "/,
    "partial inventory counts must be presented as observations, since unseen duplicate-SKU variants can change the aggregate classification");
  assert.doesNotMatch(dashboard, /function inventorySkuCountLabel\(value: number, partial: boolean\)[\s\S]*?partial \? "At least "/,
    "a partial count is not necessarily a lower bound when unread variants can share a SKU and move it across the threshold");
  assert.equal([...dashboard.matchAll(/inventorySkuCountLabel\(inventory\.(?:lowStockSkuCount|outOfStockSkuCount), analytics\.inventory\.status === "partial"\)/g)].length, 3,
    "the low-stock KPI and both inventory summary counts use the partial-aware observed label");
  assert.match(dashboard, /<AnalyticsNotice status=\{analytics\.inventory\.status\} message=\{analytics\.inventory\.message\} \/>/,
    "the inventory section retains the explicit partial-data explanation alongside observed counts");
  assert.match(dashboard, /No low-stock or out-of-stock SKU can be confirmed from the available tracked inventory data\./,
    "unknown or untracked availability is not described as verified zero stock");
});

test("analytics metric docs describe observed partial inventory counts and the shared per-load line-item attempt budget", async () => {
  const metrics = await readFile(repoFile("docs/OVERVIEW_ANALYTICS_METRICS.md"), "utf8");

  assert.match(metrics, /observed counts are not guaranteed lower bounds/i,
    "partial inventory classifications are observations, not guaranteed lower bounds");
  assert.doesNotMatch(metrics, /low\/out-of-stock[^\n]*\bat least\b/i,
    "partial inventory counts must not claim to be a lower bound when unseen same-SKU variants can change classification");

  assert.match(metrics, /Each analytics load[^\n]*shared budget of at most 100 line-item continuation GraphQL network attempts across all orders/i,
    "the docs must state that the 100 continuation attempt budget is shared across the analytics load");
  assert.match(metrics, /Retries count against this budget/i,
    "continuation retries must consume the shared per-load attempt budget");
});

test("an unmatched Size/Color combination is a non-confirmable conflict when the executor cannot add it to an existing product", async () => {
  const row = (id, sku, size) => ({
    id, groupId: "group-1", title: "Shirt", sku, price: "10.00", size, color: "Blue",
    description: "Description", vendor: "Acme", productType: "Shirt", confirmed: true, quality: "READY",
    fields: {
      title: { value: "Shirt", mapped: true }, sku: { value: sku, mapped: true },
      price: { value: "10.00", mapped: true }, size: { value: size, mapped: true }, color: { value: "Blue", mapped: true },
    },
  });
  const existingVariant = {
    id: "variant-m-blue", sku: "S-M-BLUE", price: "9.00", selectedOptions: [{ name: "Size", value: "M" }, { name: "Color", value: "Blue" }],
    productId: "product-1", productTitle: "Shirt", productDescription: "Description", vendor: "Acme", productType: "Shirt",
    productOptions: [{ name: "Size", values: ["M", "L"] }, { name: "Color", values: ["Blue"] }],
  };
  const rows = [row("line-m", "S-M-BLUE", "M"), row("line-l", "S-L-BLUE", "L")];
  const proposal = compareCatalogGroups(rows, [existingVariant])[0];
  const decisions = {
    schemaVersion: 1,
    group: "CONFIRM",
    productFields: { title: "KEEP_SHOPIFY", description: "KEEP_SHOPIFY", vendor: "KEEP_SHOPIFY", productType: "KEEP_SHOPIFY" },
    variants: Object.fromEntries(rows.map((entry) => [entry.id, {
      operation: "UPDATE",
      // Size/Color Use CSV is disabled by the UPDATE UI. Even with those
      // options kept, the unmatched SKU still makes this confirmed UPDATE
      // impossible for the executor.
      fields: { sku: "USE_CSV", price: "USE_CSV", size: "KEEP_SHOPIFY", color: "KEEP_SHOPIFY" },
    }])),
  };
  const executionPlan = buildCatalogExecutionPlan({
    review: { operation: "UPDATE", status: "CONFIRMED", shopifyProductId: "product-1", snapshot: { variants: [existingVariant] }, decisions },
    group: { id: "group-1", confirmedAt: new Date("2026-10-28T00:00:00.000Z"), selections: {}, lines: rows },
    mapping: { productName: "productName", sku: "sku", price: "price", size: "size", color: "color" },
    snapshotVariants: [existingVariant],
  });
  assert.equal(executionPlan.disposition, "CONFLICT", "the P2 executor rejects existing-product Size/Color additions");

  const route = await readFile(repoFile("app/routes/app.imports.catalog.$batchId.tsx"), "utf8");
  const canConfirm = route.match(/const canConfirm = [^\n]+/)?.[0] ?? "";
  assert.match(canConfirm, /proposal\.disposition !== "CONFLICT"/,
    "the route allows UPDATE proposals to be confirmed because it rejects only Conflict and Skip dispositions");
  assert.equal(proposal.disposition, "CONFLICT",
    "compare must surface this unsupported update as Conflict before the route's confirmation control can accept it");
});
