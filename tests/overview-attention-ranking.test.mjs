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

test("attention ranking uses demand beyond the five displayed best sellers", async () => {
  const { aggregateSalesOrders } = await vite.ssrLoadModule("/app/utils/overview-analytics.shared.ts");
  const { rankInventoryAttention } = await vite.ssrLoadModule("/app/components/overview/attention-ranking.ts");
  const sold = [100, 90, 80, 70, 40, 30, 20, 10].map((units, index) => ({
    id: `variant-${index}`,
    units,
    product: { id: `product-${index}`, title: `Product ${index}` },
    variant: { id: `variant-${index}`, title: `Variant ${index}` },
  }));
  const sales = aggregateSalesOrders([{
    id: "order-1",
    createdAt: "2026-10-28T12:00:00.000Z",
    test: false,
    lineItems: sold.map(({ units, product, variant }, index) => ({
      id: `line-${index}`,
      currentQuantity: units,
      priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount: String(units), currencyCode: "USD" } },
      product,
      variant,
    })),
  }], { currencyCode: "USD", timeZone: "UTC", dates: ["2026-10-28"] });

  assert.equal(sales.topVariants.length, 5, "the Best Sellers display ranking remains capped at five");
  assert.ok(!sales.topVariants.some(({ id }) => id === "variant-5"));
  const item = (id, available) => ({
    id,
    title: id,
    sku: id,
    product: { id: `product-${id}`, title: id },
    available,
  });
  const inventory = {
    outOfStockVariants: [item("variant-6", 0)],
    lowStockVariants: [item("variant-5", 4), item("variant-7", 1)],
  };

  const ranked = rankInventoryAttention(inventory, sales, true);
  assert.deepEqual(ranked.map(({ id, salesUnits }) => [id, salesUnits]), [
    ["variant-5", 30],
    ["variant-6", 20],
    ["variant-7", 10],
  ], "known velocity outranks stock severity even when the candidate is outside the display top five");
});

test("trusted sales data treats an unlisted attention candidate as zero sold", async () => {
  const { aggregateSalesOrders } = await vite.ssrLoadModule("/app/utils/overview-analytics.shared.ts");
  const { rankInventoryAttention } = await vite.ssrLoadModule("/app/components/overview/attention-ranking.ts");
  const sales = aggregateSalesOrders([{
    id: "order-1",
    createdAt: "2026-10-28T12:00:00.000Z",
    test: false,
    lineItems: [{
      id: "line-1",
      currentQuantity: 5,
      priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount: "5", currencyCode: "USD" } },
      product: { id: "product-sold", title: "Sold product" },
      variant: { id: "sold-variant", title: "Sold variant" },
    }],
  }], { currencyCode: "USD", timeZone: "UTC", dates: ["2026-10-28"] });
  const sold = {
    id: "sold-variant",
    title: "Sold variant",
    sku: null,
    product: { id: "product-sold", title: "Sold product" },
    available: 2,
  };
  const zeroSales = {
    id: "zero-sales-variant",
    title: "Zero-sales variant",
    sku: null,
    product: { id: "product-zero", title: "Zero-sales product" },
    available: 0,
  };
  const inventory = { outOfStockVariants: [zeroSales], lowStockVariants: [sold] };

  const ranked = rankInventoryAttention(inventory, sales, true);
  assert.deepEqual(ranked.map(({ id, salesUnits }) => [id, salesUnits]), [
    ["sold-variant", 5],
    ["zero-sales-variant", 0],
  ], "an omitted candidate is known to have zero selected-period sales and ranks behind positive demand");

  const inventoryOnly = rankInventoryAttention(inventory, null, false);
  assert.deepEqual(inventoryOnly.map(({ id, salesUnits }) => [id, salesUnits]), [
    ["zero-sales-variant", null],
    ["sold-variant", null],
  ], "inventory-only fallback keeps sales unknown and ranks by stock severity");
});
