import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { RoutePending } from "../components/RoutePending";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { missingScopesForGrant, queryGrantedScopes } from "../utils/shopify-scopes.server";
import { formatStockhubDateTime } from "../utils/stockhub-format.js";

export { action } from "./app.imports._index";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, scopes } = await authenticate.admin(request);
  const url = new URL(request.url);
  const batch = await prisma.importBatch.findFirst({
    where: { id: params.batchId, shop: session.shop },
    include: { lines: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) throw new Response("Import receipt not found", { status: 404 });
  let grantedScopes: string[] = [];
  let scopesVerified = false;
  try {
    grantedScopes = await queryGrantedScopes(scopes);
    scopesVerified = true;
  } catch { /* action revalidates grants before every operation */ }
  const missingReadScopes = scopesVerified
    ? missingScopesForGrant(grantedScopes, ["read_products", "read_inventory", "read_locations"])
    : ["read_products", "read_inventory", "read_locations"];
  const missingWriteScopes = scopesVerified
    ? missingScopesForGrant(grantedScopes, ["write_inventory", "write_products"])
    : ["write_inventory", "write_products"];
  return { batch, scopesVerified, missingReadScopes, missingWriteScopes, shop: session.shop, historyHref: `/app/imports/history${url.search}`, draftNotice: url.searchParams.get("draft") };
};

function stageLabel(stage: string, status: string, errorCode: string | null) {
  if (status === "SUCCEEDED") return "Import line completed";
  if (status === "UNCERTAIN") return "Outcome uncertain";
  if (status === "BLOCKED" || stage === "BLOCKED") return "Blocked";
  if (status === "FAILED") {
    if (stage === "INVENTORY_ACTIVATING" || errorCode?.startsWith("INVENTORY_ACTIVATE_")) return "Inventory activation failed";
    if (stage === "INVENTORY_ADJUSTING" || errorCode?.startsWith("INVENTORY_ADJUST_")) return "Inventory adjustment failed";
    if (stage === "PRODUCT_CREATING" || errorCode?.startsWith("PRODUCT_CREATE_")) return "Draft product creation failed";
    return stage === "PRODUCT_CREATED" ? "Draft product created; a later import step failed" : "Import line failed";
  }
  if (stage === "PRODUCT_CREATED") return "Draft product created; import line incomplete";
  return stage.replaceAll("_", " ").toLowerCase();
}

function statusLabel(status: string) {
  return status === "SUCCEEDED" ? "Completed" : status === "FAILED" ? "Failed"
    : status === "BLOCKED" ? "Blocked" : status === "UNCERTAIN" ? "Uncertain"
      : status === "RUNNING" ? "In progress" : status === "PROCESSING" ? "Processing"
        : status === "PREVIEWED" ? "Previewed" : status;
}

function batchStatusLabel(status: string) {
  return status === "COMPLETED" ? "Completed" : status === "PARTIAL" ? "Partially completed"
    : status === "UNCERTAIN" ? "Outcome uncertain" : status === "FAILED" ? "Failed"
    : status === "BLOCKED" ? "Blocked" : status === "RUNNING" ? "In progress"
      : status === "PROCESSING" ? "Processing"
        : status === "PREVIEWED" ? "Previewed" : status;
}

function statusTone(status: string): "success" | "critical" | "warning" | "info" | "neutral" {
  if (status === "COMPLETED" || status === "SUCCEEDED") return "success";
  if (status === "FAILED" || status === "BLOCKED") return "critical";
  if (status === "PARTIAL" || status === "UNCERTAIN") return "warning";
  if (status === "PREVIEWED" || status === "RUNNING" || status === "PROCESSING") return "info";
  return "neutral";
}

function statusIcon(status: string) {
  if (status === "COMPLETED" || status === "SUCCEEDED") return "check-circle";
  if (status === "FAILED" || status === "BLOCKED") return "alert-circle";
  if (status === "PARTIAL" || status === "UNCERTAIN") return "alert-triangle";
  if (status === "RUNNING" || status === "PROCESSING") return "clock";
  return "info";
}

function isCsvValidationError(errorCode: string | null) {
  return errorCode === "CSV_INVALID_ROW" || errorCode === "NEW_PRODUCT_FIELDS_MISSING";
}

function correctionHint(errorCode: string | null) {
  if (errorCode === "CSV_INVALID_ROW") return "Correct the CSV field identified above, then save the row to validate it again.";
  if (errorCode === "NEW_PRODUCT_FIELDS_MISSING") return "Add a product title and price for this new SKU, then save the row.";
  if (errorCode === "SKU_AMBIGUOUS") return "Use a SKU that identifies exactly one variant in Shopify.";
  if (errorCode === "SKU_LOOKUP_INCOMPLETE") return "Retry after Shopify product/location reads are available, or correct the SKU.";
  if (errorCode === "INVENTORY_NOT_TRACKED") return "Enable inventory tracking in Shopify or use a tracked variant.";
  if (errorCode === "LOCATION_NOT_STOCKED") return "Stock this variant at the selected location in Shopify, then validate again.";
  return "Review the row and selected Shopify location, correct the source data, then validate again.";
}

function verificationClassificationLabel(classification: string) {
  return classification === "SAFE_CANDIDATE" ? "Safe candidate"
    : classification === "BLOCKED" ? "Blocked"
      : classification === "UNCERTAIN" ? "Uncertain" : classification;
}

export default function ImportBatchDetail() {
const { batch, scopesVerified, missingReadScopes, missingWriteScopes, historyHref, draftNotice } = useLoaderData<typeof loader>();
  const actionData = useActionData() as {
    error?: string;
    authorizationError?: string;
    verification?: { verifiedAt: string; counts: { SAFE_CANDIDATE: number; BLOCKED: number; UNCERTAIN: number }; rows: Array<{ rowNumber: number; sku: string; classification: string; reasons: string[] }>; copyText: string };
  } | undefined;
  const [verificationFilter, setVerificationFilter] = useState("ALL");
  const [lineSearch, setLineSearch] = useState("");
  const [lineStatusFilter, setLineStatusFilter] = useState("ALL");
  const [lineTypeFilter, setLineTypeFilter] = useState("ALL");
  const [linePage, setLinePage] = useState(0);
  const [linePageSize, setLinePageSize] = useState(25);
  const [sortAscending, setSortAscending] = useState(true);
  const draftEditable = batch.status === "PREVIEWED" && batch.lines.every((line) => line.stage === "PREPARED" && ["PREVIEWED", "BLOCKED"].includes(line.status));
  const readyCount = batch.lines.filter((line) => line.status === "PREVIEWED" && line.operationType !== "BLOCKED").length;
  const warningCount = batch.lines.filter((line) => line.status === "BLOCKED" && !isCsvValidationError(line.errorCode)).length;
  const errorCount = batch.lines.filter((line) => line.status === "BLOCKED" && isCsvValidationError(line.errorCode)).length;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const verificationCopyRef = useRef<HTMLTextAreaElement>(null);
  const manualIdCopyRef = useRef<HTMLTextAreaElement>(null);
  const [idCopyFeedback, setIdCopyFeedback] = useState<{
    lineId: string;
    label: string;
    status: "copied" | "failed";
  } | null>(null);
  useEffect(() => {
    if (copyError) {
      verificationCopyRef.current?.focus();
      verificationCopyRef.current?.select();
    }
  }, [copyError]);
  useEffect(() => {
    if (idCopyFeedback?.status === "failed") {
      manualIdCopyRef.current?.focus();
      manualIdCopyRef.current?.select();
    }
  }, [idCopyFeedback]);
  const successful = batch.lines.filter((line) => line.status === "SUCCEEDED").length;
  const totalLines = batch.lines.length;
  const completionPercent = totalLines > 0 ? Math.round((successful / totalLines) * 100) : 0;
  const failed = batch.lines.filter((line) => line.status === "FAILED").length;
  const blocked = batch.lines.filter((line) => line.status === "BLOCKED" || line.operationType === "BLOCKED").length;
  const uncertain = batch.lines.filter((line) => line.status === "UNCERTAIN" || line.status === "RUNNING").length;
  const confirmedProductStages = new Set([
    "PRODUCT_CREATED", "INVENTORY_ITEM_CONFIGURING", "INVENTORY_ITEM_CONFIGURED",
    "VARIANT_PRICE_CONFIGURING", "VARIANT_PRICE_CONFIGURED", "INVENTORY_ACTIVATING",
    "INVENTORY_ACTIVE", "COMPLETED",
  ]);
  const confirmedProductsCreated = batch.lines.filter((line) =>
    line.operationType === "CREATE_DRAFT" && Boolean(line.productId) &&
    confirmedProductStages.has(line.stage),
  ).length;
  const uncertainProductCreations = batch.lines.filter((line) =>
    line.operationType === "CREATE_DRAFT" &&
    (line.errorCode === "PRODUCT_CREATE_UNCERTAIN" ||
      (line.stage === "PRODUCT_CREATING" && ["UNCERTAIN", "RUNNING"].includes(line.status))),
  ).length;
  const verificationAnnouncement = actionData?.verification
    ? "Shopify state verification complete at " + actionData.verification.verifiedAt + ". " +
      actionData.verification.counts.SAFE_CANDIDATE + " safe candidates, " +
      actionData.verification.counts.BLOCKED + " blocked, " +
      actionData.verification.counts.UNCERTAIN + " uncertain."
    : "";
  const confirmedInventoryActivated = batch.lines.filter((line) =>
    line.operationType === "CREATE_DRAFT" &&
    (line.stage === "INVENTORY_ACTIVE" || (line.stage === "COMPLETED" && line.status === "SUCCEEDED")),
  ).length;
  const createdDraftInventoryFailures = batch.lines.filter((line) =>
    line.operationType === "CREATE_DRAFT" && Boolean(line.productId) && line.status === "FAILED" &&
    (line.stage === "INVENTORY_ACTIVATING" || line.errorCode?.startsWith("INVENTORY_ACTIVATE_")),
  ).length;
  const visibleVerificationRows = actionData?.verification?.rows.filter((row) =>
    verificationFilter === "ALL" || row.classification === verificationFilter,
  ) ?? [];
  const filteredLines = useMemo(() => {
    const query = lineSearch.trim().toLowerCase();
    return batch.lines.filter((line) => {
      const matchesSearch = !query || [line.sku, line.title, line.matchedProductTitle, line.matchedVariantTitle]
        .some((value) => value?.toLowerCase().includes(query));
      const matchesStatus = ["ALL", "READY", "WARNING", "ERROR"].includes(lineStatusFilter) || line.status === lineStatusFilter;
      const matchesType = lineTypeFilter === "ALL" || line.operationType === lineTypeFilter;
      const matchesValidation = lineStatusFilter === "READY" ? line.status === "PREVIEWED" && line.operationType !== "BLOCKED"
        : lineStatusFilter === "WARNING" ? line.status === "BLOCKED" && !isCsvValidationError(line.errorCode)
          : lineStatusFilter === "ERROR" ? line.status === "BLOCKED" && isCsvValidationError(line.errorCode)
            : true;
      return matchesSearch && matchesStatus && matchesValidation && matchesType;
    }).sort((left, right) => sortAscending ? left.rowNumber - right.rowNumber : right.rowNumber - left.rowNumber);
  }, [batch.lines, lineSearch, lineStatusFilter, lineTypeFilter, sortAscending]);
  const linePageCount = Math.max(1, Math.ceil(filteredLines.length / linePageSize));
  const visibleLines = filteredLines.slice(linePage * linePageSize, (linePage + 1) * linePageSize);
  const productWriteRequired = batch.lines.some((line) =>
    line.operationType === "CREATE_DRAFT" &&
    !["SUCCEEDED", "BLOCKED"].includes(line.status) &&
    !["VARIANT_PRICE_CONFIGURED", "INVENTORY_ACTIVATING", "INVENTORY_ACTIVE"].includes(line.stage),
  );
  const hasMergeable = batch.lines.some((line) =>
    !["SUCCEEDED", "BLOCKED"].includes(line.status) && line.operationType !== "BLOCKED",
  );
  const missingRequiredWriteScopes = [
    ...(missingWriteScopes.includes("write_inventory") ? ["write_inventory"] : []),
    ...(productWriteRequired && missingWriteScopes.includes("write_products") ? ["write_products"] : []),
  ];
  const mergeDisabled = !scopesVerified || missingReadScopes.length > 0 || missingWriteScopes.includes("write_inventory") || (productWriteRequired && missingWriteScopes.includes("write_products")) || !hasMergeable;
  const mergeDisabledReason = !scopesVerified
    ? "Shopify permissions could not be verified. Refresh this page and reauthorize StockHub if the issue continues."
    : missingReadScopes.length > 0 || missingRequiredWriteScopes.length > 0
      ? `Missing Shopify permissions: ${[...missingReadScopes, ...missingRequiredWriteScopes].join(", ")}. Reauthorize StockHub before merging or resuming.`
      : !hasMergeable
          ? "There are no eligible lines left to merge or resume."
          : null;

  return (
    <div className="stockhub-receipt-card"><s-section>
      <RoutePending />
      <div className="stockhub-receipt-header">
      <s-stack direction="block" gap="small">
        <s-button href={historyHref}>← Back to History</s-button>
        <s-heading>Receipt {batch.receiptCode}</s-heading>
        <s-text>{batch.locationName} · {formatStockhubDateTime(batch.createdAt)} · <s-badge tone={statusTone(batch.status)} icon={statusIcon(batch.status)}>{batchStatusLabel(batch.status)}</s-badge></s-text>
      </s-stack>
      </div>
      {batch.status === "PREVIEWED" ? <s-banner tone="info">Draft — not sent to Shopify. Editing validates the row and reads current SKU/location data only; Shopify changes happen only after an explicit merge confirmation.</s-banner> : null}
      {draftNotice ? <div role="status" aria-live="polite">Draft row {draftNotice}.</div> : null}
      <div className="stockhub-draft-status-summary" role="group" aria-label="Draft validation summary">
        <button type="button" onClick={() => setLineStatusFilter("READY")}><strong>{readyCount}</strong><span>Ready</span></button>
        <button type="button" onClick={() => setLineStatusFilter("WARNING")}><strong>{warningCount}</strong><span>Warning</span></button>
        <button type="button" onClick={() => setLineStatusFilter("ERROR")}><strong>{errorCount}</strong><span>Error</span></button>
      </div>
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
        <s-text>Total rows: {totalLines}</s-text>
      </s-grid>
      <div className="stockhub-receipt-progress" role="group" aria-label="Import line completion">
        <div className="stockhub-receipt-progress-label">
          <strong>Import progress</strong>
          <span>{successful} of {totalLines} lines completed · {completionPercent}%</span>
        </div>
        <progress aria-label={`${successful} of ${totalLines} import lines completed`} max={Math.max(totalLines, 1)} value={successful} />
      </div>
      <div className="stockhub-receipt-summary-wrap" role="region" aria-label="Import progress summary">
        <table className="stockhub-receipt-summary">
          <caption>Import progress summary</caption>
          <thead><tr><th scope="col">Metric</th><th scope="col">Count</th></tr></thead>
          <tbody>
            <tr><th scope="row">Draft products created</th><td><span className={`stockhub-receipt-summary-count ${confirmedProductsCreated > 0 ? "stockhub-receipt-summary-count--success" : "stockhub-receipt-summary-count--neutral"}`}>{confirmedProductsCreated} confirmed</span></td></tr>
            <tr><th scope="row">Unresolved Draft product creation</th><td><span className={`stockhub-receipt-summary-count ${uncertainProductCreations > 0 ? "stockhub-receipt-summary-count--warning" : "stockhub-receipt-summary-count--neutral"}`}>{uncertainProductCreations}</span></td></tr>
            <tr><th scope="row">Inventory activated</th><td><span className={`stockhub-receipt-summary-count ${confirmedInventoryActivated > 0 ? "stockhub-receipt-summary-count--success" : "stockhub-receipt-summary-count--neutral"}`}>{confirmedInventoryActivated} confirmed</span></td></tr>
            <tr><th scope="row">Import lines completed</th><td><span className={`stockhub-receipt-summary-count ${successful > 0 ? "stockhub-receipt-summary-count--success" : "stockhub-receipt-summary-count--neutral"}`}>{successful}</span></td></tr>
            <tr><th scope="row">Failed</th><td><span className={`stockhub-receipt-summary-count ${failed > 0 ? "stockhub-receipt-summary-count--error" : "stockhub-receipt-summary-count--success"}`}>{failed}</span></td></tr>
            <tr><th scope="row">Blocked</th><td><span className={`stockhub-receipt-summary-count ${blocked > 0 ? "stockhub-receipt-summary-count--warning" : "stockhub-receipt-summary-count--success"}`}>{blocked}</span></td></tr>
            <tr><th scope="row">Uncertain</th><td><span className={`stockhub-receipt-summary-count ${uncertain > 0 ? "stockhub-receipt-summary-count--warning" : "stockhub-receipt-summary-count--success"}`}>{uncertain}</span></td></tr>
          </tbody>
        </table>
      </div>
      <s-paragraph>Product creation and inventory activation are separate stages; a created Draft product does not mean its import line or inventory step completed. Counts use persisted confirmed stage data only.</s-paragraph>
      {createdDraftInventoryFailures > 0 ? <s-banner tone="warning">Products were created, but inventory activation failed for {createdDraftInventoryFailures} Draft product{createdDraftInventoryFailures === 1 ? "" : "s"}. The saved receipt status has not been changed.</s-banner> : null}
      {actionData?.error ? <s-banner tone="critical">{actionData.error}</s-banner> : null}
      {actionData?.authorizationError ? <s-banner tone="critical">{actionData.authorizationError}</s-banner> : null}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >{verificationAnnouncement}</div>
      {actionData?.verification ? <div className="stockhub-verification-panel">
        <s-banner tone="info">Read-only Shopify snapshot at {actionData.verification.verifiedAt}. Safe candidate {actionData.verification.counts.SAFE_CANDIDATE} · Blocked {actionData.verification.counts.BLOCKED} · Uncertain {actionData.verification.counts.UNCERTAIN}. This snapshot does not authorize a future mutation.</s-banner>
        <s-button onClick={async () => {
          setCopied(false);
          setCopyError(false);
          try {
            if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable");
            await navigator.clipboard.writeText(actionData.verification!.copyText);
            setCopied(true);
          } catch {
            setCopyError(true);
          }
        }}>Copy verification result</s-button>{copied ? <div role="status">Copied.</div> : null}
        {copyError ? <><s-banner tone="warning">Could not access the clipboard. The sanitized result is focused below for manual copying.</s-banner><textarea ref={verificationCopyRef} aria-label="Sanitized verification result" readOnly value={actionData.verification.copyText} rows={8} /></> : null}
        <s-paragraph>Verification is a read-only snapshot of Shopify state at the time shown; it does not change this receipt or authorize a later merge/resume. Safe candidate means the current read checks match the expected state; blocked means a confirmed mismatch or disallowed condition; uncertain means Shopify could not confirm a required check.</s-paragraph>
        <s-select id="verification-classification-filter" label="Filter verification rows" value={verificationFilter} onChange={(event) => setVerificationFilter(event.currentTarget.value)}>
          <s-option value="ALL">All classifications ({actionData.verification.rows.length})</s-option>
          <s-option value="SAFE_CANDIDATE">Safe candidate ({actionData.verification.counts.SAFE_CANDIDATE})</s-option>
          <s-option value="BLOCKED">Blocked ({actionData.verification.counts.BLOCKED})</s-option>
          <s-option value="UNCERTAIN">Uncertain ({actionData.verification.counts.UNCERTAIN})</s-option>
        </s-select>
        <s-table variant="auto"><s-table-header-row><s-table-header listSlot="primary" format="numeric">Row</s-table-header><s-table-header listSlot="labeled" format="base">SKU</s-table-header><s-table-header listSlot="labeled" format="base">Classification</s-table-header><s-table-header listSlot="labeled" format="base">Reason</s-table-header></s-table-header-row><s-table-body>{visibleVerificationRows.map((row) => <s-table-row key={`${row.rowNumber}-${row.sku}`}><s-table-cell>{row.rowNumber}</s-table-cell><s-table-cell>{row.sku}</s-table-cell><s-table-cell>{verificationClassificationLabel(row.classification)}</s-table-cell><s-table-cell>{row.reasons.join("; ")}</s-table-cell></s-table-row>)}</s-table-body></s-table>
        {visibleVerificationRows.length === 0 ? <s-paragraph>No SKU rows match this classification.</s-paragraph> : null}
      </div> : null}
      <div className="stockhub-receipt-actions" role="group" aria-label="Receipt actions">
        <Form method="post"><input type="hidden" name="intent" value="verifyShopifyState"/><input type="hidden" name="batchId" value={batch.id}/><s-button type="submit">Verify Shopify State</s-button></Form>
      </div>
      {mergeDisabledReason ? <s-banner tone="warning">{mergeDisabledReason}</s-banner> : null}
      <s-heading>Line items</s-heading>
      {batch.lines.length || draftEditable ? <>
        {draftEditable ? <details className="stockhub-draft-add"><summary>Add a draft row</summary><Form method="post" className="stockhub-draft-form">
          <input type="hidden" name="intent" value="draftAddLine"/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="expectedUpdatedAt" value={batch.updatedAt.toISOString()}/>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
            <s-text-field label="SKU" name="sku" required/><label>Quantity<input name="quantity" type="number" min="1" required/></label>
            <s-text-field label="Product title" name="title"/><label>Price<input name="price" type="number" min="0" step="0.01"/></label>
            <s-text-field label="Description" name="description"/><label>Image URL<input name="image_url" type="url"/></label>
          </s-grid><s-button type="submit" variant="primary">Add and validate row</s-button>
        </Form></details> : null}
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
          <s-text-field label="Search line items" value={lineSearch} placeholder="Search SKU or product" onChange={(event) => { setLineSearch(event.currentTarget.value); setLinePage(0); }} />
          <s-select label="Line status" value={lineStatusFilter} onChange={(event) => { setLineStatusFilter(event.currentTarget.value); setLinePage(0); }}>
            <s-option value="ALL">All statuses</s-option>
            <s-option value="READY">Ready</s-option><s-option value="WARNING">Warning</s-option><s-option value="ERROR">Error</s-option>
            {(["PREVIEWED", "RUNNING", "SUCCEEDED", "FAILED", "BLOCKED", "UNCERTAIN"] as const).map((status) => <s-option key={status} value={status}>{statusLabel(status)}</s-option>)}
          </s-select>
          <s-select label="Operation type" value={lineTypeFilter} onChange={(event) => { setLineTypeFilter(event.currentTarget.value); setLinePage(0); }}>
            <s-option value="ALL">All operation types</s-option><s-option value="ADJUST">Inventory adjustment</s-option><s-option value="CREATE_DRAFT">Create Draft product</s-option><s-option value="BLOCKED">Blocked row</s-option>
          </s-select>
          <s-select label="Rows per page" value={String(linePageSize)} onChange={(event) => { setLinePageSize(Number(event.currentTarget.value)); setLinePage(0); }}>
            <s-option value="10">10 rows</s-option><s-option value="25">25 rows</s-option><s-option value="50">50 rows</s-option>
          </s-select>
          <s-button type="button" onClick={() => setSortAscending((ascending) => !ascending)}>Sort row number {sortAscending ? "↑" : "↓"}</s-button>
        </s-grid>
        <div className="stockhub-merge-action">
          <Form method="post" onSubmit={(event) => { if (!window.confirm(`Confirm ${batch.status === "PREVIEWED" ? "merge" : "resume"} of ${batch.lines.filter((line) => !["SUCCEEDED", "BLOCKED"].includes(line.status) && line.operationType !== "BLOCKED").length} eligible row(s) for receipt ${batch.receiptCode}? ${blocked > 0 ? `${blocked} blocked row(s) will remain in this receipt and will not be sent to Shopify.` : ""}`)) event.preventDefault(); }}><input type="hidden" name="intent" value={batch.status === "PREVIEWED" ? "merge" : "resume"}/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="confirmed" value="yes"/><input type="hidden" name="confirmedCount" value={batch.lines.filter((line) => !["SUCCEEDED", "BLOCKED"].includes(line.status) && line.operationType !== "BLOCKED").length}/>{blocked > 0 ? <input type="hidden" name="partialConfirmed" value="yes"/> : null}<s-button type="submit" variant="primary" disabled={mergeDisabled}>{batch.status === "PREVIEWED" ? "Merge" : "Resume"} eligible lines</s-button></Form>
        </div>
        <s-text>{filteredLines.length} of {batch.lines.length} line items · Page {Math.min(linePage + 1, linePageCount)} of {linePageCount}</s-text>
        <s-table variant="auto">
        <s-table-header-row><s-table-header listSlot="primary" format="base">SKU</s-table-header><s-table-header listSlot="labeled" format="base">Product / variant</s-table-header><s-table-header listSlot="labeled" format="numeric">Quantity</s-table-header><s-table-header listSlot="labeled" format="base">Progress</s-table-header><s-table-header listSlot="labeled" format="base">Details / actions</s-table-header></s-table-header-row>
        <s-table-body>{visibleLines.map((line) => <s-table-row key={line.id}>
          <s-table-cell>{line.sku}</s-table-cell><s-table-cell><s-stack direction="block" gap="small"><s-text>{line.matchedProductTitle ?? line.title ?? "—"}</s-text>{line.matchedVariantTitle ? <s-text>{line.matchedVariantTitle}</s-text> : null}</s-stack></s-table-cell><s-table-cell>{line.quantity ?? "—"}</s-table-cell><s-table-cell><s-stack direction="block" gap="small"><s-badge tone={statusTone(line.status)} icon={statusIcon(line.status)}>{statusLabel(line.status)}</s-badge><s-text>{stageLabel(line.stage, line.status, line.errorCode)}</s-text></s-stack></s-table-cell>
          <s-table-cell>
            {line.status === "BLOCKED" ? <s-banner tone={isCsvValidationError(line.errorCode) ? "critical" : "warning"}>{isCsvValidationError(line.errorCode) ? "CSV validation" : "Shopify match validation"} · {line.errorDetail ?? line.errorCode}<s-paragraph>{correctionHint(line.errorCode)}</s-paragraph></s-banner> : null}
            {["FAILED", "UNCERTAIN"].includes(line.status) ? <s-banner tone={line.status === "UNCERTAIN" ? "warning" : "critical"}>Shopify execution · {line.errorDetail ?? line.errorCode ?? stageLabel(line.stage, line.status, line.errorCode)}</s-banner> : null}
            {line.errorDetail || line.errorCode ? <details>
              <summary>Error details</summary>
              <div style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>
                <s-paragraph>{line.errorDetail ?? line.errorCode}</s-paragraph>
              </div>
            </details> : null}
            {draftEditable && ["PREVIEWED", "BLOCKED"].includes(line.status) ? <details><summary>Edit draft row {line.rowNumber}</summary><Form method="post" className="stockhub-draft-form">
              <input type="hidden" name="intent" value="draftEditLine"/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="lineId" value={line.id}/><input type="hidden" name="expectedUpdatedAt" value={batch.updatedAt.toISOString()}/>
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
                <s-text-field label="SKU" name="sku" value={line.sku} required/><label>Quantity<input name="quantity" type="number" min="1" value={line.quantity === null ? "" : String(line.quantity)} required/></label>
                <s-text-field label="Product title" name="title" value={line.title ?? ""}/><label>Price<input name="price" type="number" min="0" step="0.01" value={line.price ?? ""}/></label>
                <s-text-field label="Description" name="description" value={line.description ?? ""}/><label>Image URL<input name="image_url" type="url" value={line.imageUrl ?? ""}/></label>
              </s-grid><s-button type="submit" variant="primary">Save and revalidate</s-button>
            </Form><Form method="post" onSubmit={(event) => { if (!window.confirm(`Remove draft row ${line.rowNumber} (${line.sku})? This does not change Shopify.`)) event.preventDefault(); }}>
              <input type="hidden" name="intent" value="draftDeleteLine"/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="lineId" value={line.id}/><input type="hidden" name="expectedUpdatedAt" value={batch.updatedAt.toISOString()}/><s-button type="submit">Delete draft row</s-button>
            </Form></details> : null}
            <details>
              <summary>Technical details</summary>
              <s-stack direction="block" gap="small">
                <div style={{ overflowWrap: "anywhere", wordBreak: "break-all" }}>
                  <code>Product ID: {line.productId}</code>
                  <s-button
                    type="button"
                    disabled={!line.productId}
                    accessibilityLabel="Copy Product ID"
                    onClick={async () => {
                      setIdCopyFeedback(null);
                      try {
                        if (!line.productId || !navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
                        await navigator.clipboard.writeText(line.productId);
                        setIdCopyFeedback({ lineId: line.id, label: "Product ID", status: "copied" });
                      } catch {
                        setIdCopyFeedback({ lineId: line.id, label: "Product ID", status: "failed" });
                      }
                    }}
                  >Copy Product ID</s-button>
                  {idCopyFeedback?.lineId === line.id && idCopyFeedback.label === "Product ID" && idCopyFeedback.status === "failed" ? (
                    <div role="alert">
                      <span>Could not access the clipboard. Select and copy the ID manually.</span>
                      <textarea ref={manualIdCopyRef} aria-label="Product ID for manual copy" readOnly value={line.productId ?? ""} rows={2} onFocus={(event) => event.currentTarget.select()} />
                    </div>
                  ) : null}
                </div>
                <div style={{ overflowWrap: "anywhere", wordBreak: "break-all" }}>
                  <code>Variant ID: {line.variantId}</code>
                  <s-button
                    type="button"
                    disabled={!line.variantId}
                    accessibilityLabel="Copy Variant ID"
                    onClick={async () => {
                      setIdCopyFeedback(null);
                      try {
                        if (!line.variantId || !navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
                        await navigator.clipboard.writeText(line.variantId);
                        setIdCopyFeedback({ lineId: line.id, label: "Variant ID", status: "copied" });
                      } catch {
                        setIdCopyFeedback({ lineId: line.id, label: "Variant ID", status: "failed" });
                      }
                    }}
                  >Copy Variant ID</s-button>
                  {idCopyFeedback?.lineId === line.id && idCopyFeedback.label === "Variant ID" && idCopyFeedback.status === "failed" ? (
                    <div role="alert">
                      <span>Could not access the clipboard. Select and copy the ID manually.</span>
                      <textarea ref={manualIdCopyRef} aria-label="Variant ID for manual copy" readOnly value={line.variantId ?? ""} rows={2} onFocus={(event) => event.currentTarget.select()} />
                    </div>
                  ) : null}
                </div>
                <div style={{ overflowWrap: "anywhere", wordBreak: "break-all" }}>
                  <code>Inventory Item ID: {line.inventoryItemId}</code>
                  <s-button
                    type="button"
                    disabled={!line.inventoryItemId}
                    accessibilityLabel="Copy Inventory Item ID"
                    onClick={async () => {
                      setIdCopyFeedback(null);
                      try {
                        if (!line.inventoryItemId || !navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
                        await navigator.clipboard.writeText(line.inventoryItemId);
                        setIdCopyFeedback({ lineId: line.id, label: "Inventory Item ID", status: "copied" });
                      } catch {
                        setIdCopyFeedback({ lineId: line.id, label: "Inventory Item ID", status: "failed" });
                      }
                    }}
                  >Copy Inventory Item ID</s-button>
                  {idCopyFeedback?.lineId === line.id && idCopyFeedback.label === "Inventory Item ID" && idCopyFeedback.status === "failed" ? (
                    <div role="alert">
                      <span>Could not access the clipboard. Select and copy the ID manually.</span>
                      <textarea ref={manualIdCopyRef} aria-label="Inventory Item ID for manual copy" readOnly value={line.inventoryItemId ?? ""} rows={2} onFocus={(event) => event.currentTarget.select()} />
                    </div>
                  ) : null}
                </div>
                {idCopyFeedback?.lineId === line.id && idCopyFeedback.status === "copied" ? (
                  <div role="status">Copied {idCopyFeedback.label}.</div>
                ) : null}
                <div style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>
                  <s-paragraph>Operation stage: {line.stage} · Error code: {line.errorCode ?? "—"}</s-paragraph>
                </div>
              </s-stack>
            </details>
          </s-table-cell>
        </s-table-row>)}</s-table-body>
        </s-table>
        {visibleLines.length === 0 ? <s-paragraph>No line items match these filters.</s-paragraph> : null}
        {linePageCount > 1 ? <s-button-group gap="base" accessibilityLabel="Receipt line pagination">
          <s-button disabled={linePage === 0} onClick={() => setLinePage((page) => Math.max(0, page - 1))}>Previous</s-button>
          <s-button disabled={linePage + 1 >= linePageCount} onClick={() => setLinePage((page) => Math.min(linePageCount - 1, page + 1))}>Next</s-button>
        </s-button-group> : null}
      </> : <s-paragraph>No import lines are recorded for this receipt.</s-paragraph>}
    </s-section></div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
