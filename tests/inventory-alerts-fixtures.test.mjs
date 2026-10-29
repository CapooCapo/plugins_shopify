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

const { createInventoryAlertsSample } = await vite.ssrLoadModule("/app/utils/inventory-alerts-fixtures.ts");

test("Inventory Alerts sample is isolated and sums the exact listed variant values across two locations", () => {
  const sample = createInventoryAlertsSample(new Date("2026-10-29T08:00:00.000Z"));
  const byOption = (productName, color, size) => sample.rows.find((row) => row.productName === productName && row.color === color && row.size === size);
  assert.equal(sample.source, "sample");
  assert.equal(sample.activeLocationCount, 2);
  assert.equal(byOption("Everyday Polo", "Red", "S").availableQuantity, 2);
  assert.equal(byOption("Everyday Polo", "Red", "M").availableQuantity, 0);
  assert.equal(byOption("Everyday Polo", "Blue", "M").availableQuantity, 0);
  assert.equal(byOption("Everyday Polo", "Yellow", "L").availableQuantity, 10);
  assert.equal(byOption("Classic T-Shirt", "Black", "S").availableQuantity, 4);
  assert.equal(byOption("Classic T-Shirt", "Black", "M").availableQuantity, 0);
  assert.equal(byOption("Classic T-Shirt", "White", "L").availableQuantity, 15);

  const duplicateSkuRows = sample.rows.filter((row) => row.sku === "DUP-SAMPLE-01");
  assert.equal(duplicateSkuRows.length, 2);
  assert.notEqual(duplicateSkuRows[0].variantId, duplicateSkuRows[1].variantId);
  assert.ok(sample.rows.some((row) => row.status === "UNTRACKED"));
  assert.ok(sample.rows.some((row) => row.status === "UNKNOWN"));
  assert.ok(sample.rows.some((row) => row.status === "PARTIAL_DATA"));
  assert.ok(sample.rows.some((row) => row.availableQuantity < 0 && row.status === "OUT_OF_STOCK"));
  assert.ok(sample.rows.some((row) => row.color === null && row.size === null));
  assert.equal(sample.checkedAt, "2026-10-29T08:00:00.000Z");
});
