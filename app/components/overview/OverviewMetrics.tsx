import type { OverviewAnalytics } from "../../utils/overview-analytics.server";
import { currencyLabel, numberLabel } from "./format";

type Props = { analytics: OverviewAnalytics; samplePreview: boolean };

function Metric({ label, value, note, accent }: { label: string; value: string; note: string; accent: string }) {
  return <article className={`stockhub-overview-metric stockhub-overview-metric--${accent}`}>
    <span className="stockhub-metric-label">{label}</span>
    <strong className="stockhub-metric-value">{value}</strong>
    <span className="stockhub-metric-note">{note}</span>
  </article>;
}

export function OverviewMetrics({ analytics, samplePreview }: Props) {
  const sales = analytics.sales.data;
  const inventory = analytics.inventory.data;
  const currencyCode = samplePreview ? "USD" : sales?.currencyCode ?? analytics.currencyCode;
  const lowStock = inventory
    ? `${analytics.inventory.status === "partial" ? "Observed " : ""}${numberLabel(inventory.lowStockSkuCount)}`
    : "Unavailable";
  return <section className="stockhub-overview-metrics stockhub-overview-sales-metrics" aria-label="Store performance summary">
    <Metric accent="revenue" label="Net merchandise sales" value={currencyLabel(sales?.totals.revenue, currencyCode)} note="After discounts and returns · before tax" />
    <Metric accent="orders" label="Orders" value={sales ? numberLabel(sales.totals.orders) : "Unavailable"} note="Non-cancelled, non-test orders" />
    <Metric accent="units" label="Units sold" value={sales ? numberLabel(sales.totals.units) : "Unavailable"} note="Net units after returns" />
    <Metric accent="low-stock" label="Low-stock SKUs" value={lowStock} note="≤ 5 available across active locations" />
  </section>;
}
