export type RestockPeriod = 28 | 56;

export type PlanningSettings = {
  leadTimeDays: number | null;
  coverageDays: number | null;
  safetyBufferDays: number | null;
};

export type RestockRowInput = {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  createdAt: string | null;
  unitsSold: number | null;
  available: number | null;
  inventoryStatus: "known" | "unknown" | "untracked" | "non_physical";
};

export type RestockStatus = "calculated" | "settings_required" | "needs_review" | "excluded";
export type RestockPriority = "urgent" | "high" | "normal" | "review" | "excluded";

export type RestockRecommendation = RestockRowInput & {
  averageDailyUnits: number | null;
  coverageDays: number | null;
  targetUnits: number | null;
  suggestedQuantity: number | null;
  status: RestockStatus;
  priority: RestockPriority;
  qualityIssues: string[];
  explanation: string;
};

export type RestockData = {
  mode: "demo" | "live";
  shop: string;
  timeZone: string | null;
  currencyCode: string | null;
  generatedAt: string;
  period: RestockPeriod;
  periodStartDate: string | null;
  periodStartUtc: string | null;
  analysisDays: number;
  salesStatus: "ready" | "partial" | "permission_required" | "unavailable" | "unverified";
  salesDemandComplete: boolean;
  salesMessage: string | null;
  inventoryStatus: "ready" | "partial" | "permission_required" | "unavailable" | "unverified";
  inventoryMessage: string | null;
  inventoryCatalogComplete: boolean;
  rows: RestockRowInput[];
};

export type MerchantReview = {
  selected: boolean;
  adjustedQuantity: number | null;
  note: string;
};
