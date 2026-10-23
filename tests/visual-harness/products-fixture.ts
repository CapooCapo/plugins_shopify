function image(color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" rx="8" fill="#f2f6ff"/><rect x="12" y="8" width="24" height="32" rx="4" fill="${color}"/><path d="M16 13h16M16 34h16" stroke="white" stroke-opacity=".6" stroke-width="2"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function product(index: number, title: string, status: string, sku: string, amount: string, inventory: number | null) {
  return {
    id: `gid://shopify/Product/${1000 + index}`,
    title,
    status,
    featuredImage: { url: image(["#0a369d", "#4472ca", "#5e7ce2", "#946200", "#16794e"][index % 5]), altText: title },
    totalInventory: inventory,
    priceRangeV2: {
      minVariantPrice: { amount, currencyCode: "USD" },
      maxVariantPrice: { amount, currencyCode: "USD" },
    },
    variants: {
      edges: [{ node: { id: `gid://shopify/ProductVariant/${2000 + index}`, title: "Default Title", sku, price: amount, inventoryQuantity: inventory } }],
      pageInfo: { hasNextPage: false },
    },
  };
}

export const products = [
  product(1, "Inventory Not Tracked Snowboard", "ACTIVE", "SNOW-NOTRACK", "149.00", null),
  product(2, "Minimal Snowboard", "ACTIVE", "SNOW-MIN", "299.00", 28),
  product(3, "Collection Snowboard: Hydrogen", "ACTIVE", "SNOW-HYD", "499.00", 11),
  product(4, "Complete Snowboard", "ACTIVE", "SNOW-COMPLETE", "599.00", 7),
  product(5, "Hidden Snowboard", "DRAFT", "SNOW-HIDDEN", "259.00", 0),
  product(6, "Compare-at Price Snowboard", "DRAFT", "SNOW-COMPARE", "349.00", 6),
  product(7, "Archived Snowboard", "ARCHIVED", "SNOW-OLD", "199.00", 4),
  product(8, "Long-form technical product name for the regional winter catalog", "ACTIVE", "SNOW-LONG", "389.00", 12),
];

export const matchedSkuProduct = {
  ...product(9, "Dual Variant Snowboard", "ACTIVE", "MATCH-204", "429.00", 13),
  variants: {
    edges: [{ node: { id: "gid://shopify/ProductVariant/2009", title: "Blue / Medium", sku: "MATCH-204", price: "429.00", inventoryQuantity: 4 } }],
    pageInfo: { hasNextPage: false },
  },
};

export const pageInfo = {
  hasNextPage: true,
  hasPreviousPage: true,
  startCursor: "fixture-start",
  endCursor: "fixture-end",
};
