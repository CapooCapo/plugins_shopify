import { Link } from "react-router";
import type { ImportOverview } from "../../utils/overview-types";
import { dateTimeLabel, importStatusClass, importStatusLabel } from "./format";

type Props = { imports: ImportOverview | null };

export function RecentImports({ imports }: Props) {
  const hasPreviewedReceipt = imports?.recent.some((batch) => batch.kind === "inventory" && batch.status === "PREVIEWED");
  return <section className="stockhub-overview-section stockhub-overview-panel stockhub-overview-recent" aria-labelledby="overview-recent-title">
    <div className="stockhub-overview-section-heading">
      <div><span className="stockhub-overview-panel-kicker">Recent Imports</span><h2 id="overview-recent-title">Latest activity</h2>
        <p>{imports?.sample ? "Illustrative sample lifecycle states · not stored in this shop" : "Latest inventory receipts and catalog drafts"}</p>
        {hasPreviewedReceipt ? <p>Previewed is validation only; it does not mean a failed Shopify mutation.</p> : null}</div>
      <Link to="/app/imports/history">{imports?.sample ? "View live history" : "View all history"} <span aria-hidden="true">→</span></Link>
    </div>
    {!imports ? <p className="stockhub-overview-message">Import activity is unavailable. Recent history could not be loaded.</p>
      : imports.recent.length ? <ul className="stockhub-overview-import-list" aria-label="Recent imports">
        {imports.recent.slice(0, 5).map((batch) => <li key={batch.id}>
          {batch.detailHref ? <Link className="stockhub-overview-import-primary" to={batch.detailHref}>
            <strong>{batch.label}</strong><span>{batch.kind === "inventory" ? "Inventory import" : "Catalog draft"}{batch.locationName ? ` · ${batch.locationName}` : ""} · {dateTimeLabel(batch.createdAt)}</span>
          </Link> : <div className="stockhub-overview-import-primary" aria-label={`${batch.label}, sample ${batch.kind} status`}>
            <strong>{batch.label}</strong><span>Sample {batch.kind === "inventory" ? "inventory import" : "catalog draft"}{batch.locationName ? ` · ${batch.locationName}` : ""} · {dateTimeLabel(batch.createdAt)}</span>
          </div>}
          <span className={`stockhub-status ${importStatusClass(batch.status)}`}>{importStatusLabel(batch.status, batch.kind)}</span>
        </li>)}
      </ul> : <p className="stockhub-overview-message">No imports or catalog drafts have been recorded for this store.</p>}
  </section>;
}
