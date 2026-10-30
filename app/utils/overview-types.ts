import type { OverviewAnalytics } from "./overview-analytics.server";

export type ProductCount = { count: number; precision: "EXACT" | "AT_LEAST" };

export type OverviewData = {
  shop: { name: string; myshopifyDomain: string; ianaTimezone?: string; currencyCode?: string };
  all: ProductCount;
  active: ProductCount;
  draft: ProductCount;
};

export type RecentImport = {
  id: string;
  label: string;
  kind: "inventory" | "catalog";
  locationName: string | null;
  createdAt: Date;
  updatedAt: Date;
  status: string;
  detailHref: string | null;
};

export type ImportOverview = {
  recent: RecentImport[];
  sample: boolean;
};

export type OverviewLoaderData = {
  data: OverviewData | null;
  error: string | null;
  imports: ImportOverview | null;
  analytics: OverviewAnalytics;
  samplePreview: boolean;
};
