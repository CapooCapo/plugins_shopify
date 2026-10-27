/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, root: resolve(process.cwd(), "app/utils"), appType: "custom", server: { middlewareMode: true }, logLevel: "error" });
const { compareCatalogGroups } = await vite.ssrLoadModule("/catalog-compare.shared.ts");
const { readShopifyCatalogSnapshot } = await vite.ssrLoadModule("/catalog-shopify-read.server.ts");
test.after(() => vite.close());

const row = (patch = {}) => ({ id: "line-1", groupId: "group-1", title: "Shirt", sku: "S-1", price: "10.00", size: "M", color: null, description: "Description", vendor: "Acme", productType: "Shirt", confirmed: true, quality: "READY", fields: { title: { value: "Shirt", mapped: true }, sku: { value: "S-1", mapped: true }, price: { value: "10.00", mapped: true }, size: { value: "M", mapped: true } }, ...patch });
const shopifyVariant = (patch = {}) => ({ id: "variant-1", sku: "S-1", price: "9.00", selectedOptions: [{ name: "Size", value: "M" }], productId: "product-1", productTitle: "Shirt", productDescription: "Old description", vendor: "Acme", productType: "Shirt", productOptions: [{ name: "Size", values: ["M"] }], ...patch });

test("catalog matching classifies absent SKU as a non-eligible Create candidate and blocks unconfirmed groups", () => {
  const [create] = compareCatalogGroups([row()], []);
  assert.equal(create.disposition, "CREATE");
  assert.equal(create.eligible, false);
  assert.ok(create.changes.some((change) => change.field === "sku" && change.current === null && change.proposed === "S-1"), "Create review displays proposed CSV fields without an existing Shopify value");
  const [blocked] = compareCatalogGroups([row({ confirmed: false })], []);
  assert.equal(blocked.disposition, "SKIP");
  assert.equal(blocked.eligible, false);
});

test("exact case-sensitive SKU match proposes only changed mapped values and preserves missing or empty values", () => {
  const input = row({ fields: { title: { value: "Shirt", mapped: true }, sku: { value: "S-1", mapped: true }, price: { value: null, mapped: true }, vendor: { value: null, mapped: false } } });
  const [result] = compareCatalogGroups([input], [shopifyVariant()]);
  assert.equal(result.disposition, "UPDATE");
  assert.equal(result.productId, "product-1");
  assert.deepEqual(result.changes, [], "blank mapped price preserves current Shopify price; identical title/SKU are not changes");
  const changedPrice = compareCatalogGroups([row()], [shopifyVariant()])[0];
  assert.deepEqual(changedPrice.changes.map(({ field, current, proposed, action }) => ({ field, current, proposed, action })), [{ field: "price", current: "9.00", proposed: "10.00", action: "SET" }]);
  const caseMismatch = compareCatalogGroups([row({ sku: "s-1", title: "Different shirt" })], [shopifyVariant()])[0];
  assert.equal(caseMismatch.disposition, "CREATE", "SKU matching is exact and case-sensitive");
});

test("duplicate Shopify SKUs, matches across products, and ambiguous title identity are conflicts", () => {
  assert.equal(compareCatalogGroups([row()], [shopifyVariant(), shopifyVariant({ id: "variant-2" })])[0].disposition, "CONFLICT");
  const twoRows = [row(), row({ id: "line-2", sku: "S-2" })];
  const across = compareCatalogGroups(twoRows, [shopifyVariant(), shopifyVariant({ id: "variant-2", sku: "S-2", productId: "product-2" })])[0];
  assert.equal(across.disposition, "CONFLICT");
  const title = compareCatalogGroups([row()], [shopifyVariant({ sku: "OTHER" })])[0];
  assert.equal(title.disposition, "CONFLICT");
});

test("new Size/Color combination on an existing product is proposed for explicit review without deletion", () => {
  const input = [row(), row({ id: "line-2", sku: "S-2", size: "L" })];
  const result = compareCatalogGroups(input, [shopifyVariant()])[0];
  assert.equal(result.disposition, "UPDATE");
  assert.equal(result.variantId, null);
  assert.match(result.reason, /new Size\/Color combination/);
  assert.equal(result.eligible, false);
  const duplicateCombination = compareCatalogGroups([row(), row({ id: "line-2", sku: "S-2", size: "M" })], [shopifyVariant()])[0];
  assert.equal(duplicateCombination.disposition, "CONFLICT", "new SKU cannot duplicate an existing Size/Color combination");
});

test("read-only snapshot follows cursors, retries throttling, checks shop identity, and issues query-only operations", async () => {
  const calls = [];
  let attempts = 0;
  const graphql = async (query, options) => {
    calls.push(query);
    attempts += 1;
    if (attempts === 1) return Response.json({ errors: [{ message: "throttled", extensions: { code: "THROTTLED" } }] });
    if (options.variables.after === null) return Response.json({ data: { shop: { myshopifyDomain: "shop.myshopify.com" }, productVariants: { nodes: [{ id: "v1", sku: "A", price: "1.00", selectedOptions: [], product: { id: "p1", title: "A", descriptionHtml: null, vendor: "", productType: "", options: [] } }], pageInfo: { hasNextPage: true, endCursor: "next" } } } });
    return Response.json({ data: { shop: { myshopifyDomain: "shop.myshopify.com" }, productVariants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
  };
  const snapshot = await readShopifyCatalogSnapshot(graphql, "shop.myshopify.com");
  assert.equal(snapshot.variants.length, 1);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((query) => /^\s*#graphql\s*query/.test(query)));
  await assert.rejects(readShopifyCatalogSnapshot(graphql, "one.myshopify.com"), /does not match/);
});

test("read-only snapshot fails closed on GraphQL errors", async () => {
  await assert.rejects(readShopifyCatalogSnapshot(async () => Response.json({ errors: [{ message: "hidden detail" }] }), "shop"), /could not be read/);
});

test("read-only snapshot rejects malformed successful connections instead of treating them as empty", async () => {
  const malformedPages = [
    { data: { shop: { myshopifyDomain: "shop" }, productVariants: { pageInfo: {} } } },
    { data: { shop: { myshopifyDomain: "shop" }, productVariants: { nodes: [], pageInfo: { hasNextPage: "false", endCursor: null } } } },
    { data: { shop: { myshopifyDomain: "shop" }, productVariants: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } },
  ];
  for (const malformed of malformedPages) {
    await assert.rejects(readShopifyCatalogSnapshot(async () => Response.json(malformed), "shop"), /incomplete catalog page/);
  }
});
