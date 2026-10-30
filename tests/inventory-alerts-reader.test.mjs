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

const { inventoryAlertRowFromVariant, loadInventoryAlertsData } = await vite.ssrLoadModule("/app/utils/inventory-alerts.server.ts");
const { canExportInventoryAlertRows } = await vite.ssrLoadModule("/app/utils/inventory-alerts.shared.ts");
const base = (overrides = {}) => ({
  id: "gid://shopify/ProductVariant/1", inventoryItemId: "gid://shopify/InventoryItem/1",
  selectedOptions: [{ name: "Color", value: "Blue" }, { name: "Size", value: "M" }],
  sku: "SKU-1", createdAt: null, productType: "Shirt", product: { id: "gid://shopify/Product/1", title: "Shirt" },
  tracked: true, complete: true, inventoryStatus: "known", available: 3,
  ...overrides,
});

test("Inventory Alerts maps localized color/size option names and keeps Shopify identities", () => {
  const row = inventoryAlertRowFromVariant(base({
    selectedOptions: [{ name: "Màu sắc", value: "Đỏ" }, { name: "Kích thước", value: "M" }],
  }));
  assert.equal(row.color, "Đỏ");
  assert.equal(row.size, "M");
  assert.equal(row.productId, "gid://shopify/Product/1");
  assert.equal(row.variantId, "gid://shopify/ProductVariant/1");
  assert.equal(row.inventoryItemId, "gid://shopify/InventoryItem/1");
});

test("missing inventory identity and incomplete location reads remain unknown or partial, never zero", () => {
  const missingIdentity = inventoryAlertRowFromVariant(base({ inventoryItemId: null, available: 0 }));
  assert.equal(missingIdentity.availableQuantity, null);
  assert.equal(missingIdentity.status, "UNKNOWN");
  assert.equal(missingIdentity.complete, false);

  const missingLevel = inventoryAlertRowFromVariant(base({
    complete: false, inventoryStatus: "unknown", available: null,
  }));
  assert.equal(missingLevel.availableQuantity, null);
  assert.equal(missingLevel.status, "PARTIAL_DATA");

  const noActiveLevel = inventoryAlertRowFromVariant(base({
    complete: true, inventoryStatus: "unknown", available: null,
  }));
  assert.equal(noActiveLevel.status, "UNKNOWN");
});

test("alerts CSV blocks incomplete location or missing identity but permits fully read unknown and untracked rows", () => {
  const checkedAt = "2026-10-29T08:00:00Z";
  const live = (rows, extra = {}) => ({ catalogComplete: true, checkedAt, readStatus: "partial", source: "live", rows, ...extra });
  const incompleteLocation = inventoryAlertRowFromVariant(base({
    complete: false, inventoryStatus: "unknown", available: null,
  }));
  assert.equal(incompleteLocation.status, "PARTIAL_DATA");
  assert.equal(canExportInventoryAlertRows(live([incompleteLocation])), false,
    "known tracked variants with incomplete active-location reads block the whole file");
  const missingIdentity = inventoryAlertRowFromVariant(base({ inventoryItemId: null, available: 0 }));
  assert.equal(canExportInventoryAlertRows(live([missingIdentity])), false,
    "missing inventory identity is incomplete uncertainty, not an ordinary fully read UNKNOWN");
  assert.equal(canExportInventoryAlertRows(live([], { catalogComplete: false })), false,
    "a capped catalog cannot be exported as complete");
  assert.equal(canExportInventoryAlertRows(live([], { checkedAt: null })), false,
    "no successful read timestamp cannot be exported");

  const unknown = inventoryAlertRowFromVariant(base({ inventoryStatus: "unknown", available: null, complete: true }));
  const untracked = inventoryAlertRowFromVariant(base({ tracked: false, complete: true, available: null }));
  assert.equal(canExportInventoryAlertRows(live([unknown, untracked])), true,
    "fully read unknown or untracked variants do not block known-alert export when catalog and location reads completed");
  const untrackedIncomplete = inventoryAlertRowFromVariant(base({ tracked: false, complete: false, available: null }));
  assert.equal(canExportInventoryAlertRows(live([untrackedIncomplete])), true,
    "an affirmatively untracked variant remains exempt from incomplete-level blocking");
  assert.equal(canExportInventoryAlertRows({ ...live([incompleteLocation]), source: "sample" }), true,
    "sample partial rows are excluded from alerts but do not imply a live incomplete read");
});

test("live reader requires location scope before querying and uses inventory-only reads when granted", async () => {
  let adminCalls = 0;
  const denied = await loadInventoryAlertsData({
    admin: { graphql: async () => { adminCalls += 1; throw new Error("no product read expected"); } },
    scopes: { query: async () => ({ granted: ["read_products", "read_inventory"] }) },
    shop: "example.myshopify.com",
  });
  assert.equal(denied.readStatus, "permission_required");
  assert.equal(denied.message, "Live Inventory Alerts require read_locations. No inventory query was sent.");
  assert.equal(adminCalls, 0, "the current product/inventory grant cannot query locations without read_locations");

  const queries = [];
  const live = await loadInventoryAlertsData({
    admin: { graphql: async (query) => {
      queries.push(query);
      return Response.json({ data: { productVariants: {
        nodes: [{
          id: "gid://shopify/ProductVariant/1", title: "Blue / M", sku: "SKU-1",
          selectedOptions: [{ name: "Color", value: "Blue" }, { name: "Size", value: "M" }],
          product: { id: "gid://shopify/Product/1", title: "Shirt", productType: "T-Shirt", isGiftCard: false },
          inventoryItem: { id: "gid://shopify/InventoryItem/1", tracked: true, inventoryLevels: {
            nodes: [{ isActive: true, location: { isActive: true }, quantities: [{ name: "available", quantity: 2 }] }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } },
        }], pageInfo: { hasNextPage: false, endCursor: null },
      } } });
    } },
    scopes: { query: async () => ({ granted: ["read_products", "read_inventory", "read_locations"] }) },
    shop: "example.myshopify.com", now: () => new Date("2026-10-29T08:00:00.000Z"),
  });
  assert.equal(live.readStatus, "ready");
  assert.equal(live.checkedAt, "2026-10-29T08:00:00.000Z");
  assert.equal(live.rows[0].status, "LOW_STOCK");
  assert.equal(live.rows[0].availableQuantity, 2);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /productVariants/);
  assert.doesNotMatch(queries.join(" "), /\borders\s*\(|\border\s*\(/i);
  assert.doesNotMatch(queries.join(" "), /mutation\s/i);
});
