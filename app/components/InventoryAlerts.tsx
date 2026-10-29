import { useMemo, useState } from "react";
import { useNavigation } from "react-router";
import { productAdminUrl } from "./overview/format";
import { buildInventoryAlertsCsv, canExportInventoryAlertRows, filterInventoryAlertRows, handleInventoryAlertsTableArrowKey, inventoryAlertExportBlockReason, paginateInventoryAlertRows, selectInventoryAlertExportRows } from "../utils/inventory-alerts.shared";
import type { InventoryAlertFilters, InventoryAlertRow, InventoryAlertStatus } from "../utils/inventory-alerts.shared";
import type { InventoryAlertsData } from "../utils/inventory-alerts.server";

type Props = { data: InventoryAlertsData; samplePreview: boolean; migrated: boolean; shop: string };
const STATUSES: Array<"ALL" | InventoryAlertStatus> = ["ALL", "OUT_OF_STOCK", "LOW_STOCK", "IN_STOCK", "UNKNOWN", "UNTRACKED", "PARTIAL_DATA"];
const STATUS_LABELS: Record<"ALL" | InventoryAlertStatus, string> = {
  ALL: "All statuses", OUT_OF_STOCK: "Out of stock", LOW_STOCK: "Low stock", IN_STOCK: "In stock",
  UNKNOWN: "Unknown", UNTRACKED: "Untracked", PARTIAL_DATA: "Partial data",
};
const STATUS_RANK: Record<InventoryAlertStatus, number> = {
  OUT_OF_STOCK: 0, LOW_STOCK: 1, PARTIAL_DATA: 2, UNKNOWN: 3, UNTRACKED: 4, IN_STOCK: 5,
};
const EMPTY_FILTERS: InventoryAlertFilters = { status: "ALL", productType: "", color: "", size: "", search: "" };
const quantity = (value: number | null) => value === null ? "—" : Number.isInteger(value) ? String(value) : value.toFixed(1);
const options = (rows: InventoryAlertRow[], pick: (row: InventoryAlertRow) => string | null) =>
  [...new Set(rows.map(pick).filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right));

function exportAlerts(rows: InventoryAlertRow[], filters: InventoryAlertFilters, data: InventoryAlertsData) {
  const csv = buildInventoryAlertsCsv(selectInventoryAlertExportRows(rows, filters), {
    locationScope: data.locationScope, checkedAt: data.checkedAt ?? "",
    dataSource: data.source === "sample" ? "SAMPLE" : "LIVE",
  });
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  const samplePrefix = data.source === "sample" ? "sample-" : "";
  anchor.download = `stockhub-${samplePrefix}inventory-alerts-${(data.checkedAt ?? new Date().toISOString()).slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function displayOption(row: InventoryAlertRow) {
  return row.selectedOptions?.map((option) => option.value).filter(Boolean).join(" / ") || "—";
}

function StatusBadge({ status }: { status: InventoryAlertStatus }) {
  return <span className={`stockhub-alert-status stockhub-alert-status--${status.toLowerCase()}`}>{STATUS_LABELS[status]}</span>;
}

function summary(rows: InventoryAlertRow[]) {
  return rows.reduce((count, row) => ({ ...count, [row.status]: count[row.status] + 1 }), {
    OUT_OF_STOCK: 0, LOW_STOCK: 0, IN_STOCK: 0, UNKNOWN: 0, UNTRACKED: 0, PARTIAL_DATA: 0,
  });
}

export function InventoryAlerts({ data, samplePreview, migrated, shop }: Props) {
  const navigation = useNavigation();
  const [filters, setFilters] = useState<InventoryAlertFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const filteredRows = useMemo(() => filterInventoryAlertRows(data.rows, filters).sort((left, right) =>
    STATUS_RANK[left.status] - STATUS_RANK[right.status] || left.productName.localeCompare(right.productName)
    || left.size?.localeCompare(right.size ?? "") || left.color?.localeCompare(right.color ?? "") || left.variantId.localeCompare(right.variantId)), [data.rows, filters]);
  const pageData = paginateInventoryAlertRows(filteredRows, { page, pageSize });
  const counts = summary(data.rows);
  const exportBlockReason = inventoryAlertExportBlockReason(data);
  const exportAllowed = canExportInventoryAlertRows(data);
  const exportCount = exportAllowed ? selectInventoryAlertExportRows(data.rows, filters).length : 0;
  const exportDisabledReason = exportBlockReason ?? (exportCount === 0 ? "No matching out-of-stock or low-stock variants." : null);
  const productTypes = options(data.rows, (row) => row.productType);
  const colors = options(data.rows, (row) => row.color);
  const sizes = options(data.rows, (row) => row.size);
  const emptyTitle = data.readStatus === "ready" ? "No inventory variants found"
    : data.readStatus === "permission_required" ? "Inventory access is required"
      : data.readStatus === "unverified" ? "Shopify access could not be verified"
        : data.readStatus === "partial" ? "No complete inventory rows were returned" : "Live inventory is unavailable";
  const emptyDescription = data.readStatus === "ready" ? "No variants were returned for this store."
    : data.readStatus === "permission_required" ? "Grant the required read-only inventory access, then reload this page."
      : data.readStatus === "unverified" ? "The current access grant could not be confirmed, so no product inventory was requested."
        : data.readStatus === "partial" ? "Shopify returned incomplete catalog or location data. No missing values are assumed to be zero."
          : "The inventory request did not complete. Retry after checking Shopify access.";
  const setFilter = <K extends keyof InventoryAlertFilters>(key: K, value: InventoryAlertFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  };
  const sampleUrl = "/app/inventory-alerts?sample=1";
  const liveUrl = `/app/inventory-alerts?refresh=${Date.now()}`;

  return <main className="stockhub-page stockhub-inventory-alerts">
    <header className="stockhub-alerts-header">
      <div><p className="stockhub-alerts-eyebrow">INVENTORY VISIBILITY</p><h1>Inventory Alerts</h1>
        <p>Review variant-level stock using available quantities across active locations.</p></div>
      <div className="stockhub-alerts-header-actions">
        <a className="stockhub-alert-button" href={samplePreview ? liveUrl : sampleUrl}>{samplePreview ? "Return to live data" : "Preview sample data"}</a>
        <a className="stockhub-alert-button stockhub-alert-button--primary" href={samplePreview ? `${sampleUrl}&refresh=${Date.now()}` : liveUrl}>Refresh</a>
      </div>
    </header>

    {navigation.state === "loading" ? <div className="stockhub-alerts-loading" role="status" aria-live="polite">Loading inventory alerts…</div> : null}
    {migrated ? <s-banner tone="info">The Restock Planner was retired. Inventory Alerts now shows read-only stock status; no purchase quantities or supplier actions are created.</s-banner> : null}
    {samplePreview ? <s-banner tone="info">DEMO · Isolated sample rows; no Shopify inventory was read or changed. The sample totals combine two active demo locations.</s-banner> : null}
    {data.readStatus === "permission_required" ? <s-banner tone="warning">{data.message}</s-banner> : null}
    {data.readStatus === "unverified" ? <s-banner tone="critical">{data.message}</s-banner> : null}
    {data.readStatus === "unavailable" ? <s-banner tone="warning">{data.message}</s-banner> : null}
    {data.readStatus === "partial" ? <s-banner tone="warning">{data.message ?? "Some inventory or catalog data is incomplete. Incomplete values remain separate from zero stock."}</s-banner> : null}

    <div className="stockhub-alerts-context" role="status">
      <span>{samplePreview ? "DEMO DATA" : "LIVE SHOPIFY DATA"}</span>
      <span>Scope: {data.locationScope}{samplePreview && data.activeLocationCount ? ` · ${data.activeLocationCount} active demo locations` : ""}</span>
      <span>Last successful read: {data.checkedAt && Number.isFinite(Date.parse(data.checkedAt)) ? new Date(data.checkedAt).toLocaleString() : "Unavailable"}</span>
    </div>

    <section className="stockhub-alerts-summary" aria-label="Inventory status summary">
      <article className="is-out"><strong>{counts.OUT_OF_STOCK}</strong><span>Out of stock</span></article>
      <article className="is-low"><strong>{counts.LOW_STOCK}</strong><span>Low stock (1–4)</span></article>
      <article className="is-in"><strong>{counts.IN_STOCK}</strong><span>In stock (5+)</span></article>
      <article className="is-review"><strong>{counts.UNKNOWN + counts.UNTRACKED + counts.PARTIAL_DATA}</strong><span>Unknown / untracked / partial</span></article>
    </section>

    <section className="stockhub-alerts-results" aria-labelledby="inventory-alert-results-title">
      <div className="stockhub-alerts-results-heading"><div><h2 id="inventory-alert-results-title">Variant inventory</h2>
        <p>0 or less is out of stock; 1–4 is low; 5 or more is in stock. Unknown, untracked, and partial values are never treated as zero.</p></div>
        <div className="stockhub-alerts-export">
          <button type="button" className="stockhub-alert-button stockhub-alert-button--primary" disabled={!exportCount || !exportAllowed}
            onClick={() => exportAlerts(data.rows, filters, data)}>Export all filtered alerts (CSV) <span>({exportCount})</span></button>
          {exportDisabledReason ? <p role="status">{exportDisabledReason}</p> : null}
        </div>
      </div>

      <div className="stockhub-alerts-filters">
        <label>Search<input type="search" value={filters.search} onChange={(event) => setFilter("search", event.currentTarget.value)} placeholder="Product, SKU, option, or Shopify ID" /></label>
        <label>Status<select value={filters.status} onChange={(event) => setFilter("status", event.currentTarget.value)}>{STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></label>
        <label>Product type<select value={filters.productType} onChange={(event) => setFilter("productType", event.currentTarget.value)}><option value="">All product types</option>{productTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
        <label>Color<select value={filters.color} onChange={(event) => setFilter("color", event.currentTarget.value)}><option value="">All colors</option>{colors.map((color) => <option key={color}>{color}</option>)}</select></label>
        <label>Size<select value={filters.size} onChange={(event) => setFilter("size", event.currentTarget.value)}><option value="">All sizes</option>{sizes.map((size) => <option key={size}>{size}</option>)}</select></label>
      </div>

      {!data.rows.length ? <div className="stockhub-alerts-empty"><h3>{emptyTitle}</h3><p>{emptyDescription}</p></div>
        : !filteredRows.length ? <div className="stockhub-alerts-empty"><h3>No variants match these filters</h3><p>Adjust or clear the current filters to review more variants.</p>
          <button type="button" className="stockhub-alert-button" onClick={() => { setFilters(EMPTY_FILTERS); setPage(1); }}>Clear filters</button></div> : null}

      {filteredRows.length ? <>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions -- The labeled region is keyboard-focusable and uses arrows for horizontal scrolling. */}
        <div className="stockhub-alerts-table-wrap" role="region" aria-label="Variant inventory alerts table. Use Left and Right Arrow keys to scroll horizontally." tabIndex={0}
          onKeyDown={(event) => handleInventoryAlertsTableArrowKey(event)}>
          <table className="stockhub-alerts-table">
            <thead><tr><th scope="col">Product / options</th><th scope="col">Product type</th><th scope="col">SKU</th><th scope="col">Color</th><th scope="col">Size</th><th scope="col">Available</th><th scope="col">Status</th><th scope="col">Shopify IDs</th></tr></thead>
            <tbody>{pageData.rows.map((row) => {
              const productUrl = productAdminUrl(shop, undefined, row.productId);
              return <tr key={row.variantId}>
              <td data-label="Product / options"><strong>{productUrl ? <a href={productUrl} target="_top" rel="noreferrer" aria-label={`Open ${row.productName} in Shopify`}>{row.productName}</a> : row.productName}</strong><span>{displayOption(row)}</span></td>
              <td data-label="Product type">{row.productType ?? "—"}</td>
              <td data-label="SKU">{row.sku ?? "—"}</td>
              <td data-label="Color">{row.color ?? "—"}</td>
              <td data-label="Size">{row.size ?? "—"}</td>
              <td data-label="Available">{quantity(row.availableQuantity)}</td>
              <td data-label="Status"><StatusBadge status={row.status} />{row.status === "PARTIAL_DATA" ? <small>Observed value is incomplete</small> : null}</td>
              <td data-label="Shopify IDs" className="stockhub-alerts-identities"><span>Product: {row.productId}</span><span>Variant: {row.variantId}</span><span>Inventory item: {row.inventoryItemId ?? "Unavailable"}</span></td>
            </tr>;
            })}</tbody>
          </table>
        </div>
        <nav className="stockhub-alerts-pagination" aria-label="Inventory alerts pages">
          <span>{pageData.total} variants · page {pageData.page} of {Math.max(1, pageData.pageCount)}</span>
          <label>Rows<select value={pageSize} onChange={(event) => { setPageSize(Number(event.currentTarget.value)); setPage(1); }}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option></select></label>
          <button type="button" className="stockhub-alert-button" disabled={pageData.page <= 1} onClick={() => setPage(pageData.page - 1)}>Previous</button>
          <button type="button" className="stockhub-alert-button" disabled={pageData.page >= pageData.pageCount} onClick={() => setPage(pageData.page + 1)}>Next</button>
        </nav>
      </> : null}
      {data.catalogComplete === false && !samplePreview ? <p className="stockhub-alerts-footnote">Shopify’s variant catalog pagination was incomplete. The list includes only returned variants; no unseen variants are assumed to have zero stock.</p> : null}
    </section>
  </main>;
}
