import type { RestockData, RestockPeriod, RestockRowInput } from "./restock.types";
import { computeCompleteShopLocalDateWindow } from "../overview-analytics-dates.shared";

const FIXTURES: Array<Omit<RestockRowInput, "unitsSold"> & { units28: number; units56: number }> = [
  { variantId: "gid://shopify/ProductVariant/demo-101", productId: "gid://shopify/Product/demo-10", productTitle: "Classic T-Shirt", variantTitle: "Black / M", sku: "TSHIRT-BLK-M", createdAt: "2025-09-12T00:00:00.000Z", inventoryStatus: "known", available: 3, units28: 42, units56: 80 },
  { variantId: "gid://shopify/ProductVariant/demo-102", productId: "gid://shopify/Product/demo-10", productTitle: "Classic T-Shirt", variantTitle: "Black / L", sku: "TSHIRT-BLK-L", createdAt: "2025-09-12T00:00:00.000Z", inventoryStatus: "known", available: 110, units28: 36, units56: 71 },
  { variantId: "gid://shopify/ProductVariant/demo-201", productId: "gid://shopify/Product/demo-20", productTitle: "Relaxed Jeans", variantTitle: "Indigo / 30", sku: "JEAN-IND-30", createdAt: "2024-04-03T00:00:00.000Z", inventoryStatus: "known", available: 58, units28: 3, units56: 7 },
  { variantId: "gid://shopify/ProductVariant/demo-301", productId: "gid://shopify/Product/demo-30", productTitle: "Cotton Hoodie", variantTitle: "Grey / S", sku: "HOOD-GRY-S", createdAt: "2026-10-26T00:00:00.000Z", inventoryStatus: "known", available: 0, units28: 2, units56: 2 },
  { variantId: "gid://shopify/ProductVariant/demo-302", productId: "gid://shopify/Product/demo-30", productTitle: "Cotton Hoodie", variantTitle: "Grey / M", sku: "DUPLICATE-SKU", createdAt: "2025-03-14T00:00:00.000Z", inventoryStatus: "known", available: 0, units28: 25, units56: 49 },
  { variantId: "gid://shopify/ProductVariant/demo-303", productId: "gid://shopify/Product/demo-30", productTitle: "Cotton Hoodie", variantTitle: "Navy / M", sku: "DUPLICATE-SKU", createdAt: "2025-03-14T00:00:00.000Z", inventoryStatus: "known", available: 8, units28: 0, units56: 0 },
  { variantId: "gid://shopify/ProductVariant/demo-401", productId: "gid://shopify/Product/demo-40", productTitle: "Canvas Cap", variantTitle: "One Size", sku: "CAP-CAN-OS", createdAt: "2025-02-14T00:00:00.000Z", inventoryStatus: "untracked", available: null, units28: 4, units56: 7 },
  { variantId: "gid://shopify/ProductVariant/demo-501", productId: "gid://shopify/Product/demo-50", productTitle: "Gift Card", variantTitle: "$50", sku: "GIFT-50", createdAt: "2024-01-02T00:00:00.000Z", inventoryStatus: "non_physical", available: null, units28: 12, units56: 25 },
  { variantId: "gid://shopify/ProductVariant/demo-601", productId: "gid://shopify/Product/demo-60", productTitle: "Wool Scarf", variantTitle: "Olive / One Size", sku: "SCARF-OLV", createdAt: "2025-10-10T00:00:00.000Z", inventoryStatus: "unknown", available: null, units28: 9, units56: 17 },
];

export function createRestockDemo(period: RestockPeriod, generatedAt: Date = new Date("2026-10-29T12:00:00.000Z")): RestockData {
  const timeZone = "America/New_York";
  const window = computeCompleteShopLocalDateWindow(generatedAt, period, timeZone);
  return {
    mode: "demo", shop: "Sample Outfitters", timeZone, currencyCode: "USD",
    generatedAt: generatedAt.toISOString(), period,
    periodStartDate: window.dates[0], periodStartUtc: window.startUtc, analysisDays: period,
    salesStatus: "ready", salesDemandComplete: true, salesMessage: null, inventoryStatus: "partial",
    inventoryMessage: "Demo includes known, unknown, untracked, and non-physical inventory cases.",
    inventoryCatalogComplete: true,
    rows: FIXTURES.map(({ units28, units56, ...row }) => ({ ...row, unitsSold: period === 28 ? units28 : units56 })),
  };
}
