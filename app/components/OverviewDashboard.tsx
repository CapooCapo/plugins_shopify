import { Link } from "react-router";
import type { ImportOverview, OverviewData, ProductCount } from "../routes/app._index";
import { formatStockhubDateTime } from "../utils/stockhub-format.js";

type Props = {
  data: OverviewData | null;
  error: string | null;
  imports: ImportOverview | null;
  loading?: boolean;
};

function count(value: ProductCount) {
  return value.precision === "EXACT" ? String(value.count) : `At least ${value.count}`;
}

function productBreakdown(data: OverviewData) {
  const other = data.all.count - data.active.count - data.draft.count;
  const exact = [data.all, data.active, data.draft].every((item) => item.precision === "EXACT");
  return (
    <div className="stockhub-overview-breakdown" aria-label="Product status breakdown">
      <span><strong>{count(data.active)}</strong> active</span>
      <span><strong>{count(data.draft)}</strong> draft</span>
      {exact && other > 0 ? <span><strong>{other}</strong> other status</span> : null}
    </div>
  );
}

function statusLabel(status: string) {
  return status === "COMPLETED" ? "Completed" : status === "PARTIAL" ? "Partially completed"
    : status === "UNCERTAIN" ? "Outcome uncertain" : status === "FAILED" ? "Failed"
      : status === "BLOCKED" ? "Blocked" : status === "RUNNING" ? "In progress"
        : status === "PROCESSING" ? "Processing" : status === "PREVIEWED" ? "Previewed" : status;
}

function statusClass(status: string) {
  if (status === "COMPLETED") return "stockhub-status--success";
  if (status === "FAILED" || status === "BLOCKED") return "stockhub-status--error";
  if (status === "PARTIAL" || status === "UNCERTAIN") return "stockhub-status--warning";
  return "stockhub-status--info";
}

export function OverviewDashboard({ data, error, imports, loading = false }: Props) {
  if (loading) {
    return <div className="stockhub-page stockhub-overview" role="status" aria-live="polite">
      <div className="stockhub-route-pending"><s-spinner size="base" accessibilityLabel="Loading store overview" /> Loading overview…</div>
    </div>;
  }

  return <main className="stockhub-page stockhub-overview">
    <header className="stockhub-overview-header">
      <div className="stockhub-overview-heading">
        <div className="stockhub-overview-eyebrow">StockHub dashboard</div>
        <h1>Overview</h1>
        <p>Products and import activity for your current Shopify store.</p>
        {data ? <div className="stockhub-current-shop"><span className="stockhub-current-shop-dot" />
          <span><strong>{data.shop.name}</strong> <span className="stockhub-shop-domain">{data.shop.myshopifyDomain}</span></span>
        </div> : null}
      </div>
      <div className="stockhub-overview-header-action"><s-button href="/app/imports" variant="primary">New import</s-button></div>
    </header>

    {error ? <s-banner tone="critical">{error}</s-banner> : null}

    <section className="stockhub-overview-section" aria-labelledby="overview-glance-title">
      <div className="stockhub-overview-section-heading">
        <h2 id="overview-glance-title">At a glance</h2>
        <span>Live shop and receipt data</span>
      </div>
      <div className="stockhub-overview-metrics">
        <article className="stockhub-overview-metric stockhub-overview-metric--products">
          <span className="stockhub-metric-label">Products</span>
          <strong className="stockhub-metric-value">{data ? count(data.all) : "—"}</strong>
          {data ? productBreakdown(data) : <span className="stockhub-metric-note">Shopify data unavailable</span>}
        </article>
        <article className="stockhub-overview-metric stockhub-overview-metric--imports">
          <span className="stockhub-metric-label">Import batches</span>
          <strong className="stockhub-metric-value">{imports ? imports.batchCount : "—"}</strong>
          <span className="stockhub-metric-note">Recorded for this shop</span>
        </article>
        <article className="stockhub-overview-metric stockhub-overview-metric--attention">
          <span className="stockhub-metric-label">Needs attention</span>
          <strong className="stockhub-metric-value">{imports ? imports.attentionBatchCount : "—"}</strong>
          <span className="stockhub-metric-note">Failed or uncertain imports</span>
        </article>
      </div>
    </section>

    <nav className="stockhub-overview-shortcuts" aria-label="Overview quick actions">
      <span>Quick access</span>
      <Link to="/app/products">Browse products <span aria-hidden="true">↗</span></Link>
      <Link to="/app/imports/history">Import history <span aria-hidden="true">↗</span></Link>
      <Link to="/app/stores">Store details <span aria-hidden="true">↗</span></Link>
    </nav>

    <section className="stockhub-overview-section stockhub-overview-recent" aria-labelledby="overview-recent-title">
      <div className="stockhub-overview-section-heading">
        <div><h2 id="overview-recent-title">Recent imports</h2><p>Your five latest receipts</p></div>
        <Link to="/app/imports/history">View all history <span aria-hidden="true">→</span></Link>
      </div>
      {!imports ? <p className="stockhub-overview-message">Import activity is currently unavailable. Recent imports could not be loaded.</p>
        : imports.recent.length ? <div className="stockhub-overview-table-wrap">
          <table className="stockhub-overview-table">
            <thead><tr><th scope="col">Receipt</th><th scope="col">Location</th><th scope="col">Created</th><th scope="col">Status</th></tr></thead>
            <tbody>{imports.recent.map((batch) => <tr key={batch.id}>
              <td data-label="Receipt"><Link to={`/app/imports/history/${encodeURIComponent(batch.id)}`}>{batch.receiptCode.trim() || "Receipt unavailable"}</Link></td>
              <td data-label="Location">{batch.locationName}</td>
              <td data-label="Created">{formatStockhubDateTime(batch.createdAt)}</td>
              <td data-label="Status"><span className={`stockhub-status ${statusClass(batch.status)}`}>{statusLabel(batch.status)}</span></td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="stockhub-overview-message">No import batches have been recorded for this store.</p>}
    </section>
  </main>;
}
