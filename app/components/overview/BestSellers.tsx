import { useState } from "react";
import type { OverviewAnalytics } from "../../utils/overview-analytics.server";
import { currencyLabel, numberLabel, productAdminUrl } from "./format";

type Props = { analytics: OverviewAnalytics; shopDomain?: string; currencyCode: string | null };
type Ranking = "products" | "variants";

export function BestSellers({ analytics, shopDomain, currencyCode }: Props) {
  const [ranking, setRanking] = useState<Ranking>("products");
  const sales = analytics.sales.data;
  const products = sales?.topProducts ?? [];
  const variants = sales?.topVariants ?? [];
  const rows = ranking === "products" ? products : variants;
  const busy = analytics.sales.status !== "ready" && analytics.sales.status !== "partial";

  return <section className="stockhub-overview-panel stockhub-overview-best-sellers" aria-labelledby="overview-best-sellers-title">
    <div className="stockhub-overview-section-heading stockhub-overview-analytics-heading">
      <div><span className="stockhub-overview-panel-kicker">Best Sellers</span><h2 id="overview-best-sellers-title">Top by net units</h2>
        <p>Last {analytics.range} days</p></div>
      <div className="stockhub-chart-switch stockhub-ranking-switch" role="group" aria-label="Best seller ranking type">
        <button type="button" aria-pressed={ranking === "products"} onClick={() => setRanking("products")}>Products</button>
        <button type="button" aria-pressed={ranking === "variants"} onClick={() => setRanking("variants")}>Variants</button>
      </div>
    </div>
    {busy ? <p className="stockhub-overview-message">{analytics.sales.message ?? "Sales rankings are unavailable."}</p>
      : !rows.length ? <p className="stockhub-overview-message">{analytics.sales.status === "partial" ? "No ranking can be confirmed from the partial sales data." : "No items have net units sold in this date range."}</p>
        : <ol className="stockhub-overview-ranking" aria-label={`Top ${ranking} by net units sold`}>
          {ranking === "products" ? products.slice(0, 5).map((product) => {
            const href = productAdminUrl(shopDomain, product.legacyResourceId, product.id);
            return <li key={product.id}>
              {product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" /> : <span className="stockhub-ranking-image-placeholder" aria-hidden="true">—</span>}
              <span className="stockhub-overview-ranking-copy"><strong>{href ? <a href={href} target="_top">{product.title}</a> : product.title}</strong>
                <span>{currencyLabel(product.revenue, currencyCode)} net sales</span></span>
              <span className="stockhub-overview-ranking-value">{numberLabel(product.units)}<small>units</small></span>
            </li>;
          }) : variants.slice(0, 5).map((variant) => {
            const href = productAdminUrl(shopDomain, undefined, variant.productId);
            return <li key={variant.id}>
              <span className="stockhub-ranking-image-placeholder" aria-hidden="true">↳</span>
              <span className="stockhub-overview-ranking-copy"><strong>{href ? <a href={href} target="_top">{variant.productTitle}</a> : variant.productTitle}</strong>
                <span>{variant.title} · {variant.sku ? `SKU ${variant.sku}` : "No SKU"}</span></span>
              <span className="stockhub-overview-ranking-value">{numberLabel(variant.units)}<small>units</small></span>
            </li>;
          })}
        </ol>}
  </section>;
}
