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
  return { batch, scopesVerified, missingReadScopes, missingWriteScopes, shop: session.shop, historyHref: `/app/imports/history${url.search}` };
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

function verificationClassificationLabel(classification: string) {
  return classification === "SAFE_CANDIDATE" ? "Safe candidate"
    : classification === "BLOCKED" ? "Blocked"
      : classification === "UNCERTAIN" ? "Uncertain" : classification;
}

export default function ImportBatchDetail() {
const { batch, scopesVerified, missingReadScopes, missingWriteScopes, historyHref } = useLoaderData<typeof loader>();
  const actionData = useActionData() as {
    error?: string;
    authorizationError?: string;
    verification?: { verifiedAt: string; counts: { SAFE_CANDIDATE: number; BLOCKED: number; UNCERTAIN: number }; rows: Array<{ rowNumber: number; sku: string; classification: string; reasons: string[] }>; copyText: string };
  } | undefined;
  const [verificationFilter, setVerificationFilter] = useState("ALL");
  const [lineSearch, setLineSearch] = useState("");
  const [lineStatusFilter, setLineStatusFilter] = useState("ALL");
  const [linePage, setLinePage] = useState(0);
  const linePageSize = 25;
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
      const matchesStatus = lineStatusFilter === "ALL" || line.status === lineStatusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [batch.lines, lineSearch, lineStatusFilter]);
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
  const blockedPreview = batch.status === "PREVIEWED" && blocked > 0;
  const mergeDisabled = !scopesVerified || missingReadScopes.length > 0 || missingWriteScopes.includes("write_inventory") || (productWriteRequired && missingWriteScopes.includes("write_products")) || (batch.status === "PREVIEWED" && blocked > 0) || !hasMergeable;
  const mergeDisabledReason = !scopesVerified
    ? "Shopify permissions could not be verified. Refresh this page and reauthorize StockHub if the issue continues."
    : missingReadScopes.length > 0 || missingRequiredWriteScopes.length > 0
      ? `Missing Shopify permissions: ${[...missingReadScopes, ...missingRequiredWriteScopes].join(", ")}. Reauthorize StockHub before merging or resuming.`
      : blockedPreview
        ? "This preview contains blocked rows. Correct the CSV and create a new preview before merging."
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
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base" accessibilityRole="region" accessibilityLabel="Import progress summary">
        <s-text>Draft products created: {confirmedProductsCreated} confirmed</s-text>
        <s-text>Unresolved Draft product creation: {uncertainProductCreations}</s-text>
        <s-text>Inventory activated: {confirmedInventoryActivated} confirmed</s-text>
        <s-text>Import lines completed: {successful}</s-text>
        <s-text>Failed: {failed} · Blocked: {blocked} · Uncertain: {uncertain}</s-text>
      </s-grid>
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
      <s-button-group gap="base" accessibilityLabel="Receipt actions">
        <Form method="post"><input type="hidden" name="intent" value="verifyShopifyState"/><input type="hidden" name="batchId" value={batch.id}/><s-button type="submit">Verify Shopify State</s-button></Form>
        <Form method="post" onSubmit={(event) => { if (!window.confirm(`Confirm ${batch.status === "PREVIEWED" ? "merge" : "resume"} for receipt ${batch.receiptCode} in ${batch.shop}?`)) event.preventDefault(); }}><input type="hidden" name="intent" value={batch.status === "PREVIEWED" ? "merge" : "resume"}/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="confirmed" value="yes"/><s-button type="submit" disabled={mergeDisabled}>{batch.status === "PREVIEWED" ? "Merge" : "Resume"} eligible lines</s-button></Form>
      </s-button-group>
      {mergeDisabledReason ? <s-banner tone="warning">{mergeDisabledReason}</s-banner> : null}
      <s-heading>Line items</s-heading>
      {batch.lines.length ? <>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
          <s-text-field label="Search line items" value={lineSearch} placeholder="Search SKU or product" onChange={(event) => { setLineSearch(event.currentTarget.value); setLinePage(0); }} />
          <s-select label="Line status" value={lineStatusFilter} onChange={(event) => { setLineStatusFilter(event.currentTarget.value); setLinePage(0); }}>
            <s-option value="ALL">All statuses</s-option>
            {(["PREVIEWED", "RUNNING", "SUCCEEDED", "FAILED", "BLOCKED", "UNCERTAIN"] as const).map((status) => <s-option key={status} value={status}>{statusLabel(status)}</s-option>)}
          </s-select>
        </s-grid>
        <s-text>{filteredLines.length} of {batch.lines.length} line items · Page {Math.min(linePage + 1, linePageCount)} of {linePageCount}</s-text>
        <s-table variant="auto">
        <s-table-header-row><s-table-header listSlot="primary" format="base">SKU</s-table-header><s-table-header listSlot="labeled" format="base">Product</s-table-header><s-table-header listSlot="labeled" format="numeric">Quantity</s-table-header><s-table-header listSlot="labeled" format="base">Progress</s-table-header><s-table-header listSlot="labeled" format="base">Details</s-table-header></s-table-header-row>
        <s-table-body>{visibleLines.map((line) => <s-table-row key={line.id}>
          <s-table-cell>{line.sku}</s-table-cell><s-table-cell>{line.matchedProductTitle ?? line.title ?? "—"}</s-table-cell><s-table-cell>{line.quantity ?? "—"}</s-table-cell><s-table-cell><s-stack direction="block" gap="small"><s-badge tone={statusTone(line.status)} icon={statusIcon(line.status)}>{statusLabel(line.status)}</s-badge><s-text>{stageLabel(line.stage, line.status, line.errorCode)}</s-text></s-stack></s-table-cell>
          <s-table-cell>
            {line.errorDetail || line.errorCode ? <details>
              <summary>Error details</summary>
              <div style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>
                <s-paragraph>{line.errorDetail ?? line.errorCode}</s-paragraph>
              </div>
            </details> : null}
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
