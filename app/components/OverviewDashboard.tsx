import type { OverviewAnalytics } from "../utils/overview-analytics.server";
import type { ImportOverview, OverviewData } from "../utils/overview-types";
import { BestSellers } from "./overview/BestSellers";
import { InventoryAttention } from "./overview/InventoryAttention";
import { OverviewHeader } from "./overview/OverviewHeader";
import { OverviewMetrics } from "./overview/OverviewMetrics";
import { RecentImports } from "./overview/RecentImports";
import { SalesPerformance } from "./overview/SalesPerformance";

type Props = {
  data: OverviewData | null;
  storeName: string;
  error: string | null;
  imports: ImportOverview | null;
  analytics: OverviewAnalytics;
  samplePreview: boolean;
  loading?: boolean;
};

export function OverviewDashboard({ data, storeName, error, imports, analytics, samplePreview, loading = false }: Props) {
  if (loading) return <div className="stockhub-page stockhub-overview" role="status" aria-live="polite">
    <div className="stockhub-route-pending"><s-spinner size="base" accessibilityLabel="Loading store overview" /> Loading overview…</div>
  </div>;

  const currencyCode = samplePreview ? "USD" : analytics.sales.data?.currencyCode ?? analytics.currencyCode;
  return <main className={`stockhub-page stockhub-overview${samplePreview ? " stockhub-overview--sample" : ""}`}>
    <OverviewHeader analytics={analytics} range={analytics.range} samplePreview={samplePreview} storeName={storeName} />
    {error ? <s-banner tone="critical">{error}</s-banner> : null}
    <OverviewMetrics analytics={analytics} samplePreview={samplePreview} />
    <div className="stockhub-overview-analysis-grid">
      <SalesPerformance analytics={analytics} currencyCode={currencyCode} samplePreview={samplePreview} />
      <BestSellers analytics={analytics} shopDomain={data?.shop.myshopifyDomain} currencyCode={currencyCode} />
    </div>
    <InventoryAttention analytics={analytics} />
    <RecentImports imports={imports} />
  </main>;
}
