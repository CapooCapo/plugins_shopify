import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { RoutePending } from "../components/RoutePending";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatStockhubDateTime } from "../utils/stockhub-format.js";

const HISTORY_PAGE_SIZE = 25;
const HISTORY_STATUSES = ["PREVIEWED", "RUNNING", "COMPLETED", "PARTIAL", "UNCERTAIN", "FAILED"] as const;
type HistoryStatusFilter = "ALL" | (typeof HISTORY_STATUSES)[number];

function parseHistoryStatus(value: string | null): HistoryStatusFilter {
  return HISTORY_STATUSES.some((status) => status === value)
    ? value as HistoryStatusFilter
    : "ALL";
}

function historyPageHref(
  search: string,
  status: HistoryStatusFilter,
  cursor: string | null,
  direction: "older" | "newer" | null,
) {
  const params = new URLSearchParams();
  if (search) params.set("historySearch", search);
  if (status !== "ALL") params.set("historyStatus", status);
  if (cursor && direction) {
    params.set("historyCursor", cursor);
    params.set("historyDirection", direction);
  }
  return `/app/imports/history${params.size ? `?${params.toString()}` : ""}`;
}

function historyDetailHref(batchId: string, search: string, status: HistoryStatusFilter, cursor: string | null, direction: "older" | "newer" | null) {
  const page = new URL(historyPageHref(search, status, cursor, direction), "https://stockhub.invalid");
  return `/app/imports/history/${encodeURIComponent(batchId)}${page.search}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const historySearch = (url.searchParams.get("historySearch") ?? "").trim().slice(0, 100);
  const historyStatus = parseHistoryStatus(url.searchParams.get("historyStatus"));
  const cursorId = url.searchParams.get("historyCursor");
  const directionValue = url.searchParams.get("historyDirection");
  const direction: "older" | "newer" | null = directionValue === "older" || directionValue === "newer"
    ? directionValue
    : null;
  const where = {
    shop: session.shop,
    ...(historySearch ? { receiptCode: { contains: historySearch } } : {}),
    ...(historyStatus !== "ALL" ? { status: historyStatus } : {}),
  };

  type HistoryBatchSummary = {
    id: string;
    receiptCode: string;
    locationName: string;
    createdAt: Date;
    status: string;
  };
  let batches: HistoryBatchSummary[] = [];
  let hasOlder = false;
  let hasNewer = false;
  let cursorError = Boolean(
    (cursorId && (!direction || cursorId.length > 128)) ||
    (!cursorId && directionValue),
  );

  if (!cursorError) {
    const cursorBatch = cursorId
      ? await prisma.importBatch.findFirst({
          where: { ...where, id: cursorId },
          select: { id: true, createdAt: true },
        })
      : null;
    if (cursorId && !cursorBatch) {
      cursorError = true;
    } else {
      const cursorCondition = cursorBatch && direction === "older"
        ? {
            OR: [
              { createdAt: { lt: cursorBatch.createdAt } },
              { createdAt: cursorBatch.createdAt, id: { lt: cursorBatch.id } },
            ],
          }
        : cursorBatch && direction === "newer"
          ? {
              OR: [
                { createdAt: { gt: cursorBatch.createdAt } },
                { createdAt: cursorBatch.createdAt, id: { gt: cursorBatch.id } },
              ],
            }
          : {};
      const fetched = await prisma.importBatch.findMany({
        where: { ...where, ...cursorCondition },
        orderBy: direction === "newer"
          ? [{ createdAt: "asc" }, { id: "asc" }]
          : [{ createdAt: "desc" }, { id: "desc" }],
        take: HISTORY_PAGE_SIZE + 1,
        select: {
          id: true,
          receiptCode: true,
          locationName: true,
          createdAt: true,
          status: true,
        },
      });
      if (cursorBatch && !fetched.length) {
        cursorError = true;
      } else if (direction === "newer") {
        hasNewer = fetched.length > HISTORY_PAGE_SIZE;
        hasOlder = Boolean(cursorBatch);
        batches = fetched.slice(0, HISTORY_PAGE_SIZE).reverse();
      } else {
        hasOlder = fetched.length > HISTORY_PAGE_SIZE;
        hasNewer = Boolean(cursorBatch);
        batches = fetched.slice(0, HISTORY_PAGE_SIZE);
      }
    }
  }

  const lineGroups = batches.length
    ? await prisma.importLine.groupBy({
        by: ["batchId", "status", "operationType"],
        where: {
          batchId: { in: batches.map((batch) => batch.id) },
          batch: { is: { shop: session.shop } },
        },
        _count: { _all: true },
      })
    : [];
  const rowCounts = new Map(batches.map((batch) => [batch.id, 0]));
  for (const group of lineGroups) rowCounts.set(group.batchId, (rowCounts.get(group.batchId) ?? 0) + group._count._all);
  const history = batches.map((batch) => ({ ...batch, rowCount: rowCounts.get(batch.id) ?? 0 }));

  return {
    history,
    historySearch,
    historyStatus,
    hasOlder,
    hasNewer,
    olderCursor: batches.at(-1)?.id ?? null,
    newerCursor: batches[0]?.id ?? null,
    cursorError,
    pageCursor: cursorError ? null : cursorId,
    pageDirection: cursorError ? null : direction,
  };
};

function receiptCodeLabel(receiptCode: string | null | undefined) {
  return receiptCode?.trim() || "No receipt code recorded (legacy batch)";
}

function batchStatusLabel(status: string) {
  return status === "PREVIEWED" ? "Previewed" : status === "RUNNING" ? "In progress"
    : status === "COMPLETED" ? "Completed" : status === "PARTIAL" ? "Partially completed"
      : status === "UNCERTAIN" ? "Outcome uncertain" : status === "FAILED" ? "Failed"
        : status === "BLOCKED" ? "Blocked" : status === "PROCESSING" ? "Processing" : status;
}

function batchStatusTone(status: string): "success" | "critical" | "warning" | "info" | "neutral" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED" || status === "BLOCKED") return "critical";
  if (status === "PARTIAL" || status === "UNCERTAIN") return "warning";
  if (status === "PREVIEWED" || status === "RUNNING" || status === "PROCESSING") return "info";
  return "neutral";
}

function batchStatusIcon(status: string) {
  if (status === "COMPLETED") return "check-circle";
  if (status === "FAILED" || status === "BLOCKED") return "alert-circle";
  if (status === "PARTIAL" || status === "UNCERTAIN") return "alert-triangle";
  if (status === "RUNNING" || status === "PROCESSING") return "clock";
  return "info";
}

export default function ImportHistory() {
  const data = useLoaderData<typeof loader>();
  return (
    <main className="stockhub-history-page">
    <header className="stockhub-history-header">
      <div className="stockhub-overview-eyebrow">StockHub imports</div>
      <h1>Import history</h1>
      <p>Find saved receipts, their status, and the details needed to safely continue your work.</p>
    </header>
    <div className="stockhub-history-card">
    <s-section>
      <RoutePending />
      <s-heading>Import history</s-heading>
      <s-paragraph>Find a saved import receipt to review its status, lines, and verification details.</s-paragraph>
      <Form method="get">
        <div className="stockhub-history-toolbar">
          <s-text-field label="Search receipt code" name="historySearch" value={data.historySearch} placeholder="Search receipts" />
          <s-select label="Batch status" name="historyStatus" value={data.historyStatus}>
            <s-option value="ALL">All statuses</s-option>
            {HISTORY_STATUSES.map((status) => <s-option key={status} value={status}>{batchStatusLabel(status)}</s-option>)}
          </s-select>
          <s-button type="submit" variant="primary">Search</s-button>
        </div>
      </Form>
      <div role="status" aria-live="polite" aria-atomic="true">
        Showing {data.history.length} receipt{data.history.length === 1 ? "" : "s"}. Search: {data.historySearch || "all receipt codes"}; status: {data.historyStatus === "ALL" ? "all statuses" : batchStatusLabel(data.historyStatus)}. Newer page: {data.hasNewer ? "available" : "not available"}; older page: {data.hasOlder ? "available" : "not available"}.
      </div>
      {data.cursorError ? (
        <s-banner tone="warning">
          This history page cursor is invalid or no longer available. <a href={historyPageHref(data.historySearch, data.historyStatus, null, null)}>Return to the newest history page</a>.
        </s-banner>
      ) : null}
      {data.history.length ? (
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary" format="base">Receipt</s-table-header>
            <s-table-header listSlot="labeled" format="base">Location</s-table-header>
            <s-table-header listSlot="labeled" format="base">Date</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">Rows</s-table-header>
            <s-table-header listSlot="labeled" format="base">Status</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {data.history.map((batch) => (
              <s-table-row key={batch.id}>
                <s-table-cell>
                  <Link to={historyDetailHref(batch.id, data.historySearch, data.historyStatus, data.pageCursor, data.pageDirection)}>
                    {receiptCodeLabel(batch.receiptCode)}
                  </Link>
                </s-table-cell>
                <s-table-cell>{batch.locationName}</s-table-cell>
                <s-table-cell>{formatStockhubDateTime(batch.createdAt)}</s-table-cell>
                <s-table-cell>{batch.rowCount}</s-table-cell>
                <s-table-cell><s-badge tone={batchStatusTone(batch.status)} icon={batchStatusIcon(batch.status)}>{batchStatusLabel(batch.status)}</s-badge></s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      ) : (
        <s-paragraph>{data.cursorError ? "No history rows are shown for this invalid cursor." : data.historySearch || data.historyStatus !== "ALL" ? "No receipts match these filters." : "No import receipts have been previewed."}</s-paragraph>
      )}
      {!data.cursorError && (data.hasNewer || data.hasOlder) ? (
        <s-button-group gap="base" accessibilityLabel="Import history pagination">
          {data.hasNewer ? <s-button href={historyPageHref(data.historySearch, data.historyStatus, data.newerCursor, "newer")}>Newer</s-button> : null}
          {data.hasOlder ? <s-button href={historyPageHref(data.historySearch, data.historyStatus, data.olderCursor, "older")}>Older</s-button> : null}
        </s-button-group>
      ) : null}
    </s-section>
    </div>
    </main>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
