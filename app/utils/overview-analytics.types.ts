export type SalesOrderLine = {
  id?: string | null;
  currentQuantity?: number | null;
  priceAfterAllDiscountsBeforeTaxesSet?: {
    shopMoney?: { amount?: string | number | null; currencyCode?: string | null } | null;
  } | null;
  product?: {
    id?: string | null;
    title?: string | null;
    legacyResourceId?: string | number | null;
    featuredImage?: { url?: string | null } | null;
  } | null;
  variant?: {
    id?: string | null;
    title?: string | null;
    sku?: string | null;
    legacyResourceId?: string | number | null;
  } | null;
};

export type SalesOrder = {
  id?: string | null;
  createdAt?: string | null;
  cancelledAt?: string | null;
  /** Shopify's test flag is required to distinguish development transactions from sales. */
  test?: boolean | null;
  lineItems?: SalesOrderLine[] | { nodes?: SalesOrderLine[]; pageInfo?: { hasNextPage?: boolean } } | null;
};

export type SalesAggregationOptions = {
  currencyCode: string;
  timeZone: string;
  dates: string[];
  /** True when the API adapter could not retrieve all pages. */
  partial?: boolean;
  /** Include product/variant display identity for Restock Planner rows. */
  includeVariantDetails?: boolean;
};

export type SalesRankingProduct = {
  id: string;
  title: string;
  legacyResourceId?: string;
  imageUrl?: string;
  units: number;
  revenue: number | null;
};

export type SalesRankingVariant = {
  id: string;
  productId: string;
  productTitle: string;
  legacyResourceId?: string;
  title: string;
  sku?: string;
  units: number;
  revenue: number | null;
};

export type SalesVariantDemand = {
  id: string;
  units: number;
  productId?: string;
  productTitle?: string;
  title?: string;
  sku?: string;
};

export type SalesAggregation = {
  status: "ready" | "partial" | "unavailable";
  reason?: string;
  /** Whether per-variant current-quantity demand was completely observed. */
  demandComplete: boolean;
  currencyCode: string | null;
  totals: { revenue: number | null; orders: number; units: number };
  daily: Array<{ date: string; revenue: number | null; orders: number; units: number }>;
  topProducts: SalesRankingProduct[];
  topVariants: SalesRankingVariant[];
  /** Net units for every sold variant, independent of the display top-five ranking. */
  variantDemand: SalesVariantDemand[];
  currencyMismatch: boolean;
};

export type InventoryVariantInput = {
  id: string;
  title: string;
  selectedOptions?: Array<{ name: string; value: string }>;
  inventoryItemId?: string | null;
  createdAt?: string | null;
  sku?: string | null;
  product: {
    id: string;
    title: string;
    productType?: string | null;
    legacyResourceId?: string | number | null;
    imageUrl?: string | null;
    giftCard?: boolean;
  };
  tracked: boolean | null;
  levels: Array<{ isActive: boolean; available: number | null }>;
  /** False when a location-level page could not be completed. */
  levelsComplete?: boolean;
};

export type InventoryAggregationOptions = {
  lowStockThreshold?: number;
  partial?: boolean;
};

export type InventoryVariantSummary = {
  id: string;
  title: string;
  sku: string | null;
  product: { id: string; title: string; legacyResourceId?: string; imageUrl?: string };
  available: number;
  variantCount?: number;
};

export type RestockInventoryVariant = {
  id: string;
  title: string;
  selectedOptions?: Array<{ name: string; value: string }>;
  inventoryItemId?: string | null;
  sku: string | null;
  createdAt: string | null;
  productType?: string | null;
  product: { id: string; title: string; legacyResourceId?: string; imageUrl?: string };
  tracked?: boolean | null;
  complete?: boolean;
  inventoryStatus: "known" | "unknown" | "untracked" | "non_physical";
  available: number | null;
};

export type InventoryAggregation = {
  status: "ready" | "partial" | "unavailable";
  reason?: string;
  threshold: number;
  lowStockSkuCount: number;
  outOfStockSkuCount: number;
  lowStockVariants: InventoryVariantSummary[];
  outOfStockVariants: InventoryVariantSummary[];
  unknownCount: number;
  untrackedCount: number;
  nonPhysicalCount: number;
  totalTrackedKnown: number;
  /** Present only when requested by the Restock Planner; Overview stays aggregate-only. */
  restockVariants?: RestockInventoryVariant[];
  /** False means Shopify's variant pagination did not cover the full catalog. */
  catalogComplete?: boolean;
};
