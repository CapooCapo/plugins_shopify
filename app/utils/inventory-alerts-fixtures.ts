import { classifyInventoryAlert, type InventoryAlertRow } from "./inventory-alerts.shared";

type SampleVariant = Omit<InventoryAlertRow, "availableQuantity" | "status"> & { locationQuantities: number[] | null };

const sampleVariants: SampleVariant[] = [
  { productId: "gid://shopify/Product/7001", variantId: "gid://shopify/ProductVariant/7101", inventoryItemId: "gid://shopify/InventoryItem/7201", productName: "Everyday Polo", productType: "Polo", sku: "DUP-SAMPLE-01", color: "Red", size: "S", selectedOptions: [{ name: "Color", value: "Red" }, { name: "Size", value: "S" }], tracked: true, complete: true, locationQuantities: [1, 1] },
  { productId: "gid://shopify/Product/7001", variantId: "gid://shopify/ProductVariant/7102", inventoryItemId: "gid://shopify/InventoryItem/7202", productName: "Everyday Polo", productType: "Polo", sku: "POL-RED-M", color: "Red", size: "M", selectedOptions: [{ name: "Color", value: "Red" }, { name: "Size", value: "M" }], tracked: true, complete: true, locationQuantities: [0, 0] },
  { productId: "gid://shopify/Product/7001", variantId: "gid://shopify/ProductVariant/7103", inventoryItemId: "gid://shopify/InventoryItem/7203", productName: "Everyday Polo", productType: "Polo", sku: "POL-BLU-M", color: "Blue", size: "M", selectedOptions: [{ name: "Color", value: "Blue" }, { name: "Size", value: "M" }], tracked: true, complete: true, locationQuantities: [0, 0] },
  { productId: "gid://shopify/Product/7001", variantId: "gid://shopify/ProductVariant/7104", inventoryItemId: "gid://shopify/InventoryItem/7204", productName: "Everyday Polo", productType: "Polo", sku: "POL-YEL-L", color: "Yellow", size: "L", selectedOptions: [{ name: "Color", value: "Yellow" }, { name: "Size", value: "L" }], tracked: true, complete: true, locationQuantities: [5, 5] },
  { productId: "gid://shopify/Product/7002", variantId: "gid://shopify/ProductVariant/7105", inventoryItemId: "gid://shopify/InventoryItem/7205", productName: "Classic T-Shirt", productType: "T-Shirt", sku: "DUP-SAMPLE-01", color: "Black", size: "S", selectedOptions: [{ name: "Color", value: "Black" }, { name: "Size", value: "S" }], tracked: true, complete: true, locationQuantities: [2, 2] },
  { productId: "gid://shopify/Product/7002", variantId: "gid://shopify/ProductVariant/7106", inventoryItemId: "gid://shopify/InventoryItem/7206", productName: "Classic T-Shirt", productType: "T-Shirt", sku: "TSH-BLK-M", color: "Black", size: "M", selectedOptions: [{ name: "Color", value: "Black" }, { name: "Size", value: "M" }], tracked: true, complete: true, locationQuantities: [0, 0] },
  { productId: "gid://shopify/Product/7002", variantId: "gid://shopify/ProductVariant/7107", inventoryItemId: "gid://shopify/InventoryItem/7207", productName: "Classic T-Shirt", productType: "T-Shirt", sku: "TSH-WHT-L", color: "White", size: "L", selectedOptions: [{ name: "Color", value: "White" }, { name: "Size", value: "L" }], tracked: true, complete: true, locationQuantities: [7, 8] },
  { productId: "gid://shopify/Product/7001", variantId: "gid://shopify/ProductVariant/7108", inventoryItemId: "gid://shopify/InventoryItem/7208", productName: "Everyday Polo", productType: "Polo", sku: "POL-GRN-XL", color: "Green", size: "XL", selectedOptions: [{ name: "Color", value: "Green" }, { name: "Size", value: "XL" }], tracked: false, complete: true, locationQuantities: null },
  { productId: "gid://shopify/Product/7002", variantId: "gid://shopify/ProductVariant/7109", inventoryItemId: "gid://shopify/InventoryItem/7209", productName: "Classic T-Shirt", productType: "T-Shirt", sku: "TSH-GRY-XS", color: "Gray", size: "XS", selectedOptions: [{ name: "Color", value: "Gray" }, { name: "Size", value: "XS" }], tracked: true, complete: true, locationQuantities: null },
  { productId: "gid://shopify/Product/7001", variantId: "gid://shopify/ProductVariant/7110", inventoryItemId: "gid://shopify/InventoryItem/7210", productName: "Everyday Polo", productType: "Polo", sku: "POL-PUR-XL", color: "Purple", size: "XL", selectedOptions: [{ name: "Color", value: "Purple" }, { name: "Size", value: "XL" }], tracked: true, complete: true, locationQuantities: [-1, 0] },
  { productId: "gid://shopify/Product/7003", variantId: "gid://shopify/ProductVariant/7111", inventoryItemId: "gid://shopify/InventoryItem/7211", productName: "Canvas Tote", productType: "Accessories", sku: "TOTE-CANVAS", color: null, size: null, selectedOptions: [{ name: "Material", value: "Canvas" }], tracked: true, complete: true, locationQuantities: [1, 0] },
  { productId: "gid://shopify/Product/7002", variantId: "gid://shopify/ProductVariant/7112", inventoryItemId: "gid://shopify/InventoryItem/7212", productName: "Classic T-Shirt", productType: "T-Shirt", sku: "TSH-ORG-S", color: "Orange", size: "S", selectedOptions: [{ name: "Color", value: "Orange" }, { name: "Size", value: "S" }], tracked: true, complete: false, locationQuantities: [3] },
];

export function createInventoryAlertsSample(checkedAt = new Date()) {
  const rows: InventoryAlertRow[] = sampleVariants.map(({ locationQuantities, ...variant }) => {
    const availableQuantity = locationQuantities?.reduce((total, quantity) => total + quantity, 0) ?? null;
    return { ...variant, availableQuantity, status: classifyInventoryAlert({
      tracked: variant.tracked, availableQuantity, complete: variant.complete,
    }) };
  });
  return {
    source: "sample" as const,
    readStatus: "ready" as const,
    checkedAt: checkedAt.toISOString(),
    locationScope: "All eligible active locations",
    activeLocationCount: 2,
    catalogComplete: true,
    message: null,
    rows,
  };
}
