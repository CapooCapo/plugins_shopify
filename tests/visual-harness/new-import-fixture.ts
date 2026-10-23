export const newImportFixture = {
  shop: "Example Outfitters",
  shopDomain: "example-outfitters.myshopify.com",
  submissionId: "fixture-sub-12345",
  locations: [
    { id: "gid://shopify/Location/101", name: "Main warehouse" },
    { id: "gid://shopify/Location/102", name: "East branch" },
  ],
  locationStatus: "ready" as const,
  locationMessage: null,
  missingLocationScopes: [],
  authorizationStatus: "verified" as const,
  authorizationMessage: null,
  installedScopes: ["read_products", "write_products", "read_locations", "read_inventory", "write_inventory"],
  missingReadScopes: [],
  missingWriteScopes: [],
  maxMergeLines: 50,
  duplicateCsv: false,
};
