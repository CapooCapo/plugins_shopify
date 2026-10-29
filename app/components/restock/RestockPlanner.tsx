import { useMemo, useState } from "react";
import { calculateRestockRecommendations, summarizeRestock } from "../../utils/restock/restock-calculate";
import { buildRestockCsv } from "../../utils/restock/restock-export.shared";
import { parseOptionalInteger, validatePlanningSettings } from "../../utils/restock/restock-settings";
import type { PlanningSettings, RestockData, RestockPeriod, RestockRecommendation } from "../../utils/restock/restock.types";

type Props = { data: RestockData; samplePreview: boolean };
type SortKey = "productTitle" | "unitsSold" | "available" | "suggestedQuantity" | "priority";
const number = (value: number | null, suffix = "") => value === null ? "—" : `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`;

function exportRows(rows: RestockRecommendation[], manualValues: Record<string, string>) {
  const csv = buildRestockCsv(rows, manualValues);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `stockhub-restock-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function statusLabel(row: RestockRecommendation) {
  if (row.status === "excluded") return "Not applicable";
  if (row.status === "settings_required") return "Settings required";
  if (row.status === "needs_review") return "Needs review";
  return row.priority === "urgent" ? "Urgent" : row.priority === "high" ? "Restock" : "Sufficient";
}

function freshness(data: RestockData) {
  const time = new Date(data.generatedAt);
  return Number.isFinite(time.getTime()) ? time.toLocaleString() : "Unavailable";
}

export function RestockPlanner({ data, samplePreview }: Props) {
  const [settingText, setSettingText] = useState({ lead: "", coverage: "", buffer: "" });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortAscending, setSortAscending] = useState(true);
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const parsedSettings = useMemo<PlanningSettings>(() => ({
    leadTimeDays: parseOptionalInteger(settingText.lead),
    coverageDays: parseOptionalInteger(settingText.coverage),
    safetyBufferDays: parseOptionalInteger(settingText.buffer),
  }), [settingText.lead, settingText.coverage, settingText.buffer]);
  const settingsResult = useMemo(() => validatePlanningSettings(parsedSettings), [parsedSettings]);
  const recommendations = useMemo(() => calculateRestockRecommendations(data.rows, {
    periodStartUtc: data.periodStartUtc, timeZone: data.timeZone,
    analysisDays: data.analysisDays, settings: parsedSettings,
    salesComplete: data.salesDemandComplete,
  }), [data, parsedSettings]);
  const summary = summarizeRestock(recommendations);
  const visibleRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return recommendations.filter((row) => {
      const matchesSearch = !query || [row.productTitle, row.variantTitle, row.sku, row.variantId].some((value) => value?.toLocaleLowerCase().includes(query));
      const matchesFilter = filter === "all"
        || (filter === "restock" && row.status === "calculated" && (row.suggestedQuantity ?? 0) > 0)
        || (filter === "review" && row.status !== "calculated" && row.status !== "excluded")
        || (filter === "sufficient" && row.status === "calculated" && (row.suggestedQuantity ?? 0) === 0);
      return matchesSearch && matchesFilter;
    }).sort((left, right) => {
      const a = left[sortKey]; const b = right[sortKey];
      let order = typeof a === "number" || typeof b === "number"
        ? ((a as number | null) ?? -1) - ((b as number | null) ?? -1)
        : String(a ?? "").localeCompare(String(b ?? ""));
      if (sortKey === "priority") {
        const priority = { urgent: 0, high: 1, normal: 2, review: 3, excluded: 4 };
        order = priority[left.priority] - priority[right.priority];
      }
      if (!order) order = left.productTitle.localeCompare(right.productTitle) || left.variantTitle.localeCompare(right.variantTitle);
      return sortAscending ? order : -order;
    });
  }, [recommendations, search, filter, sortKey, sortAscending]);
  const setNumber = (field: "lead" | "coverage" | "buffer", value: string) => setSettingText((old) => ({ ...old, [field]: value }));
  const setSort = (value: SortKey) => {
    if (sortKey === value) setSortAscending((old) => !old);
    else { setSortKey(value); setSortAscending(true); }
  };
  const period = data.period as RestockPeriod;
  const sampleUrl = `/app/restock?period=${period}&sample=1`;
  const liveUrl = `/app/restock?period=${period}`;
  const refreshUrl = `${samplePreview ? sampleUrl : liveUrl}&refresh=${Date.now()}`;

  return <main className="stockhub-page stockhub-restock">
    <header className="stockhub-restock-header">
      <div><p className="stockhub-eyebrow">INVENTORY PLANNING</p><h1>Restock Planner</h1>
        <p>Review what may need replenishment, estimate a transparent quantity, and adjust it for your supplier order.</p></div>
      <div className="stockhub-restock-actions">
        <label>Sales period<select aria-label="Sales period" value={String(period)} onChange={(event) => { window.location.href = samplePreview ? sampleUrl.replace(`period=${period}`, `period=${event.currentTarget.value}`) : liveUrl.replace(`period=${period}`, `period=${event.currentTarget.value}`); }}>
          <option value="28">28D</option><option value="56">56D</option>
        </select></label>
        <a className="stockhub-button" href={refreshUrl}>Refresh</a>
        {samplePreview ? <a className="stockhub-button" href={liveUrl}>Return to live data</a> : <a className="stockhub-button" href={sampleUrl}>Preview Sample Data</a>}
      </div>
    </header>

    <div className="stockhub-restock-freshness" role="status">
      <span>{samplePreview ? "DEMO · USD sample values" : `Live Shopify data · ${data.currencyCode ?? "store currency unavailable"}`}</span>
      <span>Last refreshed: {freshness(data)}{data.timeZone ? ` · ${data.timeZone}` : ""}</span>
    </div>
    {samplePreview ? <s-banner tone="info">DEMO mode uses deterministic sample fixtures. No sample records are written to Shopify.</s-banner> : null}
    {!samplePreview && data.salesStatus === "permission_required" ? <s-banner tone="warning">{data.salesMessage} Preview Sample Data remains available while Orders access is missing.</s-banner> : null}
    {!samplePreview && data.salesStatus === "unverified" ? <s-banner tone="critical">{data.salesMessage}</s-banner> : null}
    {!samplePreview && data.salesStatus === "unavailable" ? <s-banner tone="warning">{data.salesMessage ?? "Live sales are unavailable. System quantities are withheld."}</s-banner> : null}
    {!data.salesDemandComplete && ["ready", "partial"].includes(data.salesStatus) ? <s-banner tone="warning">Some per-variant demand could not be mapped or was incomplete. Observed units are shown when known, but system quantities are withheld.</s-banner> : null}
    {data.salesStatus === "partial" && data.salesDemandComplete ? <s-banner tone="info">Some non-unit sales fields are partial; per-variant unit demand is complete and is the only sales metric used for planning.</s-banner> : null}
    {data.inventoryMessage && data.inventoryStatus !== "ready" ? <s-banner tone={data.inventoryStatus === "permission_required" ? "warning" : "info"}>{data.inventoryMessage}</s-banner> : null}

    <section className="stockhub-restock-settings" aria-labelledby="restock-settings-title">
      <div><h2 id="restock-settings-title">Planning settings</h2><p>Use your supplier lead time and desired stock coverage. No merchant-specific defaults are assumed.</p></div>
      <div className="stockhub-restock-settings-fields">
        <label>Supplier lead time (days)<input type="number" min="0" max="365" step="1" value={settingText.lead} onChange={(event) => setNumber("lead", event.currentTarget.value)} /></label>
        <label>Inventory coverage (days)<input type="number" min="0" max="365" step="1" value={settingText.coverage} onChange={(event) => setNumber("coverage", event.currentTarget.value)} /></label>
        <label>Safety buffer (days)<input type="number" min="0" max="365" step="1" value={settingText.buffer} onChange={(event) => setNumber("buffer", event.currentTarget.value)} /></label>
      </div>
      {!settingsResult.valid ? <p className="stockhub-restock-note" role="status">{settingsResult.message}</p> : <p className="stockhub-restock-note">System quantities use {settingText.lead} lead + {settingText.coverage} coverage + {settingText.buffer} buffer days.</p>}
    </section>

    <section className="stockhub-restock-summary" aria-label="Restock summary">
      <article><strong>{summary.recommendedVariants}</strong><span>Variants to restock</span></article>
      <article><strong>{summary.suggestedUnits}</strong><span>System-suggested units</span></article>
      <article><strong>{summary.urgentVariants}</strong><span>Urgent variants</span></article>
      <article><strong>{summary.manualReviewVariants}</strong><span>Require manual review</span></article>
    </section>
    {data.inventoryCatalogComplete === false && !samplePreview ? <p className="stockhub-restock-note">Inventory catalog pagination was incomplete. Summary totals cover only variants received from Shopify.</p> : null}

    <section className="stockhub-restock-results" aria-labelledby="restock-results-title">
      <div className="stockhub-restock-results-heading"><div><h2 id="restock-results-title">Restock recommendations</h2><p>System quantities are estimates, not guaranteed demand forecasts. Incoming stock is not deducted.</p></div>
        <button type="button" className="stockhub-button stockhub-button--primary" onClick={() => exportRows(visibleRows, manualValues)}>Export CSV</button></div>
      <div className="stockhub-restock-filters">
        <label>Search<input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Product, variant, SKU, or ID" /></label>
        <label>Show<select value={filter} onChange={(event) => setFilter(event.currentTarget.value)}><option value="all">All variants</option><option value="restock">Restock recommended</option><option value="review">Manual review</option><option value="sufficient">Sufficient stock</option></select></label>
        <label>Sort by<select value={sortKey} onChange={(event) => setSortKey(event.currentTarget.value as SortKey)}><option value="priority">Priority</option><option value="productTitle">Product</option><option value="unitsSold">Units sold</option><option value="available">Available inventory</option><option value="suggestedQuantity">Suggested quantity</option></select></label>
        <button type="button" className="stockhub-button" onClick={() => setSortAscending((old) => !old)}>Order {sortAscending ? "↑" : "↓"}</button>
      </div>
      {!data.rows.length ? <div className="stockhub-restock-empty"><h3>No variant data available</h3><p>Check the live permission and data status above, or preview the deterministic sample.</p></div> : null}
      <div className="stockhub-restock-table-wrap"><table className="stockhub-restock-table">
        <thead><tr><th><button type="button" onClick={() => setSort("productTitle")}>Product / variant</button></th><th>SKU</th><th><button type="button" onClick={() => setSort("unitsSold")}>Units sold</button></th><th>Avg / day</th><th><button type="button" onClick={() => setSort("available")}>Available</button></th><th>Coverage</th><th><button type="button" onClick={() => setSort("suggestedQuantity")}>System quantity</button></th><th>Merchant quantity</th><th>Priority / status</th></tr></thead>
        <tbody>{visibleRows.map((row) => {
          const manualRaw = manualValues[row.variantId] ?? "";
          const manualValid = /^\d+$/.test(manualRaw) && Number.isSafeInteger(Number(manualRaw));
          return <tr key={row.variantId}>
            <td data-label="Product / variant"><strong>{row.productTitle}</strong><span>{row.variantTitle}</span></td>
            <td data-label="SKU">{row.sku ?? "—"}</td>
            <td data-label="Units sold">{number(row.unitsSold)}</td>
            <td data-label="Average daily units">{number(row.averageDailyUnits)}</td>
            <td data-label="Available inventory">{row.available === null ? row.inventoryStatus === "untracked" ? "Untracked" : row.inventoryStatus === "non_physical" ? "Not applicable" : "Unknown / incomplete" : number(row.available)}</td>
            <td data-label="Estimated coverage">{number(row.coverageDays, " days")}</td>
            <td data-label="System-suggested quantity">{row.suggestedQuantity === null ? "Not calculated" : <><strong>{row.suggestedQuantity}</strong><small>System-calculated</small></>}</td>
            <td data-label="Merchant-entered quantity"><label className="stockhub-restock-manual"><span className="stockhub-visually-hidden">Merchant-entered quantity for {row.productTitle} {row.variantTitle}</span><input type="number" min="0" step="1" value={manualRaw} disabled={row.status === "excluded"} onChange={(event) => setManualValues((current) => ({ ...current, [row.variantId]: event.currentTarget.value }))} placeholder="Override" /></label>{manualRaw && !manualValid ? <small className="stockhub-restock-invalid">Enter a whole number ≥ 0</small> : manualValid ? <small>Merchant-entered</small> : null}</td>
            <td data-label="Priority / status"><span className={`stockhub-restock-status stockhub-restock-status--${row.priority}`}>{statusLabel(row)}</span><details><summary>Why?</summary><p>{row.explanation}</p>{row.qualityIssues.map((issue) => <p key={issue}>{issue}</p>)}</details></td>
          </tr>;
        })}</tbody>
      </table></div>
      {data.rows.length > 0 && visibleRows.length === 0 ? <div className="stockhub-restock-empty">No variants match these filters.</div> : null}
      <p className="stockhub-restock-footnote">Formula: ceil(net units sold ÷ complete shop-local days × (lead time + coverage + safety buffer)) − known available inventory. Only complete, reviewed system rows contribute to summary totals.</p>
    </section>
  </main>;
}
