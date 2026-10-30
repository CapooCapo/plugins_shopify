import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
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
  // The original upload is retained for server-side audit/recovery, not needed by
  // the rendered receipt page. Avoid sending a potentially 1 MB source file to
  // the browser on every navigation/revalidation.
  const { originalCsv: _originalCsv, ...pageBatch } = batch;
  void _originalCsv;
  const mergeApproval = batch.activeMergeApprovalId
    ? await prisma.importMergeApproval.findFirst({
        where: { id: batch.activeMergeApprovalId, shop: session.shop, batchId: batch.id },
        select: { id: true, mode: true, status: true, chunkNumber: true, processedCount: true, snapshotJson: true },
      })
    : null;
  let approvedLineCount = 0;
  if (mergeApproval) {
    try {
      const snapshot = JSON.parse(mergeApproval.snapshotJson) as { lines?: unknown[] };
      approvedLineCount = Array.isArray(snapshot.lines) ? snapshot.lines.length : 0;
    } catch { /* The action fails closed and the UI will offer only a refresh/review path. */ }
  }
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
  const mergeApprovalForPage = mergeApproval ? {
    id: mergeApproval.id,
    mode: mergeApproval.mode,
    status: mergeApproval.status,
    chunkNumber: mergeApproval.chunkNumber,
    processedCount: mergeApproval.processedCount,
    approvedLineCount,
  } : null;
  return { batch: pageBatch, mergeApproval: mergeApprovalForPage, scopesVerified, missingReadScopes, missingWriteScopes, shop: session.shop, historyHref: `/app/imports/history${url.search}`, draftNotice: url.searchParams.get("draft") };
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

function validationGroup(line: { status: string; operationType: string; errorCode: string | null; errorDetail: string | null }) {
  if (line.status === "SUCCEEDED") return "COMPLETED";
  if (line.status === "PREVIEWED" && line.operationType !== "BLOCKED") return "READY";
  if (line.status === "BLOCKED" && (line.errorCode === "NEW_PRODUCT_FIELDS_MISSING" || /missing|required/i.test(line.errorDetail ?? ""))) return "MISSING";
  return "ERROR";
}

function validationPresentation(
  line: { status: string; operationType: string; errorCode: string | null; errorDetail: string | null },
  executionStarted: boolean,
) {
  if (executionStarted) {
    return line.operationType === "BLOCKED"
      ? { label: "Blocked in preview", tone: "warning" as const }
      : { label: "Passed preview", tone: "success" as const };
  }
  const group = validationGroup(line);
  if (group === "READY") return { label: "Ready", tone: "success" as const };
  if (group === "MISSING") return { label: "Missing info", tone: "warning" as const };
  return { label: "Error", tone: "critical" as const };
}

function correctionHint(errorCode: string | null) {
  if (errorCode === "CSV_INVALID_ROW") return "Correct the CSV field identified above, then save the row to validate it again.";
  if (errorCode === "NEW_PRODUCT_FIELDS_MISSING") return "Add a product title and price for this new SKU, then save the row.";
  if (errorCode === "SKU_AMBIGUOUS") return "Use a SKU that identifies exactly one variant in Shopify.";
  if (errorCode === "SKU_LOOKUP_INCOMPLETE") return "Retry after Shopify product/location reads are available, or correct the SKU.";
  if (errorCode === "INVENTORY_NOT_TRACKED") return "If this variant should be stocked, enable inventory tracking in Shopify Admin (Track quantity), then revalidate this row.";
  if (errorCode === "LOCATION_NOT_STOCKED") return "Stock this variant at the selected location in Shopify, then validate again.";
  return "Review the row and selected Shopify location, correct the source data, then validate again.";
}

function validationIssueKey(line: { errorCode: string | null; errorDetail: string | null }) {
  const normalizedDetail = (line.errorDetail ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedCode = line.errorCode?.trim().toUpperCase();
  if (normalizedCode || normalizedDetail) {
    return `code:${normalizedCode || "unspecified"}|detail:${normalizedDetail || "unspecified validation issue"}`;
  }
  return "code:unspecified|detail:unspecified validation issue";
}

function validationIssueLabel(line: { errorCode: string | null; errorDetail: string | null }) {
  if (line.errorDetail?.trim()) return line.errorDetail.trim();
  return line.errorCode?.trim().replaceAll("_", " ").toLowerCase() || "Validation needs review";
}

function verificationClassificationLabel(classification: string) {
  return classification === "SAFE_CANDIDATE" ? "Safe candidate"
    : classification === "BLOCKED" ? "Blocked"
      : classification === "UNCERTAIN" ? "Uncertain" : classification;
}

type ReceiptProgressLine = {
  status: string;
  operationType: string;
  stage: string;
  productId: string | null;
  errorCode: string | null;
};

export function summarizeReceiptProgress(lines: ReceiptProgressLine[]) {
  const successful = lines.filter((line) => line.status === "SUCCEEDED").length;
  const failed = lines.filter((line) => line.status === "FAILED").length;
  const blocked = lines.filter((line) => line.status === "BLOCKED" || line.operationType === "BLOCKED").length;
  const uncertain = lines.filter((line) => line.status === "UNCERTAIN" || line.status === "RUNNING").length;
  const confirmedProductStages = new Set([
    "PRODUCT_CREATED", "INVENTORY_ITEM_CONFIGURING", "INVENTORY_ITEM_CONFIGURED",
    "VARIANT_PRICE_CONFIGURING", "VARIANT_PRICE_CONFIGURED", "INVENTORY_ACTIVATING",
    "INVENTORY_ACTIVE", "COMPLETED",
  ]);
  const confirmedProductsCreated = lines.filter((line) =>
    line.operationType === "CREATE_DRAFT" && Boolean(line.productId) && confirmedProductStages.has(line.stage),
  ).length;
  const uncertainProductCreations = lines.filter((line) =>
    line.operationType === "CREATE_DRAFT" && (line.errorCode === "PRODUCT_CREATE_UNCERTAIN" ||
      (line.stage === "PRODUCT_CREATING" && ["UNCERTAIN", "RUNNING"].includes(line.status))),
  ).length;
  const confirmedInventoryActivated = lines.filter((line) =>
    line.operationType === "CREATE_DRAFT" &&
    (line.stage === "INVENTORY_ACTIVE" || (line.stage === "COMPLETED" && line.status === "SUCCEEDED")),
  ).length;
  const confirmedInventoryAdjustments = lines.filter((line) =>
    line.operationType === "ADJUST" && line.status === "SUCCEEDED" && line.stage === "COMPLETED",
  ).length;
  const createdDraftInventoryFailures = lines.filter((line) =>
    line.operationType === "CREATE_DRAFT" && Boolean(line.productId) && line.status === "FAILED" &&
    (line.stage === "INVENTORY_ACTIVATING" || line.errorCode?.startsWith("INVENTORY_ACTIVATE_")),
  ).length;
  const eligibleCount = lines.filter((line) => !["SUCCEEDED", "BLOCKED"].includes(line.status) && line.operationType !== "BLOCKED").length;
  return {
    totalLines: lines.length,
    successful,
    completionPercent: lines.length > 0 ? Math.round((successful / lines.length) * 100) : 0,
    failed,
    blocked,
    uncertain,
    confirmedProductsCreated,
    uncertainProductCreations,
    confirmedInventoryActivated,
    confirmedInventoryAdjustments,
    createdDraftInventoryFailures,
    eligibleCount,
  };
}

export function noEligibleReceiptMessage(summary: Pick<ReturnType<typeof summarizeReceiptProgress>,
  "totalLines" | "successful" | "failed" | "blocked" | "uncertain">, context: {
    batchStatus?: string;
    executionStarted?: boolean;
  } = {}) {
  const unresolved = summary.failed + summary.blocked + summary.uncertain;
  if (context.batchStatus === "PREVIEWED" && context.executionStarted === false) {
    return {
      title: "No rows are ready to merge",
      detail: summary.blocked > 0 || summary.failed > 0
        ? `${summary.blocked} row${summary.blocked === 1 ? " is" : "s are"} blocked by preview validation${summary.failed > 0 ? `; ${summary.failed} row${summary.failed === 1 ? " has" : "s have"} validation error${summary.failed === 1 ? "" : "s"}` : ""}. Review and correct the row details, then revalidate before merging.`
        : "This preview has no rows ready for Merge. Review the row details, correct any validation issues, then revalidate.",
      tone: unresolved > 0 ? "attention" as const : "neutral" as const,
    };
  }
  if (summary.totalLines > 0 && summary.successful === summary.totalLines && unresolved === 0) {
    return {
      title: "Import lines complete",
      detail: `All ${summary.totalLines} import lines completed. No lines remain eligible to merge or resume. Product creation and inventory stages are listed separately above.`,
      tone: "success" as const,
    };
  }
  if (unresolved > 0) {
    return {
      title: "No lines are eligible to resume",
      detail: `${summary.failed} failed, ${summary.blocked} blocked, and ${summary.uncertain} uncertain or in-progress. Review the line details below and verify Shopify state before taking further action.`,
      tone: "attention" as const,
    };
  }
  return {
    title: summary.totalLines === 0 ? "No import rows are available" : "No lines remain eligible",
    detail: "This receipt has no rows ready for a merge or resume action. You can still review its line history and verify the current Shopify state.",
    tone: "neutral" as const,
  };
}

export default function ImportBatchDetail() {
const { batch, mergeApproval, scopesVerified, missingReadScopes, missingWriteScopes, historyHref, draftNotice, shop } = useLoaderData<typeof loader>();
  const actionData = useActionData() as {
    error?: string;
    authorizationError?: string;
    verification?: { verifiedAt: string; counts: { SAFE_CANDIDATE: number; BLOCKED: number; UNCERTAIN: number }; rows: Array<{ rowNumber: number; sku: string; classification: string; reasons: string[] }>; copyText: string };
  } | undefined;
  const mergeFetcher = useFetcher<{
    error?: string;
    mergeProgress?: { batchId: string; approvalId: string | null; approvalStatus: string | null; chunkNumber: number; continueRequired: boolean; status: string };
  }>();
  const pauseFetcher = useFetcher<{
    error?: string;
    mergeProgress?: { batchId: string; approvalId: string | null; approvalStatus: string | null; chunkNumber: number; continueRequired: boolean; status: string; paused?: boolean };
  }>();
  const autoPausedRef = useRef(false);
  const lastAutoChunkRef = useRef("");
  const [verificationFilter, setVerificationFilter] = useState("ALL");
  const [lineSearch, setLineSearch] = useState("");
  const [lineStatusFilter, setLineStatusFilter] = useState("ALL");
  const [lineTypeFilter, setLineTypeFilter] = useState("ALL");
  const [errorGroupFilter, setErrorGroupFilter] = useState<string | null>(null);
  const [linePage, setLinePage] = useState(0);
  const linePageSize = 25;
  const [sortAscending, setSortAscending] = useState(true);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [revalidationLineId, setRevalidationLineId] = useState<string | null>(null);
  const [inspectorMode, setInspectorMode] = useState<"details" | "edit" | "add" | "delete">("details");
  const [mergeConfirmationRevision, setMergeConfirmationRevision] = useState<string | null>(null);
  const [drawerDirty, setDrawerDirty] = useState(false);
  const [discardConfirming, setDiscardConfirming] = useState(false);
  const [discardForDelete, setDiscardForDelete] = useState(false);
  const [draftValues, setDraftValues] = useState({ sku: "", quantity: "", title: "", price: "", description: "", image_url: "" });
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const inspectorTriggerRef = useRef<HTMLElement | null>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const draftSaveInFlightRef = useRef(false);
  const navigation = useNavigation();
  useEffect(() => {
    const progress = mergeFetcher.data?.mergeProgress;
    if (mergeFetcher.state !== "idle" || !progress?.continueRequired || progress.approvalStatus !== "ACTIVE" || !progress.approvalId || autoPausedRef.current) return;
    const key = `${progress.approvalId}:${progress.chunkNumber}`;
    if (lastAutoChunkRef.current === key) return;
    lastAutoChunkRef.current = key;
    mergeFetcher.submit({ intent: "continueMerge", batchId: batch.id, approvalId: progress.approvalId }, { method: "post" });
  // useFetcher.submit is stable; depending on its data/state fields avoids effect churn on the fetcher wrapper.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.id, mergeFetcher.data, mergeFetcher.state, mergeFetcher.submit]);
  const selectedLine = batch.lines.find((line) => line.id === selectedLineId) ?? null;
  const revalidationLine = batch.lines.find((line) => line.id === revalidationLineId) ?? null;
  const draftEditable = batch.status === "PREVIEWED" && batch.lines.every((line) => line.stage === "PREPARED" && ["PREVIEWED", "BLOCKED"].includes(line.status));
  const readyCount = batch.lines.filter((line) => validationGroup(line) === "READY").length;
  const missingCount = batch.lines.filter((line) => validationGroup(line) === "MISSING").length;
  const errorCount = batch.lines.filter((line) => validationGroup(line) === "ERROR").length;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const verificationCopyRef = useRef<HTMLTextAreaElement>(null);
  const manualIdCopyRef = useRef<HTMLTextAreaElement>(null);
  const [idCopyFeedback, setIdCopyFeedback] = useState<{ label: string; status: "copied" | "failed" } | null>(null);
  useEffect(() => {
    if (copyError) {
      verificationCopyRef.current?.focus();
      verificationCopyRef.current?.select();
    }
  }, [copyError]);
  useEffect(() => {
    if (selectedLineId || inspectorMode === "add") drawerCloseRef.current?.focus();
  }, [selectedLineId, inspectorMode]);
  useEffect(() => {
    if (!selectedLineId && inspectorMode !== "add") return;
    setDraftValues({
      sku: selectedLine?.sku ?? "",
      quantity: selectedLine?.quantity?.toString() ?? "",
      title: selectedLine?.title ?? "",
      price: selectedLine?.price?.toString() ?? "",
      description: selectedLine?.description ?? "",
      image_url: selectedLine?.imageUrl ?? "",
    });
    setDrawerDirty(false);
    setDiscardConfirming(false);
    setDiscardForDelete(false);
  // A newly selected row/mode is a fresh editing session; do not reset while typing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLineId, inspectorMode]);
  useEffect(() => {
    if (!draftNotice) return;
    setSelectedLineId(null);
    setInspectorMode("details");
    setDrawerDirty(false);
  }, [draftNotice]);
  const draftConflict = Boolean(actionData?.error && /draft changed|refresh before continuing/i.test(actionData.error));
  useEffect(() => {
    if (draftConflict) conflictRef.current?.focus();
  }, [draftConflict]);
  useEffect(() => {
    if (idCopyFeedback?.status === "failed") {
      manualIdCopyRef.current?.focus();
      manualIdCopyRef.current?.select();
    }
  }, [idCopyFeedback]);
  const progressSummary = summarizeReceiptProgress(batch.lines);
  const lineItems = batch.lines;
  const { successful, totalLines, completionPercent, failed, blocked, uncertain,
    confirmedProductsCreated, uncertainProductCreations, confirmedInventoryActivated,
    confirmedInventoryAdjustments, createdDraftInventoryFailures, eligibleCount } = progressSummary;
  const hideStaleMergeConfirmationError = eligibleCount === 0 &&
    actionData?.error === "Confirm the current number of eligible rows and any excluded rows before merging.";
  const verificationAnnouncement = actionData?.verification
    ? "Shopify state verification complete at " + actionData.verification.verifiedAt + ". " +
      actionData.verification.counts.SAFE_CANDIDATE + " safe candidates, " +
      actionData.verification.counts.BLOCKED + " blocked, " +
      actionData.verification.counts.UNCERTAIN + " uncertain."
    : "";
  const visibleVerificationRows = actionData?.verification?.rows.filter((row) =>
    verificationFilter === "ALL" || row.classification === verificationFilter,
  ) ?? [];
  const validationErrorGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; hint: string; lines: typeof lineItems }>();
    for (const line of lineItems) {
      if (validationGroup(line) !== "ERROR") continue;
      const key = validationIssueKey(line);
      const group = groups.get(key);
      if (group) group.lines.push(line);
      else groups.set(key, {
        key,
        label: validationIssueLabel(line),
        hint: correctionHint(line.errorCode),
        lines: [line],
      });
    }
    return [...groups.values()].sort((left, right) => right.lines.length - left.lines.length);
  }, [lineItems]);
  const filteredLines = useMemo(() => {
    const query = lineSearch.trim().toLowerCase();
    return lineItems.filter((line) => {
      const matchesSearch = !query || [line.sku, line.title, line.matchedProductTitle, line.matchedVariantTitle]
        .some((value) => value?.toLowerCase().includes(query));
      const matchesStatus = ["ALL", "READY", "MISSING", "ERROR"].includes(lineStatusFilter) || line.status === lineStatusFilter;
      const matchesType = lineTypeFilter === "ALL" || line.operationType === lineTypeFilter;
      const matchesValidation = ["READY", "MISSING", "ERROR"].includes(lineStatusFilter)
        ? validationGroup(line) === lineStatusFilter : true;
      const matchesErrorGroup = errorGroupFilter === null || validationIssueKey(line) === errorGroupFilter;
      return matchesSearch && matchesStatus && matchesValidation && matchesType && matchesErrorGroup;
    }).sort((left, right) => sortAscending ? left.rowNumber - right.rowNumber : right.rowNumber - left.rowNumber);
  }, [lineItems, lineSearch, lineStatusFilter, lineTypeFilter, errorGroupFilter, sortAscending]);
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
  const hasResumeOnlyWork = batch.lines.some((line) =>
    ["FAILED", "UNCERTAIN", "RUNNING"].includes(line.status) && line.operationType !== "BLOCKED",
  );
  const initialMergeIntent = hasResumeOnlyWork ? "resume" : "merge";
  const initialMergeLabel = initialMergeIntent === "resume" ? "Resume" : "Merge";
  const approvalNeedsContinuation = Boolean(mergeApproval && ["ACTIVE", "PAUSED"].includes(mergeApproval.status));
  const missingRequiredWriteScopes = [
    ...(missingWriteScopes.includes("write_inventory") ? ["write_inventory"] : []),
    ...(productWriteRequired && missingWriteScopes.includes("write_products") ? ["write_products"] : []),
  ];
  const mergeDisabled = !scopesVerified || missingReadScopes.length > 0 || missingWriteScopes.includes("write_inventory") || (productWriteRequired && missingWriteScopes.includes("write_products")) || !hasMergeable || approvalNeedsContinuation;
  const mergeDisabledReason = !hasMergeable ? null : !scopesVerified
    ? "Shopify permissions could not be verified. Refresh this page and reauthorize StockHub if the issue continues."
    : missingReadScopes.length > 0 || missingRequiredWriteScopes.length > 0
      ? `Missing Shopify permissions: ${[...missingReadScopes, ...missingRequiredWriteScopes].join(", ")}. Reauthorize StockHub before merging or resuming.`
      : null;
  const executionStarted = batch.status !== "PREVIEWED" || batch.lines.some((line) => line.stage !== "PREPARED" || line.status === "SUCCEEDED");
  const mergeEligibilityRevision = JSON.stringify([
    batch.updatedAt.toISOString(),
    batch.lines.map((line) => [line.id, line.status, line.stage, line.operationType]),
    eligibleCount,
    blocked,
  ]);
  const mergeConfirming = eligibleCount > 0 && mergeConfirmationRevision === mergeEligibilityRevision;
  useEffect(() => {
    if (mergeConfirmationRevision && mergeConfirmationRevision !== mergeEligibilityRevision) {
      setMergeConfirmationRevision(null);
    }
  }, [mergeConfirmationRevision, mergeEligibilityRevision]);
  const noEligibleMessage = noEligibleReceiptMessage(progressSummary, { batchStatus: batch.status, executionStarted });
  const savingDraft = ["draftAddLine", "draftEditLine", "draftDeleteLine"].includes(String(navigation.formData?.get("intent") ?? ""));
  useEffect(() => {
    if (savingDraft) {
      draftSaveInFlightRef.current = true;
      return;
    }
    if (draftSaveInFlightRef.current && !actionData?.error && !actionData?.authorizationError) {
      setSelectedLineId(null);
      setInspectorMode("details");
      setDrawerDirty(false);
    }
    draftSaveInFlightRef.current = false;
  }, [savingDraft, actionData?.error, actionData?.authorizationError]);
  const openInspector = (lineId: string, mode: "details" | "edit" | "delete" = "details", trigger?: HTMLElement | null) => {
    inspectorTriggerRef.current = trigger ?? null;
    setRevalidationLineId(lineId);
    setSelectedLineId(lineId);
    setInspectorMode(mode);
  };
  const finishCloseInspector = () => {
    setSelectedLineId(null);
    setInspectorMode("details");
    setDrawerDirty(false);
    setDiscardConfirming(false);
    setDiscardForDelete(false);
    requestAnimationFrame(() => inspectorTriggerRef.current?.focus());
  };
  const requestCloseInspector = () => {
    if ((inspectorMode === "edit" || inspectorMode === "add") && drawerDirty && !savingDraft) {
      setDiscardForDelete(false);
      setDiscardConfirming(true);
      return;
    }
    finishCloseInspector();
  };
  useEffect(() => {
    if (!selectedLine && inspectorMode !== "add") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestCloseInspector();
      }
      if (event.key !== "Tab" || !inspectorRef.current) return;
      const focusable = inspectorRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), s-button:not([disabled]), s-text-field:not([disabled]), s-select:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  // requestCloseInspector intentionally follows the current dirty/save state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLine, inspectorMode, drawerDirty, savingDraft]);
  const copyIdentifier = async (label: string, value: string | null) => {
    setIdCopyFeedback(null);
    try {
      if (!value || !navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setIdCopyFeedback({ label, status: "copied" });
    } catch {
      setIdCopyFeedback({ label, status: "failed" });
    }
  };
  const renderRowActions = (line: (typeof batch.lines)[number]) => (
    <div className="stockhub-row-actions">
      <button type="button" className="stockhub-icon-action" title={`Open details for row ${line.rowNumber}`} aria-label={`Open details for row ${line.rowNumber}`} onClick={(event) => openInspector(line.id, "details", event.currentTarget)}>
        <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg>
      </button>
      {draftEditable && ["PREVIEWED", "BLOCKED"].includes(line.status) ? <>
        <button type="button" className="stockhub-icon-action" title={`Edit row ${line.rowNumber}`} aria-label={`Edit row ${line.rowNumber}`} onClick={(event) => openInspector(line.id, "edit", event.currentTarget)}>
          <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m14 5 5 5M4 20l4.2-.9L19 8.3a2.1 2.1 0 0 0-3-3L5.2 16.1 4 20Z"/></svg>
        </button>
        <button type="button" className="stockhub-icon-action" title={`Delete row ${line.rowNumber}`} aria-label={`Delete row ${line.rowNumber}`} onClick={(event) => openInspector(line.id, "delete", event.currentTarget)}>
          <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>
        </button>
      </> : null}
    </div>
  );

  return (
    <div className="stockhub-receipt-card"><s-section>
      <RoutePending />
      <header className="stockhub-receipt-header">
        <div className="stockhub-receipt-header__main">
          <a className="stockhub-receipt-back" href={historyHref}>← Import history</a>
          <div className="stockhub-receipt-heading-row">
            <div><span className="stockhub-receipt-eyebrow">Import receipt</span><s-heading>{batch.receiptCode}</s-heading></div>
            <s-badge tone={statusTone(batch.status)} icon={statusIcon(batch.status)}>{batchStatusLabel(batch.status)}</s-badge>
          </div>
          <dl className="stockhub-receipt-metadata">
            <div><dt>Location</dt><dd>{batch.locationName}</dd></div>
            <div><dt>Created</dt><dd>{formatStockhubDateTime(batch.createdAt)}</dd></div>
          </dl>
        </div>
        <div className="stockhub-receipt-header__actions" role="group" aria-label="Receipt actions">
          <Form method="post"><input type="hidden" name="intent" value="verifyShopifyState"/><input type="hidden" name="batchId" value={batch.id}/><s-button type="submit">Verify Shopify State</s-button></Form>
        </div>
      </header>
      {batch.status === "PREVIEWED" ? <p className="stockhub-receipt-draft-note"><strong>Preview only.</strong> No Shopify changes have been made. Editing validates the row and reads current SKU/location data; inventory or product changes require explicit Merge confirmation.</p> : null}
      {draftNotice ? <div className="stockhub-toast" role="status" aria-live="polite">{draftNotice === "updated" ? "Draft row saved and validation refreshed." : `Draft row ${draftNotice}.`} The receipt has been refreshed.</div> : null}
      {!executionStarted ? <section className="stockhub-quality-summary" aria-labelledby="stockhub-quality-heading">
        <div className="stockhub-quality-summary__heading"><div><span className="stockhub-receipt-eyebrow">Validation</span><h2 id="stockhub-quality-heading">Review this preview</h2></div><span>{totalLines} total row{totalLines === 1 ? "" : "s"}</span></div>
        <p className="stockhub-quality-summary__intro">Filter the rows by validation result. Correct missing or invalid data, then revalidate before merging.</p>
        <div className="stockhub-draft-status-summary" role="group" aria-label="Draft validation summary">
          <button type="button" aria-pressed={lineStatusFilter === "READY" && !errorGroupFilter} onClick={() => { setLineStatusFilter((value) => value === "READY" && !errorGroupFilter ? "ALL" : "READY"); setErrorGroupFilter(null); setLinePage(0); }}><strong>{readyCount}</strong><span><b>Ready to Merge</b><small>Passed preview checks</small></span></button>
          <button type="button" aria-pressed={lineStatusFilter === "MISSING" && !errorGroupFilter} onClick={() => { setLineStatusFilter((value) => value === "MISSING" && !errorGroupFilter ? "ALL" : "MISSING"); setErrorGroupFilter(null); setLinePage(0); }}><strong>{missingCount}</strong><span><b>Missing Information</b><small>Complete required fields</small></span></button>
          <button type="button" aria-pressed={lineStatusFilter === "ERROR" && !errorGroupFilter} onClick={() => { setLineStatusFilter((value) => value === "ERROR" && !errorGroupFilter ? "ALL" : "ERROR"); setErrorGroupFilter(null); setLinePage(0); }}><strong>{errorCount}</strong><span><b>Error</b><small>Review validation issues</small></span></button>
        </div>
      </section> : null}
      {!executionStarted && validationErrorGroups.length > 0 ? <section className="stockhub-validation-issues" aria-labelledby="stockhub-validation-issues-heading">
        <div className="stockhub-validation-issues__heading"><div><span className="stockhub-receipt-eyebrow">Action needed</span><h2 id="stockhub-validation-issues-heading">Validation issues</h2></div><span className="stockhub-validation-issues__total">{errorCount} affected row{errorCount === 1 ? "" : "s"}</span></div>
        <p className="stockhub-validation-issues__intro">Issues are grouped so you can address each cause once. These are preview validation results, not failed Shopify mutations.</p>
        <ul className="stockhub-validation-issue-list">{validationErrorGroups.map((group) => <li key={group.key}>
          <div className="stockhub-validation-issue-list__content"><span className="stockhub-validation-issue-list__count">{group.lines.length}</span><div><strong>{group.label}</strong><p>{group.hint}</p><small>Rows {group.lines.slice(0, 5).map((line) => line.rowNumber).join(", ")}{group.lines.length > 5 ? `, and ${group.lines.length - 5} more` : ""}</small></div></div>
          <button type="button" className="stockhub-text-action" onClick={() => { setLineStatusFilter("ERROR"); setErrorGroupFilter(group.key); setLineSearch(""); setLineTypeFilter("ALL"); setLinePage(0); document.getElementById("stockhub-receipt-lines")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Show {group.lines.length} affected rows</button>
        </li>)}</ul>
      </section> : null}
      {executionStarted ? <><div className="stockhub-receipt-progress" role="group" aria-label="Import line completion">
        <div className="stockhub-receipt-progress-label">
          <strong>Import line processing</strong>
          <span>{successful} of {totalLines} lines completed · {completionPercent}%</span>
        </div>
        <progress aria-label={`${successful} of ${totalLines} import lines completed`} max={Math.max(totalLines, 1)} value={successful} />
      </div>
      <section className="stockhub-receipt-progress-summary" aria-label="Confirmed Shopify operations">
        <div className="stockhub-receipt-summary-cards">
          <article className="stockhub-receipt-summary-card stockhub-receipt-summary-card--primary">
            <span>Import lines completed</span><strong>{successful}<small> / {totalLines}</small></strong>
            <p>Lines whose persisted import status is successful</p>
          </article>
          <article className="stockhub-receipt-summary-card">
            <span>Draft products created</span><strong>{confirmedProductsCreated}</strong>
            <p>Confirmed Shopify product creations</p>
          </article>
          <article className="stockhub-receipt-summary-card">
            <span>New-product inventory activations</span><strong>{confirmedInventoryActivated}</strong>
            <p>Inventory activation for products created by this receipt</p>
          </article>
          <article className="stockhub-receipt-summary-card">
            <span>Existing SKU inventory adjustments</span><strong>{confirmedInventoryAdjustments}</strong>
            <p>Confirmed quantity adjustments for matched variants</p>
          </article>
        </div>
        <div className="stockhub-receipt-operation-details" aria-label="Other operation outcomes">
          <span className={failed > 0 ? "is-error" : ""}><strong>{failed}</strong> failed</span>
          <span className={blocked > 0 ? "is-warning" : ""}><strong>{blocked}</strong> blocked</span>
          <span className={uncertain > 0 ? "is-warning" : ""}><strong>{uncertain}</strong> uncertain or in progress</span>
          {uncertainProductCreations > 0 ? <span className="is-warning"><strong>{uncertainProductCreations}</strong> unresolved product creations</span> : null}
          {createdDraftInventoryFailures > 0 ? <span className="is-error"><strong>{createdDraftInventoryFailures}</strong> created products with failed inventory activation</span> : null}
        </div>
        <p className="stockhub-receipt-summary-note">Counts come from persisted receipt stages. Completed lines, product creation, new-product inventory activation, and existing-SKU adjustments are separate outcomes.</p>
      </section>
      {createdDraftInventoryFailures > 0 ? <s-banner tone="warning">Products were created, but inventory activation failed for {createdDraftInventoryFailures} Draft product{createdDraftInventoryFailures === 1 ? "" : "s"}. The saved receipt status has not been changed.</s-banner> : null}</> : null}
      {eligibleCount === 0 ? <section className={`stockhub-receipt-terminal stockhub-receipt-terminal--${noEligibleMessage.tone}`} role="status" aria-live="polite">
        <strong>{noEligibleMessage.title}</strong><p>{noEligibleMessage.detail}</p>
      </section> : null}
      {actionData?.error && !hideStaleMergeConfirmationError ? <div ref={conflictRef} tabIndex={-1} role={draftConflict ? "alert" : undefined}><s-banner tone="critical">{actionData.error}{draftConflict ? <s-button type="button" onClick={() => window.location.reload()}>Refresh draft</s-button> : null}</s-banner></div> : null}
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
      {mergeDisabledReason && eligibleCount > 0 ? <div className="stockhub-merge-disabled-note" role="status">{mergeDisabledReason}</div> : null}
      <section className="stockhub-receipt-lines" id="stockhub-receipt-lines" aria-labelledby="stockhub-receipt-lines-heading">
        <div className="stockhub-receipt-lines__heading"><div><span className="stockhub-receipt-eyebrow">Receipt rows</span><h2 id="stockhub-receipt-lines-heading">Line items</h2></div><p>Open a row to review its details or edit a preview draft.</p></div>
        {batch.lines.length || draftEditable ? <>
          <div className="stockhub-line-toolbar" aria-label="Line item tools">
            <div className="stockhub-line-toolbar__summary"><strong>{filteredLines.length}</strong><span>shown of {batch.lines.length}</span></div>
            <div className="stockhub-line-toolbar__filters" role="search" aria-label="Search and filter imported items">
              <s-text-field label="Search line items" value={lineSearch} placeholder="Search SKU or product" onChange={(event) => { setLineSearch(event.currentTarget.value); setLinePage(0); }} />
              <s-select label="Quality status" value={lineStatusFilter} onChange={(event) => { setLineStatusFilter(event.currentTarget.value); setErrorGroupFilter(null); setLinePage(0); }}>
                <s-option value="ALL">All statuses</s-option>
                <s-option value="READY">Ready to Merge</s-option><s-option value="MISSING">Missing Information</s-option><s-option value="ERROR">Error</s-option>
                {(["PREVIEWED", "RUNNING", "SUCCEEDED", "FAILED", "BLOCKED", "UNCERTAIN"] as const).map((status) => <s-option key={status} value={status}>{statusLabel(status)}</s-option>)}
              </s-select>
              <s-select label="Operation type" value={lineTypeFilter} onChange={(event) => { setLineTypeFilter(event.currentTarget.value); setLinePage(0); }}>
                <s-option value="ALL">All operations</s-option><s-option value="ADJUST">Inventory adjustment</s-option><s-option value="CREATE_DRAFT">Create Draft product</s-option><s-option value="BLOCKED">Blocked row</s-option>
              </s-select>
              <s-button type="button" onClick={() => setSortAscending((ascending) => !ascending)}>Sort by row {sortAscending ? "↑" : "↓"}</s-button>
            </div>
            <div className="stockhub-line-toolbar__actions">
              {draftEditable ? <s-button type="button" variant="primary" onClick={(event) => { inspectorTriggerRef.current = event.currentTarget as HTMLElement; setSelectedLineId(null); setInspectorMode("add"); }}>＋ Add draft row</s-button> : null}
              {draftEditable ? <Form method="post" onSubmit={() => setMergeConfirmationRevision(null)}><input type="hidden" name="intent" value="draftEditLine"/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="lineId" value={revalidationLine?.id ?? ""}/><input type="hidden" name="expectedUpdatedAt" value={batch.updatedAt.toISOString()}/><input type="hidden" name="sku" value={revalidationLine?.sku ?? ""}/><input type="hidden" name="quantity" value={revalidationLine?.quantity ?? ""}/><input type="hidden" name="title" value={revalidationLine?.title ?? ""}/><input type="hidden" name="price" value={revalidationLine?.price ?? ""}/><input type="hidden" name="description" value={revalidationLine?.description ?? ""}/><input type="hidden" name="image_url" value={revalidationLine?.imageUrl ?? ""}/><s-button type="submit" disabled={!revalidationLine || savingDraft}>Revalidate selected row</s-button></Form> : null}
            </div>
            {errorGroupFilter ? <div className="stockhub-line-toolbar__active-filter" role="status"><span>Showing one validation issue group</span><button type="button" className="stockhub-text-action" onClick={() => { setErrorGroupFilter(null); setLineStatusFilter("ALL"); setLinePage(0); }}>Clear filter</button></div> : null}
          </div>
          {mergeApproval ? <div className="stockhub-merge-action stockhub-merge-bar" role="region" aria-label="Inventory merge progress">
            <div className="stockhub-merge-bar__summary">
              <strong>Saved Merge approval · {mergeApproval.status.toLowerCase()}</strong>
              <span>Chunk {mergeApproval.chunkNumber} · {mergeApproval.processedCount} of {mergeApproval.approvedLineCount} approved rows checkpointed</span>
              <small>Each request handles at most 50 rows. Completed Shopify changes cannot be rolled back.</small>
            </div>
            {mergeApproval.status === "ACTIVE" ? <>
              <mergeFetcher.Form method="post" onSubmit={() => { autoPausedRef.current = false; }}>
                <input type="hidden" name="intent" value="continueMerge"/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="approvalId" value={mergeApproval.id}/>
                <s-button type="submit" disabled={mergeFetcher.state !== "idle" || pauseFetcher.state !== "idle"}>Continue approved Merge</s-button>
              </mergeFetcher.Form>
              <pauseFetcher.Form method="post" onSubmit={() => { autoPausedRef.current = true; }}>
                <input type="hidden" name="intent" value="pauseMerge"/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="approvalId" value={mergeApproval.id}/>
                <s-button type="submit" disabled={pauseFetcher.state !== "idle"}>Pause automatic continuation</s-button>
              </pauseFetcher.Form>
              <small>Pause takes effect at the next chunk boundary; an in-flight chunk may finish.</small>
            </> : mergeApproval.status === "PAUSED" ? <mergeFetcher.Form method="post" onSubmit={() => { autoPausedRef.current = false; }}>
              <input type="hidden" name="intent" value="resumeApprovedMerge"/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="approvalId" value={mergeApproval.id}/>
              <s-button type="submit" variant="primary" disabled={mergeFetcher.state !== "idle"}>Continue saved approval</s-button>
            </mergeFetcher.Form> : null}
            {mergeFetcher.data?.error || pauseFetcher.data?.error ? <div role="alert"><s-banner tone="critical">{mergeFetcher.data?.error ?? pauseFetcher.data?.error}</s-banner></div> : null}
            {mergeFetcher.data?.mergeProgress ? <p role="status">Chunk {mergeFetcher.data.mergeProgress.chunkNumber} finished with receipt status {mergeFetcher.data.mergeProgress.status.toLowerCase()}.</p> : null}
            {pauseFetcher.data?.mergeProgress?.paused ? <p role="status">Automatic continuation paused. Existing Shopify changes remain in place.</p> : null}
          </div> : null}
          {(eligibleCount > 0 || draftEditable) && !approvalNeedsContinuation ? <div className="stockhub-merge-action stockhub-merge-bar">
            <div className="stockhub-merge-bar__summary"><strong>{eligibleCount} eligible row{eligibleCount === 1 ? "" : "s"}</strong>{blocked > 0 ? <span>{blocked} excluded as blocked</span> : null}<small>One explicit confirmation authorizes the current server-side row snapshot.</small></div>
            {draftEditable && !revalidationLine ? <span className="stockhub-merge-bar__hint">Select a draft row above to revalidate it.</span> : null}
            {eligibleCount > 0 && !mergeConfirming ? <s-button type="button" variant="primary" disabled={mergeDisabled} onClick={() => setMergeConfirmationRevision(mergeEligibilityRevision)}>{initialMergeLabel} eligible lines</s-button> : null}
            {mergeConfirming ? <div className="stockhub-merge-confirmation" role="dialog" aria-label={`Confirm ${initialMergeIntent}`}>
              <s-paragraph>Confirm {initialMergeIntent} of {eligibleCount} eligible row(s) for receipt {batch.receiptCode}. One confirmation advances safe work in server-bounded chunks of up to 50 rows.{blocked > 0 ? ` ${blocked} blocked row(s) will remain attached to this receipt.` : ""}</s-paragraph>
              <mergeFetcher.Form method="post" onSubmit={() => { autoPausedRef.current = false; lastAutoChunkRef.current = ""; setMergeConfirmationRevision(null); }}>
                <input type="hidden" name="intent" value={initialMergeIntent}/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="confirmed" value="yes"/><input type="hidden" name="confirmedCount" value={eligibleCount}/><input type="hidden" name="expectedRevision" value={batch.revision}/>
                {blocked > 0 ? <input type="hidden" name="partialConfirmed" value="yes"/> : null}
                <s-button type="submit" variant="primary" disabled={mergeDisabled || mergeFetcher.state !== "idle"}>Confirm {initialMergeLabel.toLowerCase()} of {eligibleCount} rows</s-button>
                <s-button type="button" onClick={() => setMergeConfirmationRevision(null)}>Cancel</s-button>
              </mergeFetcher.Form>
            </div> : null}
            {mergeFetcher.data?.error && !mergeApproval ? <div role="alert"><s-banner tone="critical">{mergeFetcher.data.error}</s-banner></div> : null}
          </div> : null}
          <p className="stockhub-line-results" aria-live="polite">{filteredLines.length} row{filteredLines.length === 1 ? "" : "s"} · Page {Math.min(linePage + 1, linePageCount)} of {linePageCount}</p>
          <div className="stockhub-lines-table-wrap">
            <table className="stockhub-lines-table" aria-label="Receipt line items">
              <colgroup><col className="stockhub-lines-table__product"/><col className="stockhub-lines-table__sku"/><col className="stockhub-lines-table__quantity"/><col className="stockhub-lines-table__quality"/><col className="stockhub-lines-table__execution"/><col className="stockhub-lines-table__actions"/></colgroup>
              <thead><tr><th scope="col">Product / Variant</th><th scope="col">SKU</th><th scope="col">Quantity</th><th scope="col">{executionStarted ? "Preview check" : "Validation"}</th><th scope="col">Execution status</th><th scope="col"><span className="stockhub-visually-hidden">Row actions</span></th></tr></thead>
              <tbody>{visibleLines.map((line) => <tr key={line.id}>
                <td data-label="Product / Variant"><button type="button" className="stockhub-row-open" onClick={(event) => openInspector(line.id, "details", event.currentTarget)}><span>{line.matchedProductTitle ?? line.title ?? "Untitled product"}</span>{line.matchedVariantTitle ? <small>{line.matchedVariantTitle}</small> : null}</button></td>
                <td data-label="SKU"><code className="stockhub-line-sku">{line.sku || "—"}</code></td>
                <td data-label="Quantity" className="stockhub-lines-table__quantity-cell">{line.quantity ?? "—"}</td>
                <td data-label="Validation"><s-badge tone={validationPresentation(line, executionStarted).tone}>{validationPresentation(line, executionStarted).label}</s-badge></td>
                <td data-label="Execution status"><div className="stockhub-line-execution"><s-badge tone={statusTone(line.status)} icon={statusIcon(line.status)}>{statusLabel(line.status)}</s-badge><small>{stageLabel(line.stage, line.status, line.errorCode)}</small></div></td>
                <td data-label="Actions" className="stockhub-lines-table__actions-cell">{renderRowActions(line)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <ul className="stockhub-mobile-lines" aria-label="Receipt line items">{visibleLines.map((line) => <li key={`mobile-${line.id}`}>
            <article className="stockhub-mobile-line-card">
              <div className="stockhub-mobile-line-card__identity"><button type="button" className="stockhub-row-open" onClick={(event) => openInspector(line.id, "details", event.currentTarget)}>{line.matchedProductTitle ?? line.title ?? "Untitled product"}{line.matchedVariantTitle ? <small>{line.matchedVariantTitle}</small> : null}</button><code>{line.sku || "No SKU"}</code></div>
              <div className="stockhub-mobile-line-card__badges"><span><small>{executionStarted ? "Preview check" : "Validation"}</small><s-badge tone={validationPresentation(line, executionStarted).tone}>{validationPresentation(line, executionStarted).label}</s-badge></span><span><small>Execution</small><s-badge tone={statusTone(line.status)}>{statusLabel(line.status)}</s-badge></span></div>
              <div className="stockhub-mobile-line-card__meta"><span><small>Quantity</small><strong>{line.quantity ?? "—"}</strong></span><span><small>Stage</small><strong>{stageLabel(line.stage, line.status, line.errorCode)}</strong></span></div>
              {line.errorDetail && validationGroup(line) !== "COMPLETED" ? <p className="stockhub-mobile-line-card__issue">{line.errorDetail}</p> : null}
              <div className="stockhub-mobile-line-card__actions">{renderRowActions(line)}</div>
            </article>
          </li>)}</ul>
          {visibleLines.length === 0 ? <p className="stockhub-lines-empty">No line items match these filters.</p> : null}
          {linePageCount > 1 ? <s-button-group gap="base" accessibilityLabel="Receipt line pagination">
            <s-button disabled={linePage === 0} onClick={() => setLinePage((page) => Math.max(0, page - 1))}>Previous</s-button>
            <s-button disabled={linePage + 1 >= linePageCount} onClick={() => setLinePage((page) => Math.min(linePageCount - 1, page + 1))}>Next</s-button>
          </s-button-group> : null}
        </> : <s-paragraph>No import lines are recorded for this receipt.</s-paragraph>}
      </section>
      {(selectedLine || inspectorMode === "add") ? <>
        <button className="stockhub-drawer-scrim" type="button" aria-label="Close product details" onClick={requestCloseInspector} />
        <aside ref={inspectorRef} className="stockhub-row-inspector" role="dialog" aria-modal="true" aria-labelledby="stockhub-row-inspector-heading">
          <div className="stockhub-row-inspector__header">
            <h2 id="stockhub-row-inspector-heading">{inspectorMode === "add" ? "Add draft row" : selectedLine ? `Row ${selectedLine.rowNumber} · ${selectedLine.sku}` : "Product details"}</h2>
            <button ref={drawerCloseRef} type="button" className="stockhub-icon-action" title="Close product details" aria-label="Close product details" onClick={requestCloseInspector}>×</button>
          </div>
          {selectedLine && inspectorMode === "details" ? <s-stack direction="block" gap="base">
            <s-badge tone={statusTone(selectedLine.status)}>{executionStarted ? statusLabel(selectedLine.status) : validationGroup(selectedLine) === "READY" ? "Ready to Merge" : validationGroup(selectedLine) === "MISSING" ? "Missing Information" : "Error"}</s-badge>
            <s-paragraph>{selectedLine.matchedProductTitle ?? selectedLine.title ?? "No product title"}{selectedLine.matchedVariantTitle ? ` · ${selectedLine.matchedVariantTitle}` : ""}</s-paragraph>
            <s-paragraph>SKU: {selectedLine.sku} · Quantity: {selectedLine.expectedQuantity === null ? "—" : `${selectedLine.expectedQuantity} → `}{selectedLine.quantity ?? "—"}</s-paragraph>
            {selectedLine.errorDetail || selectedLine.errorCode ? <details><summary>Error details</summary><s-banner tone={selectedLine.status === "BLOCKED" ? "warning" : "critical"}>{selectedLine.errorDetail ?? selectedLine.errorCode}<s-paragraph>{correctionHint(selectedLine.errorCode)}</s-paragraph></s-banner></details> : null}
            {selectedLine.operationType === "CREATE_DRAFT" ? <s-banner tone="info">No matching Shopify SKU was found. <Form method="post" action="/app/imports/catalog"><input type="hidden" name="intent" value="prepare-import-draft"/><input type="hidden" name="productName" value={selectedLine.title ?? ""}/><input type="hidden" name="sku" value={selectedLine.sku}/><input type="hidden" name="price" value={selectedLine.price ?? ""}/><input type="hidden" name="description" value={selectedLine.description ?? ""}/><input type="hidden" name="imageUrl" value={selectedLine.imageUrl ?? ""}/><input type="hidden" name="sourceReceiptCode" value={batch.receiptCode}/><input type="hidden" name="sourceRowNumber" value={selectedLine.rowNumber}/><s-button type="submit">Prepare product draft in Product Catalog</s-button></Form> The existing draft-only workflow receives these CSV values and does not create a Shopify product.</s-banner> : null}
            {selectedLine.errorCode === "INVENTORY_NOT_TRACKED" ? <s-banner tone="warning">This SKU already matches a Shopify variant; do not create another product. If this variant should be stocked, open <a href={`https://${shop}/admin/products${selectedLine.productId ? `/${selectedLine.productId}` : ""}`} target="_blank" rel="noreferrer">Shopify Admin</a>, enable <strong>Track quantity</strong>, save, then revalidate this row. Stocked products need tracking for quantity adjustments; leave it disabled for items that are not stocked.</s-banner> : null}
            <details><summary>Technical details</summary><s-stack direction="block" gap="small">
              {([["Product ID", selectedLine.productId], ["Variant ID", selectedLine.variantId], ["Inventory Item ID", selectedLine.inventoryItemId]] as const).map(([label, value]) => <div key={label}><code>{label}: {value ?? "—"}</code><s-button type="button" disabled={!value} accessibilityLabel={"Copy " + label} onClick={() => copyIdentifier(label, value)}>Copy {label}</s-button>{idCopyFeedback?.label === label && idCopyFeedback.status === "failed" ? <div role="alert">Could not access the clipboard. Select and copy the ID manually.<textarea ref={manualIdCopyRef} aria-label={label + " for manual copy"} readOnly value={value ?? ""} rows={2} onFocus={(event) => event.currentTarget.select()} /></div> : null}</div>)}
              {idCopyFeedback?.status === "copied" ? <div role="status">Copied {idCopyFeedback.label}.</div> : null}<s-paragraph>Stage: {selectedLine.stage} · Error code: {selectedLine.errorCode ?? "—"}</s-paragraph>
            </s-stack></details>
            {draftEditable && ["PREVIEWED", "BLOCKED"].includes(selectedLine.status) ? <s-button type="button" variant="primary" onClick={() => setInspectorMode("edit")}>Edit draft row</s-button> : null}
          </s-stack> : null}
          {(inspectorMode === "add" || (inspectorMode === "edit" && selectedLine)) ? <Form method="post" className="stockhub-draft-form" onChange={() => setDrawerDirty(true)} onSubmit={() => setMergeConfirmationRevision(null)}>
            <input type="hidden" name="intent" value={inspectorMode === "add" ? "draftAddLine" : "draftEditLine"}/><input type="hidden" name="batchId" value={batch.id}/>{selectedLine ? <input type="hidden" name="lineId" value={selectedLine.id}/> : null}<input type="hidden" name="expectedUpdatedAt" value={batch.updatedAt.toISOString()}/>
            {actionData?.error && !hideStaleMergeConfirmationError ? <s-banner tone="critical">{actionData.error}</s-banner> : null}
            {actionData?.authorizationError ? <s-banner tone="critical">{actionData.authorizationError}</s-banner> : null}
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base"><s-text-field label="SKU" name="sku" value={draftValues.sku} onChange={(event) => setDraftValues((values) => ({ ...values, sku: event.currentTarget.value }))} required/><label>Quantity<input name="quantity" type="number" min="1" value={draftValues.quantity} onChange={(event) => setDraftValues((values) => ({ ...values, quantity: event.currentTarget.value }))} required/></label><s-text-field label="Product title" name="title" value={draftValues.title} onChange={(event) => setDraftValues((values) => ({ ...values, title: event.currentTarget.value }))}/><label>Price<input name="price" type="number" min="0" step="0.01" value={draftValues.price} onChange={(event) => setDraftValues((values) => ({ ...values, price: event.currentTarget.value }))}/></label><s-text-field label="Description" name="description" value={draftValues.description} onChange={(event) => setDraftValues((values) => ({ ...values, description: event.currentTarget.value }))}/><label>Image URL<input name="image_url" type="url" value={draftValues.image_url} onChange={(event) => setDraftValues((values) => ({ ...values, image_url: event.currentTarget.value }))}/></label></s-grid>
            <div className="stockhub-drawer-actions"><s-button type="submit" variant="primary" disabled={savingDraft}>{savingDraft ? "Saving…" : inspectorMode === "add" ? "Add and validate row" : "Save and revalidate"}</s-button><s-button type="button" disabled={savingDraft} onClick={requestCloseInspector}>Cancel</s-button></div>
          </Form> : null}
          {selectedLine && inspectorMode === "edit" && draftEditable ? <button type="button" className="stockhub-delete-action" onClick={() => { if (drawerDirty) { setDiscardForDelete(true); setDiscardConfirming(true); return; } setInspectorMode("delete"); }}>Delete draft row</button> : null}
          {selectedLine && inspectorMode === "delete" ? <div className="stockhub-delete-confirm" role="alert"><s-paragraph>Remove draft row {selectedLine.rowNumber} ({selectedLine.sku})? Duplicate-SKU sibling rows may be revalidated. This does not change Shopify.</s-paragraph><Form method="post" onSubmit={() => setMergeConfirmationRevision(null)}><input type="hidden" name="intent" value="draftDeleteLine"/><input type="hidden" name="batchId" value={batch.id}/><input type="hidden" name="lineId" value={selectedLine.id}/><input type="hidden" name="expectedUpdatedAt" value={batch.updatedAt.toISOString()}/><s-button type="submit" disabled={savingDraft}>{savingDraft ? "Deleting…" : "Confirm delete"}</s-button><s-button type="button" disabled={savingDraft} onClick={() => setInspectorMode("edit")}>Cancel</s-button></Form></div> : null}
          {discardConfirming ? <div className="stockhub-delete-confirm" role="alertdialog" aria-label="Discard unsaved row changes"><s-paragraph>Discard unsaved changes?</s-paragraph><s-button type="button" variant="primary" onClick={() => { if (discardForDelete) { setInspectorMode("delete"); setDrawerDirty(false); setDiscardConfirming(false); setDiscardForDelete(false); } else finishCloseInspector(); }}>Discard changes</s-button><s-button type="button" onClick={() => { setDiscardConfirming(false); setDiscardForDelete(false); }}>Keep editing</s-button></div> : null}
          {!draftEditable && selectedLine ? <s-banner tone="info">Locked — Shopify processing has started or this receipt is no longer a preview.</s-banner> : null}
        </aside>
      </> : null}
    </s-section></div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
