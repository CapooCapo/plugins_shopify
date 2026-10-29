import { missingScopesForGrant, queryGrantedScopes, type ShopifyScopesApi } from "./shopify-scopes.server";
import { readInventoryVariants } from "./overview-analytics-inventory.server";
import type { AdminGraphQL } from "./overview-analytics-graphql.server";
import { classifyInventoryAlert, extractInventoryAlertColorAndSize, type InventoryAlertRow } from "./inventory-alerts.shared";
import type { RestockInventoryVariant } from "./overview-analytics.types";

const REQUIRED_SCOPES = ["read_products", "read_inventory", "read_locations"] as const;
export const INVENTORY_ALERTS_LOCATION_SCOPE = "All eligible active locations";
export type InventoryAlertsData = {
  source: "live" | "sample";
  readStatus: "ready" | "partial" | "permission_required" | "unavailable" | "unverified";
  checkedAt: string | null;
  locationScope: string;
  activeLocationCount?: number;
  catalogComplete: boolean;
  message: string | null;
  rows: InventoryAlertRow[];
};

function emptyData(input: { readStatus: InventoryAlertsData["readStatus"]; catalogComplete?: boolean; message: string }): InventoryAlertsData {
  return {
    source: "live", readStatus: input.readStatus, checkedAt: null,
    locationScope: INVENTORY_ALERTS_LOCATION_SCOPE, catalogComplete: input.catalogComplete ?? false,
    message: input.message, rows: [],
  };
}

export function inventoryAlertRowFromVariant(variant: RestockInventoryVariant): InventoryAlertRow {
  const selectedOptions = variant.selectedOptions ?? [];
  const itemIdentityPresent = Boolean(variant.inventoryItemId);
  const availableQuantity = itemIdentityPresent && variant.inventoryStatus === "known" ? variant.available : null;
  const tracked = itemIdentityPresent ? variant.tracked ?? null : null;
  const complete = itemIdentityPresent && variant.complete === true;
  const { color, size } = extractInventoryAlertColorAndSize(selectedOptions);
  return {
    productId: variant.product.id,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItemId ?? null,
    productName: variant.product.title,
    productType: variant.productType ?? null,
    sku: variant.sku,
    color,
    size,
    selectedOptions,
    availableQuantity,
    status: classifyInventoryAlert({ tracked, availableQuantity, complete }),
    tracked,
    complete,
  };
}

export async function loadInventoryAlertsData(input: {
  admin: AdminGraphQL;
  scopes: ShopifyScopesApi;
  shop: string;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<InventoryAlertsData> {
  let granted: string[];
  try {
    granted = await queryGrantedScopes(input.scopes);
  } catch {
    return emptyData({ readStatus: "unverified",
      message: "Shopify's current access grant could not be verified. No inventory query was sent." });
  }
  const missing = missingScopesForGrant(granted, REQUIRED_SCOPES);
  if (missing.length) {
    return emptyData({ readStatus: "permission_required",
      message: `Live Inventory Alerts require ${missing.join(", ")}. No inventory query was sent.` });
  }

  try {
    const inventory = await readInventoryVariants(input.admin, input.signal, { includeRestockVariants: true });
    const rows = (inventory.restockVariants ?? [])
      .filter((variant) => variant.inventoryStatus !== "non_physical")
      .map(inventoryAlertRowFromVariant);
    const catalogComplete = inventory.catalogComplete !== false;
    const readStatus = inventory.status === "partial" || !catalogComplete ? "partial" : "ready";
    return {
      source: "live", readStatus, checkedAt: (input.now ?? (() => new Date()))().toISOString(),
      locationScope: INVENTORY_ALERTS_LOCATION_SCOPE, catalogComplete,
      message: inventory.reason ?? (catalogComplete ? null : "The inventory catalog was not fully read; displayed variants are only those Shopify returned."),
      rows,
    };
  } catch {
    return emptyData({ readStatus: "unavailable",
      message: "Live inventory could not be loaded. Retry after checking Shopify access." });
  }
}
