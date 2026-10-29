import { missingScopesForGrant, queryGrantedScopes, type ShopifyScopesApi } from "../shopify-scopes.server";
import { computeCompleteShopLocalDateWindow } from "../overview-analytics-dates.shared";
import { queryData, type AdminGraphQL } from "../overview-analytics-graphql.server";
import { readInventoryVariants } from "../overview-analytics-inventory.server";
import { readSalesOrders } from "../overview-analytics-sales.server";
import type { InventoryAggregation, RestockInventoryVariant, SalesAggregation, SalesVariantDemand } from "../overview-analytics.types";
import type { RestockData, RestockPeriod, RestockRowInput } from "./restock.types";

const SALES_SCOPES = ["read_orders", "read_products"] as const;
const INVENTORY_SCOPES = ["read_products", "read_inventory"] as const;

export const RESTOCK_SHOP_QUERY = `#graphql
  query StockHubRestockShop {
    shop { name ianaTimezone currencyCode }
  }
`;

type ShopResponse = { shop?: { name?: string; ianaTimezone?: string; currencyCode?: string } | null };
type ReaderDependencies = {
  readSales: typeof readSalesOrders;
  readInventory: typeof readInventoryVariants;
  readShop: (admin: AdminGraphQL) => Promise<ShopResponse>;
};

const defaultDependencies: ReaderDependencies = {
  readSales: readSalesOrders,
  readInventory: readInventoryVariants,
  readShop: (admin) => queryData<ShopResponse>(admin, RESTOCK_SHOP_QUERY, {}),
};

function emptyData(input: { shop: string; period: RestockPeriod; generatedAt: Date }): RestockData {
  return {
    mode: "live", shop: input.shop, timeZone: null, currencyCode: null,
    generatedAt: input.generatedAt.toISOString(), period: input.period,
    periodStartDate: null, periodStartUtc: null, analysisDays: input.period,
    salesStatus: "unverified", salesMessage: "Shopify's current access grant could not be verified. No sales or inventory request was sent.",
    salesDemandComplete: false,
    inventoryStatus: "unverified", inventoryMessage: "Shopify's current access grant could not be verified. No sales or inventory request was sent.",
    inventoryCatalogComplete: false, rows: [],
  };
}

function rowFromInventory(variant: RestockInventoryVariant, unitsSold: number | null): RestockRowInput {
  return {
    variantId: variant.id, productId: variant.product.id,
    productTitle: variant.product.title, variantTitle: variant.title,
    sku: variant.sku, createdAt: variant.createdAt, unitsSold,
    available: variant.available, inventoryStatus: variant.inventoryStatus,
  };
}

function rowFromSales(variant: SalesVariantDemand): RestockRowInput {
  return {
    variantId: variant.id, productId: variant.productId ?? variant.id,
    productTitle: variant.productTitle ?? "Product not in current inventory catalog",
    variantTitle: variant.title ?? "Variant",
    sku: variant.sku ?? null, createdAt: null, unitsSold: variant.units,
    available: null, inventoryStatus: "unknown",
  };
}

export async function loadRestockData(input: {
  admin: AdminGraphQL;
  scopes: ShopifyScopesApi;
  shop: string;
  period: RestockPeriod;
  signal?: AbortSignal;
  now?: () => Date;
}, dependencies: ReaderDependencies = defaultDependencies): Promise<RestockData> {
  const requestedAt = (input.now ?? (() => new Date()))();
  let granted: string[];
  try {
    granted = await queryGrantedScopes(input.scopes);
  } catch {
    return emptyData({ shop: input.shop, period: input.period, generatedAt: requestedAt });
  }

  const missingSalesScopes = missingScopesForGrant(granted, SALES_SCOPES);
  const missingInventoryScopes = missingScopesForGrant(granted, INVENTORY_SCOPES);
  let shop: ShopResponse["shop"] = null;
  try {
    shop = (await dependencies.readShop(input.admin)).shop ?? null;
  } catch {
    shop = null;
  }
  const timeZone = typeof shop?.ianaTimezone === "string" ? shop.ianaTimezone : null;
  const currencyCode = typeof shop?.currencyCode === "string" ? shop.currencyCode : null;
  const shopName = typeof shop?.name === "string" && shop.name ? shop.name : input.shop;
  let window: ReturnType<typeof computeCompleteShopLocalDateWindow> | null = null;
  if (timeZone) {
    try { window = computeCompleteShopLocalDateWindow(requestedAt, input.period, timeZone); } catch { window = null; }
  }

  let sales: SalesAggregation | null = null;
  let salesStatus: RestockData["salesStatus"] = "unavailable";
  let salesMessage: string | null = null;
  if (missingSalesScopes.length) {
    salesStatus = "permission_required";
    salesMessage = `Live sales require ${missingSalesScopes.join(", ")}. Sample data remains available; no order query was sent.`;
  } else if (!timeZone || !currencyCode || !window) {
    salesMessage = "Shop timezone or currency is unavailable, so live sales cannot be safely assigned to complete shop-local days.";
  } else {
    try {
      sales = await dependencies.readSales(input.admin, window, timeZone, currencyCode, input.signal, { includeVariantDetails: true });
      salesStatus = sales.status;
      salesMessage = sales.reason ?? null;
    } catch {
      salesMessage = "Live sales could not be loaded. Inventory remains available; retry after checking Shopify access.";
    }
  }

  let inventory: InventoryAggregation | null = null;
  let inventoryStatus: RestockData["inventoryStatus"] = "unavailable";
  let inventoryMessage: string | null = null;
  if (missingInventoryScopes.length) {
    inventoryStatus = "permission_required";
    inventoryMessage = `Live inventory requires ${missingInventoryScopes.join(", ")}. No inventory query was sent.`;
  } else {
    try {
      inventory = await dependencies.readInventory(input.admin, input.signal, { includeRestockVariants: true });
      inventoryStatus = inventory.status;
      inventoryMessage = inventory.reason ?? null;
    } catch {
      inventoryMessage = "Live inventory could not be loaded. Retry after checking Shopify access.";
    }
  }

  const salesByVariant = new Map((sales?.variantDemand ?? []).map((row) => [row.id, row]));
  const rows = new Map<string, RestockRowInput>();
  for (const variant of inventory?.restockVariants ?? []) {
    const demand = salesByVariant.get(variant.id);
    const unitsSold = sales ? demand?.units ?? (sales.demandComplete ? 0 : null) : null;
    rows.set(variant.id, rowFromInventory(variant, unitsSold));
  }
  for (const demand of sales?.variantDemand ?? []) {
    if (!rows.has(demand.id)) rows.set(demand.id, rowFromSales(demand));
  }

  return {
    mode: "live", shop: shopName, timeZone, currencyCode,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(), period: input.period,
    periodStartDate: window?.dates[0] ?? null,
    periodStartUtc: window?.startUtc ?? null,
    analysisDays: input.period,
    salesStatus, salesMessage, salesDemandComplete: sales?.demandComplete === true,
    inventoryStatus, inventoryMessage,
    inventoryCatalogComplete: inventory ? inventory.catalogComplete !== false : false,
    rows: [...rows.values()],
  };
}
