import { Link } from "react-router";
import { useState } from "react";
import type { ImportOverview, OverviewData, ProductCount } from "../routes/app._index";
import type { OverviewAnalytics } from "../utils/overview-analytics.server";
import { formatStockhubDateTime, formatStockhubMoney } from "../utils/stockhub-format.js";

type Props = {
  data: OverviewData | null;
  error: string | null;
  imports: ImportOverview | null;
  analytics?: OverviewAnalytics;
  loading?: boolean;
};

type TrendMeasure = "revenue" | "units" | "orders";

function count(value: ProductCount) {
  return value.precision === "EXACT" ? String(value.count) : `At least ${value.count}`;
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

const analyticsUnavailable: OverviewAnalytics = {
  range: 30,
  timeZone: null,
  currencyCode: null,
  scopesVerified: false,
  salesMissingScopes: [],
  inventoryMissingScopes: [],
  sales: { status: "unverified", data: null, message: "Current Shopify analytics access has not been verified.", fetchedAt: null },
  inventory: { status: "unverified", data: null, message: "Current Shopify inventory access has not been verified.", fetchedAt: null },
  fetchedAt: null,
};

function numberLabel(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function inventorySkuCountLabel(value: number, partial: boolean) {
  return `${partial ? "Observed " : ""}${numberLabel(value)}`;
}

function currencyLabel(value: number | null, currencyCode: string | null) {
  if (value === null || !currencyCode) return "Unavailable";
  return formatStockhubMoney(value, currencyCode);
}

function dateLabel(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(value);
}

function productAdminUrl(domain: string | undefined, resourceId: string | undefined, productId?: string) {
  if (!domain) return undefined;
  const id = resourceId ?? productId?.match(/\/Product\/(\d+)$/)?.[1];
  return id ? `https://${domain}/admin/products/${encodeURIComponent(id)}` : undefined;
}

function AnalyticsNotice({ status, message }: { status: string; message?: string }) {
  if (status === "ready") return null;
  const tone = status === "unavailable" ? "stockhub-analytics-notice--error"
    : status === "partial" ? "stockhub-analytics-notice--partial" : "stockhub-analytics-notice--info";
  return <p className={`stockhub-analytics-notice ${tone}`} role={status === "unavailable" ? "alert" : "status"}>
    {message ?? (status === "partial" ? "Some results could not be fully verified." : "This dataset is not available yet.")}
  </p>;
}

function SalesTrend({ analytics, range, currencyCode }: { analytics: OverviewAnalytics; range: 7 | 30; currencyCode: string | null }) {
  const [measure, setMeasure] = useState<TrendMeasure>("revenue");
  const daily = analytics.sales.data?.daily ?? [];
  const canChart = analytics.sales.data !== null;
  const values = daily.map((day) => measure === "revenue" ? day.revenue : measure === "units" ? day.units : day.orders);
  const maxValue = Math.max(0, ...values.filter((value): value is number => value !== null));
  const title = measure === "revenue" ? "Net merchandise sales" : measure === "units" ? "Net units sold" : "Orders";
  const valueLabel = (value: number | null) => measure === "revenue" ? currencyLabel(value, currencyCode) : value === null ? "Unavailable" : numberLabel(value);
  const labelStep = range === 7 ? 1 : 5;

  return <section className="stockhub-overview-panel stockhub-overview-trend" aria-labelledby="overview-trend-title">
    <div className="stockhub-overview-section-heading stockhub-overview-analytics-heading">
      <div><h2 id="overview-trend-title">Sales trend</h2><p>Daily totals in the selected shop-local date range</p></div>
      <div className="stockhub-chart-switch" role="group" aria-label="Sales trend measure">
        {(["revenue", "orders", "units"] as const).map((option) => <button key={option} type="button" aria-pressed={measure === option} onClick={() => setMeasure(option)}>
          {option === "revenue" ? "Revenue" : option === "orders" ? "Orders" : "Units sold"}
        </button>)}
      </div>
    </div>
    <AnalyticsNotice status={analytics.sales.status} message={analytics.sales.message} />
    {!canChart ? <div className="stockhub-analytics-empty">Sales trend is unavailable until the current Shopify access and order data can be verified.</div>
      : analytics.sales.data?.totals.orders === 0 && analytics.sales.status === "ready" ? <div className="stockhub-analytics-empty">No non-cancelled, non-test orders were created in the last {range} days.</div>
        : <>
          <div className="stockhub-chart-measure-label">{title}{measure === "revenue" ? ` · ${currencyCode ?? "shop currency"} · after discounts and returns, before tax` : ""}</div>
          <div className="stockhub-chart-plot" role="group" aria-label={`${title}, ${range} days`}>
            {daily.map((day, index) => {
              const value = values[index];
              const height = value === null || maxValue <= 0 ? 0 : Math.max(3, (value / maxValue) * 100);
              const showLabel = index % labelStep === 0 || index === daily.length - 1;
              return <div className="stockhub-chart-day" key={day.date}>
                <button className="stockhub-chart-bar-track" type="button" aria-label={`${dateLabel(day.date)}: ${valueLabel(value)}`} title={`${dateLabel(day.date)}: ${valueLabel(value)}`} disabled={value === null}>
                  <span className={`stockhub-chart-bar ${measure === "revenue" ? "stockhub-chart-bar--revenue" : measure === "orders" ? "stockhub-chart-bar--orders" : "stockhub-chart-bar--units"}`} style={{ height: `${height}%` }} />
                </button>
                <time dateTime={day.date} className="stockhub-chart-date">{showLabel ? dateLabel(day.date) : ""}</time>
              </div>;
            })}
          </div>
        </>}
  </section>;
}

export function OverviewDashboard({ data, error, imports, analytics: loadedAnalytics, loading = false }: Props) {
  const analytics = loadedAnalytics ?? analyticsUnavailable;
  const sales = analytics.sales.data;
  const inventory = analytics.inventory.data;
  const range = analytics.range;

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
        <p>Sales, inventory health and import activity for your current Shopify store.</p>
        {data ? <div className="stockhub-current-shop"><span className="stockhub-current-shop-dot" />
          <span><strong>{data.shop.name}</strong> <span className="stockhub-shop-domain">{data.shop.myshopifyDomain}</span></span>
        </div> : null}
      </div>
      <div className="stockhub-overview-header-tools">
        <div className="stockhub-overview-range" role="group" aria-label="Analytics date range">
          <Link to="?range=7" aria-current={range === 7 ? "page" : undefined}>7 days</Link>
          <Link to="?range=30" aria-current={range === 30 ? "page" : undefined}>30 days</Link>
        </div>
        <div className="stockhub-overview-refresh">
          <span>{analytics.fetchedAt ? `Data as of ${formatStockhubDateTime(analytics.fetchedAt)}` : "Analytics not refreshed"}</span>
          <Link to={`?range=${range}`} reloadDocument>Refresh</Link>
        </div>
        <s-button href="/app/imports" variant="primary">New import</s-button>
      </div>
    </header>

    {error ? <s-banner tone="critical">{error}</s-banner> : null}

    <section className="stockhub-overview-section stockhub-overview-analytics" aria-labelledby="overview-analytics-title">
      <div className="stockhub-overview-section-heading stockhub-overview-section-heading--analytics">
        <div><h2 id="overview-analytics-title">Business analytics</h2><p>Verified Shopify data for the last {range} shop-local calendar days.</p></div>
        <span className="stockhub-overview-currency">{analytics.timeZone ?? "Shop time zone unavailable"}{analytics.currencyCode ? ` · ${analytics.currencyCode}` : ""}</span>
      </div>

      <div className="stockhub-overview-metrics stockhub-overview-sales-metrics">
        <article className="stockhub-overview-metric stockhub-overview-metric--revenue">
          <span className="stockhub-metric-label">Net merchandise sales</span>
          <strong className="stockhub-metric-value">{sales ? currencyLabel(sales.totals.revenue, analytics.currencyCode) : "—"}</strong>
          <span className="stockhub-metric-note">After discounts and returns · before tax</span>
        </article>
        <article className="stockhub-overview-metric stockhub-overview-metric--orders">
          <span className="stockhub-metric-label">Orders</span>
          <strong className="stockhub-metric-value">{sales ? numberLabel(sales.totals.orders) : "—"}</strong>
          <span className="stockhub-metric-note">Non-cancelled, non-test orders</span>
        </article>
        <article className="stockhub-overview-metric stockhub-overview-metric--units">
          <span className="stockhub-metric-label">Units sold</span>
          <strong className="stockhub-metric-value">{sales ? numberLabel(sales.totals.units) : "—"}</strong>
          <span className="stockhub-metric-note">Net units after returns</span>
        </article>
        <article className="stockhub-overview-metric stockhub-overview-metric--low-stock">
          <span className="stockhub-metric-label">Low-stock SKUs</span>
          <strong className="stockhub-metric-value">{inventory ? inventorySkuCountLabel(inventory.lowStockSkuCount, analytics.inventory.status === "partial") : "—"}</strong>
          <span className="stockhub-metric-note">At or below 5 available units across active locations</span>
        </article>
      </div>

      <div className="stockhub-overview-trend-row">
        <SalesTrend analytics={analytics} range={range} currencyCode={analytics.currencyCode} />
        <section className="stockhub-overview-panel stockhub-overview-inventory" aria-labelledby="overview-inventory-title">
          <div className="stockhub-overview-section-heading stockhub-overview-analytics-heading">
            <div><h2 id="overview-inventory-title">Inventory health</h2><p>Available units summed across active locations where stock is tracked</p></div>
          </div>
          <AnalyticsNotice status={analytics.inventory.status} message={analytics.inventory.message} />
          {!inventory ? <div className="stockhub-analytics-empty">{analytics.inventory.message ?? "Inventory health is unavailable."}</div>
            : <>
              <div className="stockhub-inventory-summary">
                <div><span>Low stock</span><strong>{inventorySkuCountLabel(inventory.lowStockSkuCount, analytics.inventory.status === "partial")} SKUs</strong></div>
                <div><span>Out of stock</span><strong>{inventorySkuCountLabel(inventory.outOfStockSkuCount, analytics.inventory.status === "partial")} SKUs</strong></div>
              </div>
              {analytics.inventory.status === "partial" ? <p className="stockhub-overview-metric-note">Partial catalog coverage: observed SKU counts may change when more variants are loaded.</p> : null}
              <p className="stockhub-overview-metric-note">Threshold: ≤ {inventory.threshold} available units. Untracked: {numberLabel(inventory.untrackedCount)} variants · Unknown: {numberLabel(inventory.unknownCount)} variants.</p>
              {inventory.outOfStockVariants.length ? <div className="stockhub-overview-inventory-list-group">
                <h3>Out of stock · restock priority</h3>
                <ul className="stockhub-overview-ranking stockhub-overview-inventory-list" aria-label="Out-of-stock SKUs">
                  {inventory.outOfStockVariants.slice(0, 5).map((variant) => <li key={`out-${variant.id}`}>
                    <span className="stockhub-overview-ranking-copy"><strong>{productAdminUrl(data?.shop.myshopifyDomain, variant.product.legacyResourceId, variant.product.id)
                      ? <a href={productAdminUrl(data?.shop.myshopifyDomain, variant.product.legacyResourceId, variant.product.id)} target="_top">{variant.product.title}</a> : variant.product.title}</strong><span>{variant.sku || variant.title}{variant.variantCount ? ` · ${variant.variantCount} variants share this SKU` : ""}</span></span>
                    <span className="stockhub-overview-ranking-value">0 available</span>
                  </li>)}
                </ul>
              </div> : null}
              {inventory.lowStockVariants.length ? <div className="stockhub-overview-inventory-list-group">
                <h3>Low stock · at or below threshold</h3>
                <ul className="stockhub-overview-ranking stockhub-overview-inventory-list" aria-label="Low-stock SKUs and variants">
                {inventory.lowStockVariants.slice(0, 5).map((variant) => <li key={`low-${variant.id}`}>
                  <span className="stockhub-overview-ranking-copy"><strong>{productAdminUrl(data?.shop.myshopifyDomain, variant.product.legacyResourceId, variant.product.id)
                    ? <a href={productAdminUrl(data?.shop.myshopifyDomain, variant.product.legacyResourceId, variant.product.id)} target="_top">{variant.product.title}</a> : variant.product.title}</strong><span>{variant.sku || variant.title}{variant.variantCount ? ` · ${variant.variantCount} variants share this SKU` : ""}</span></span>
                  <span className="stockhub-overview-ranking-value">{numberLabel(variant.available)} available</span>
                </li>)}
                </ul>
              </div> : null}
              {!inventory.lowStockVariants.length && !inventory.outOfStockVariants.length
                ? inventory.unknownCount || inventory.untrackedCount ? <p className="stockhub-overview-message">No low-stock or out-of-stock SKU can be confirmed from the available tracked inventory data.</p>
                  : <p className="stockhub-overview-message">No low-stock or out-of-stock SKUs were found in the verified inventory data.</p>
                : null}
            </>}
        </section>
      </div>

      <div className="stockhub-overview-ranking-grid">
        <section className="stockhub-overview-panel" aria-labelledby="overview-products-title">
          <div className="stockhub-overview-section-heading stockhub-overview-analytics-heading">
            <div><h2 id="overview-products-title">Top-selling products</h2><p>Ranked by net units sold</p></div>
          </div>
          {!sales ? <p className="stockhub-overview-message">{analytics.sales.message ?? "Product sales data is unavailable."}</p>
            : sales.topProducts.length ? <ol className="stockhub-overview-ranking" aria-label="Top five products by net units sold">
              {sales.topProducts.map((product) => <li key={product.id}>
                {product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" /> : <span className="stockhub-ranking-image-placeholder" aria-hidden="true">□</span>}
                <span className="stockhub-overview-ranking-copy"><strong>{productAdminUrl(data?.shop.myshopifyDomain, product.legacyResourceId, product.id)
                  ? <a href={productAdminUrl(data?.shop.myshopifyDomain, product.legacyResourceId, product.id)} target="_top">{product.title}</a> : product.title}</strong>
                  <span>{currencyLabel(product.revenue, analytics.currencyCode)} net merchandise</span></span>
                <span className="stockhub-overview-ranking-value">{numberLabel(product.units)} units</span>
              </li>)}
            </ol> : <p className="stockhub-overview-message">{analytics.sales.status === "partial" ? "No products could be ranked from the partial data available." : "No products have net units sold in this date range."}</p>}
        </section>

        <section className="stockhub-overview-panel" aria-labelledby="overview-variants-title">
          <div className="stockhub-overview-section-heading stockhub-overview-analytics-heading">
            <div><h2 id="overview-variants-title">Top-selling variants</h2><p>Size, color and SKU detail by net units sold</p></div>
          </div>
          {!sales ? <p className="stockhub-overview-message">{analytics.sales.message ?? "Variant sales data is unavailable."}</p>
            : sales.topVariants.length ? <ol className="stockhub-overview-ranking stockhub-overview-variant-ranking" aria-label="Top five variants by net units sold">
              {sales.topVariants.map((variant) => <li key={variant.id}>
                <span className="stockhub-overview-ranking-copy"><strong>{productAdminUrl(data?.shop.myshopifyDomain, undefined, variant.productId)
                  ? <a href={productAdminUrl(data?.shop.myshopifyDomain, undefined, variant.productId)} target="_top">{variant.productTitle}</a> : variant.productTitle}</strong>
                  <span>{variant.title}{variant.sku ? ` · SKU ${variant.sku}` : " · No SKU"}</span></span>
                <span className="stockhub-overview-ranking-value">{numberLabel(variant.units)} units</span>
              </li>)}
            </ol> : <p className="stockhub-overview-message">{analytics.sales.status === "partial" ? "No variants could be ranked from the partial data available." : "No variants have net units sold in this date range."}</p>}
        </section>
      </div>
    </section>

    <section className="stockhub-overview-section" aria-labelledby="overview-glance-title">
      <div className="stockhub-overview-section-heading">
        <div><h2 id="overview-glance-title">Store snapshot</h2><p>Live product totals for this Shopify store</p></div>
      </div>
      <div className="stockhub-overview-metrics">
        <article className="stockhub-overview-metric stockhub-overview-metric--products">
          <span className="stockhub-metric-label">All products</span>
          <strong className="stockhub-metric-value">{data ? count(data.all) : "—"}</strong>
          <span className="stockhub-metric-note">{data ? "Across all statuses" : "Shopify data unavailable"}</span>
        </article>
        <article className="stockhub-overview-metric stockhub-overview-metric--active">
          <span className="stockhub-metric-label">Active</span>
          <strong className="stockhub-metric-value">{data ? count(data.active) : "—"}</strong>
          <span className="stockhub-metric-note">Active in Shopify</span>
        </article>
        <article className="stockhub-overview-metric stockhub-overview-metric--drafts">
          <span className="stockhub-metric-label">Draft</span>
          <strong className="stockhub-metric-value">{data ? count(data.draft) : "—"}</strong>
          <span className="stockhub-metric-note">Not yet published</span>
        </article>
        <article className="stockhub-overview-metric stockhub-overview-metric--imports">
          <span className="stockhub-metric-label">Import receipts</span>
          <strong className="stockhub-metric-value">{imports ? imports.batchCount : "—"}</strong>
          <span className="stockhub-metric-note">Recorded for this shop</span>
        </article>
      </div>
      {data && [data.all, data.active, data.draft].every((item) => item.precision === "EXACT") && data.all.count > data.active.count + data.draft.count
        ? <p className="stockhub-overview-other-products">{data.all.count - data.active.count - data.draft.count} product{data.all.count - data.active.count - data.draft.count === 1 ? "" : "s"} in other statuses</p>
        : null}
    </section>

    <nav className="stockhub-overview-shortcuts" aria-label="Overview quick actions">
      <span>Quick access</span>
      <Link to="/app/products">Browse products <span aria-hidden="true">↗</span></Link>
      <Link to="/app/imports/history">Import history <span aria-hidden="true">↗</span></Link>
      <Link to="/app/stores">Store details <span aria-hidden="true">↗</span></Link>
    </nav>

    <div className="stockhub-overview-workspace">
      <section className="stockhub-overview-section stockhub-overview-panel stockhub-overview-attention" aria-labelledby="overview-attention-title">
      <div className="stockhub-overview-section-heading">
        <div><h2 id="overview-attention-title">Execution attention</h2><p>Failed, uncertain, or partially completed Shopify import executions. Previewed draft validation issues stay on their receipts and are not failed Shopify mutations.</p></div>
        <Link to="/app/imports/history">View history <span aria-hidden="true">→</span></Link>
      </div>
      {!imports ? <p className="stockhub-overview-message">Import attention could not be loaded.</p>
        : imports.attention.length ? <ul className="stockhub-overview-import-list" aria-label="Import executions requiring attention">
          {imports.attention.map((batch) => <li key={batch.id}>
            <Link className="stockhub-overview-import-primary" to={`/app/imports/history/${encodeURIComponent(batch.id)}`}>
              <strong>{batch.receiptCode.trim() || "Receipt unavailable"}</strong>
              <span>{batch.locationName} · Updated {formatStockhubDateTime(batch.updatedAt ?? batch.createdAt)}</span>
            </Link>
            <span className={`stockhub-status ${statusClass(batch.status)}`}>{statusLabel(batch.status)}</span>
          </li>)}
        </ul> : <p className="stockhub-overview-message">No import executions currently need attention.</p>}
      </section>

      <section className="stockhub-overview-section stockhub-overview-panel stockhub-overview-recent" aria-labelledby="overview-recent-title">
        <div className="stockhub-overview-section-heading">
          <div><h2 id="overview-recent-title">Recent imports</h2><p>Your five latest import receipts</p></div>
          <Link to="/app/imports/history">View all history <span aria-hidden="true">→</span></Link>
        </div>
        {!imports ? <p className="stockhub-overview-message">Import activity is currently unavailable. Recent imports could not be loaded.</p>
          : imports.recent.length ? <ul className="stockhub-overview-import-list" aria-label="Recent import receipts">
            {imports.recent.map((batch) => <li key={batch.id}>
              <Link className="stockhub-overview-import-primary" to={`/app/imports/history/${encodeURIComponent(batch.id)}`}>
                <strong>{batch.receiptCode.trim() || "Receipt unavailable"}</strong>
                <span>{batch.locationName} · Created {formatStockhubDateTime(batch.createdAt)}</span>
              </Link>
              <span className={`stockhub-status ${statusClass(batch.status)}`}>{statusLabel(batch.status)}</span>
            </li>)}
          </ul> : <p className="stockhub-overview-message">No import batches have been recorded for this store.</p>}
      </section>
    </div>
  </main>;
}
