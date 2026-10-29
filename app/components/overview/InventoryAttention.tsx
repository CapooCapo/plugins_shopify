import { Link } from "react-router";
import type { OverviewAnalytics } from "../../utils/overview-analytics.server";
import { numberLabel } from "./format";
import { rankInventoryAttention } from "./attention-ranking";

type Props = { analytics: OverviewAnalytics };

function inventoryHref(sku: string | null, productTitle: string) {
  const params = new URLSearchParams({ q: sku || productTitle });
  if (sku) params.set("searchBy", "sku");
  return `/app/products?${params.toString()}`;
}

export function InventoryAttention({ analytics }: Props) {
  const inventory = analytics.inventory.data;
  const trustworthySales = analytics.sales.status === "ready" && analytics.sales.data !== null;
  const rows = inventory ? rankInventoryAttention(inventory, analytics.sales.data, trustworthySales) : [];
  const unknownCount = (inventory?.unknownCount ?? 0) + (inventory?.untrackedCount ?? 0);

  return <section className="stockhub-overview-section stockhub-overview-panel stockhub-overview-attention" aria-labelledby="overview-attention-title">
    <div className="stockhub-overview-section-heading">
      <div><span className="stockhub-overview-panel-kicker">Inventory Attention</span><h2 id="overview-attention-title">Restock watch</h2>
        <p>{trustworthySales ? "Known sales velocity first · active, tracked locations only" : "Inventory-only priority · active, tracked locations only"}</p></div>
      <Link to="/app/products">Browse inventory <span aria-hidden="true">→</span></Link>
    </div>
    {analytics.inventory.status !== "ready" && analytics.inventory.status !== "partial"
      ? <p className="stockhub-overview-message">{analytics.inventory.message ?? "Inventory attention is unavailable."}</p>
      : <>
        {analytics.inventory.status === "partial" && analytics.inventory.message
          ? <p className="stockhub-analytics-notice stockhub-analytics-notice--partial" role="status">{analytics.inventory.message}</p> : null}
        {rows.length ? <ul className="stockhub-overview-attention-list" aria-label="Three inventory items needing attention">
        {rows.map((variant) => <li key={variant.id}>
          <div className="stockhub-attention-product">
            <span className={`stockhub-attention-dot stockhub-attention-dot--${variant.severity}`} aria-hidden="true" />
            <div><Link to={inventoryHref(variant.sku, variant.product.title)}>{variant.product.title}</Link>
              <span>{variant.title}{variant.sku ? ` · SKU ${variant.sku}` : " · No SKU"}{variant.variantCount ? ` · ${variant.variantCount} variants share SKU` : ""}</span></div>
          </div>
          <span className={`stockhub-attention-status stockhub-attention-status--${variant.severity}`}>{variant.severity === "out" ? "Out of stock" : "Low stock"}</span>
          <strong className="stockhub-attention-stock">{numberLabel(variant.available)}<small> available</small></strong>
          <span className="stockhub-attention-velocity">{variant.salesUnits === null ? "Sales not ranked" : `${numberLabel(variant.salesUnits)} sold`}</span>
        </li>)}
        </ul> : <p className="stockhub-overview-message">No low- or out-of-stock tracked SKU can be confirmed from the available data.</p>}
      </>}
    <p className="stockhub-overview-metric-note">Unknown and untracked inventory is excluded, never treated as zero.{unknownCount ? ` ${numberLabel(unknownCount)} variants have unknown or untracked availability.` : ""}{inventory?.nonPhysicalCount ? ` ${numberLabel(inventory.nonPhysicalCount)} gift-card variants are excluded from physical restock.` : ""}</p>
  </section>;
}
