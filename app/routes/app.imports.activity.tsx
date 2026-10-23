import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { RoutePending } from "../components/RoutePending";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatStockhubDateTime } from "../utils/stockhub-format.js";

const PAGE_SIZE = 25;
const EVENT_TYPES = ["IMPORT_PREVIEWED", "IMPORT_MERGE", "IMPORT_RESUME", "IMPORT_RESULT", "IMPORT_LINE_RESULT", "SHOPIFY_STATE_VERIFIED"] as const;
const OUTCOMES = ["ATTEMPTED", "SUCCEEDED", "FAILED", "UNCERTAIN", "BLOCKED"] as const;

function safeFilter(value: string | null, allowed: readonly string[]) {
  return value && allowed.includes(value) ? value : "ALL";
}

function pageHref(search: string, eventType: string, outcome: string, cursor: string | null, direction: string | null) {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (eventType !== "ALL") params.set("eventType", eventType);
  if (outcome !== "ALL") params.set("outcome", outcome);
  if (cursor && direction) {
    params.set("cursor", cursor);
    params.set("direction", direction);
  }
  return `/app/imports/activity${params.size ? `?${params.toString()}` : ""}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 100);
  const eventType = safeFilter(url.searchParams.get("eventType"), EVENT_TYPES);
  const outcome = safeFilter(url.searchParams.get("outcome"), OUTCOMES);
  const cursorId = url.searchParams.get("cursor");
  const direction = url.searchParams.get("direction");
  const isOlder = direction === "older";
  const isNewer = direction === "newer";
  let cursorError = Boolean((cursorId && (!isOlder && !isNewer || cursorId.length > 128)) || (!cursorId && direction));
  const baseWhere = {
    shop: session.shop,
    ...(eventType !== "ALL" ? { eventType } : {}),
    ...(outcome !== "ALL" ? { outcome } : {}),
    ...(search ? { OR: [{ summary: { contains: search } }, { receiptCode: { contains: search } }] } : {}),
  };
  const cursor = !cursorError && cursorId ? await prisma.activityLog.findFirst({
    where: { ...baseWhere, id: cursorId }, select: { id: true, occurredAt: true },
  }) : null;
  if (cursorId && !cursor) cursorError = true;
  let entries: Array<{
    id: string; eventType: string; outcome: string; occurredAt: Date; actorType: string;
    actorId: string | null; receiptCode: string | null; importBatchId: string | null; summary: string;
  }> = [];
  let hasOlder = false;
  let hasNewer = false;
  if (!cursorError) {
    const cursorWhere = cursor && isOlder
      ? { OR: [{ occurredAt: { lt: cursor.occurredAt } }, { occurredAt: cursor.occurredAt, id: { lt: cursor.id } }] }
      : cursor && isNewer
        ? { OR: [{ occurredAt: { gt: cursor.occurredAt } }, { occurredAt: cursor.occurredAt, id: { gt: cursor.id } }] }
        : {};
    const fetched = await prisma.activityLog.findMany({
      where: { ...baseWhere, ...cursorWhere },
      orderBy: isNewer ? [{ occurredAt: "asc" }, { id: "asc" }] : [{ occurredAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
      select: { id: true, eventType: true, outcome: true, occurredAt: true, actorType: true, actorId: true, receiptCode: true, importBatchId: true, summary: true },
    });
    if (isNewer) {
      hasNewer = fetched.length > PAGE_SIZE;
      hasOlder = Boolean(cursor);
      entries = fetched.slice(0, PAGE_SIZE).reverse();
    } else {
      hasOlder = fetched.length > PAGE_SIZE;
      hasNewer = Boolean(cursor);
      entries = fetched.slice(0, PAGE_SIZE);
    }
  }
  return {
    entries, search, eventType, outcome, hasOlder, hasNewer,
    olderCursor: entries.at(-1)?.id ?? null,
    newerCursor: entries[0]?.id ?? null,
    cursorError,
  };
};

function actorLabel(actorType: string, actorId: string | null) {
  if (actorType === "SYSTEM") return "System";
  if (actorType === "SHOPIFY_USER" && actorId) return `Shopify user ${actorId}`;
  return "Unknown user";
}

function outcomeTone(outcome: string): "success" | "critical" | "warning" | "info" | "neutral" {
  if (outcome === "SUCCEEDED") return "success";
  if (outcome === "FAILED" || outcome === "BLOCKED") return "critical";
  if (outcome === "UNCERTAIN") return "warning";
  if (outcome === "ATTEMPTED") return "info";
  return "neutral";
}

function eventLabel(eventType: string) {
  return ({
    IMPORT_PREVIEWED: "Import preview",
    IMPORT_MERGE: "Merge requested",
    IMPORT_RESUME: "Resume requested",
    IMPORT_RESULT: "Import result",
    IMPORT_LINE_RESULT: "Product / inventory line",
    SHOPIFY_STATE_VERIFIED: "Shopify state verified",
  } as Record<string, string>)[eventType] ?? "Activity";
}

export default function ImportActivity() {
  const data = useLoaderData<typeof loader>();
  return (
    <main className="stockhub-history-page">
      <header className="stockhub-history-header">
        <div className="stockhub-overview-eyebrow">StockHub imports</div>
        <h1>Activity History</h1>
        <p>Review who previewed and processed imports, what changed, and whether each action succeeded.</p>
      </header>
      <div className="stockhub-history-card"><s-section>
        <RoutePending />
        <Form method="get">
          <div className="stockhub-history-toolbar">
            <s-text-field label="Search activity or receipt" name="search" value={data.search} placeholder="SKU, receipt, or action" />
            <s-select label="Activity" name="eventType" value={data.eventType}>
              <s-option value="ALL">All activity</s-option>
              {EVENT_TYPES.map((type) => <s-option key={type} value={type}>{eventLabel(type)}</s-option>)}
            </s-select>
            <s-select label="Outcome" name="outcome" value={data.outcome}>
              <s-option value="ALL">All outcomes</s-option>
              {OUTCOMES.map((value) => <s-option key={value} value={value}>{value}</s-option>)}
            </s-select>
            <s-button type="submit" variant="primary">Filter</s-button>
          </div>
        </Form>
        <p role="status" aria-live="polite">Showing {data.entries.length} activity event{data.entries.length === 1 ? "" : "s"} for this Shopify store.</p>
        {data.cursorError ? <s-banner tone="warning">This activity page cursor is invalid or unavailable. <a href={pageHref(data.search, data.eventType, data.outcome, null, null)}>Return to the newest activity</a>.</s-banner> : null}
        {data.entries.length ? <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary" format="base">Activity</s-table-header>
            <s-table-header listSlot="labeled" format="base">Who</s-table-header>
            <s-table-header listSlot="labeled" format="base">Receipt</s-table-header>
            <s-table-header listSlot="labeled" format="base">When</s-table-header>
            <s-table-header listSlot="labeled" format="base">Outcome</s-table-header>
          </s-table-header-row>
          <s-table-body>{data.entries.map((entry) => <s-table-row key={entry.id}>
            <s-table-cell><strong>{eventLabel(entry.eventType)}</strong><br />{entry.summary}</s-table-cell>
            <s-table-cell>{actorLabel(entry.actorType, entry.actorId)}</s-table-cell>
            <s-table-cell>{entry.receiptCode && entry.importBatchId ? <a href={`/app/imports/history/${encodeURIComponent(entry.importBatchId)}`}>{entry.receiptCode}</a> : entry.receiptCode ?? "—"}</s-table-cell>
            <s-table-cell>{formatStockhubDateTime(entry.occurredAt)}</s-table-cell>
            <s-table-cell><s-badge tone={outcomeTone(entry.outcome)}>{entry.outcome}</s-badge></s-table-cell>
          </s-table-row>)}</s-table-body>
        </s-table> : <s-paragraph>No activity has been recorded for these filters yet.</s-paragraph>}
        <div className="stockhub-history-pagination">
          {data.hasNewer && data.newerCursor ? <a href={pageHref(data.search, data.eventType, data.outcome, data.newerCursor, "newer")}>Newer activity</a> : null}
          {data.hasOlder && data.olderCursor ? <a href={pageHref(data.search, data.eventType, data.outcome, data.olderCursor, "older")}>Older activity</a> : null}
        </div>
      </s-section></div>
    </main>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
