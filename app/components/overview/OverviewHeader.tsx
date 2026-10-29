import { Link } from "react-router";
import type { OverviewAnalytics } from "../../utils/overview-analytics.server";
import { dateTimeLabel } from "./format";

type Props = {
  analytics: OverviewAnalytics;
  range: 7 | 30;
  samplePreview: boolean;
  storeName: string;
};

export function OverviewHeader({ analytics, range, samplePreview, storeName }: Props) {
  const rangeHref = (days: 7 | 30) => `?range=${days}${samplePreview ? "&sample=1" : ""}`;
  const updated = analytics.fetchedAt ? new Date(analytics.fetchedAt) : null;

  return <header className="stockhub-overview-header">
    <div className="stockhub-overview-heading">
      <div className="stockhub-overview-eyebrow">StockHub <span aria-hidden="true">/</span> Overview</div>
      <h1>Store Overview</h1>
      <p>Sales performance, products that need attention, and recent import activity.</p>
      <div className="stockhub-current-shop"><span className="stockhub-current-shop-dot" aria-hidden="true" />
        <span><strong>{storeName}</strong>{samplePreview ? <span className="stockhub-overview-sample-badge">SAMPLE · USD</span> : null}</span>
      </div>
      {samplePreview ? <p className="stockhub-overview-sample-notice" role="status">
        SAMPLE DATA · Sales, inventory, products, and import statuses below are synthetic fixtures. No Shopify or import-history data is requested for this preview.
      </p> : null}
    </div>

    <div className="stockhub-overview-header-tools">
      <div className="stockhub-overview-range" role="group" aria-label="Analytics date range">
        <Link to={rangeHref(7)} aria-current={range === 7 ? "page" : undefined}>7 days</Link>
        <Link to={rangeHref(30)} aria-current={range === 30 ? "page" : undefined}>30 days</Link>
      </div>
      <Link className="stockhub-overview-demo-toggle" to={samplePreview ? `?range=${range}` : `?range=${range}&sample=1`}>
        {samplePreview ? "Exit sample preview" : "Preview sample data"}
      </Link>
      <div className="stockhub-overview-refresh">
        <span>{updated ? <><span>{samplePreview ? "Preview data" : "Updated"} </span><time dateTime={updated.toISOString()}>{dateTimeLabel(updated)}</time></> : "Analytics not refreshed"}</span>
        <Link to={rangeHref(range)} reloadDocument>Refresh</Link>
      </div>
    </div>
  </header>;
}
