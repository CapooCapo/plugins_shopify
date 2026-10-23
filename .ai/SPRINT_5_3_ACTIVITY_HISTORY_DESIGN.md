# StockHub Sprint 5.3 — Activity History design and safe UI

**Status: HISTORICAL DESIGN SNAPSHOT — IMPLEMENTED AFTER USER REQUEST ON 2026-10-23.** The statements below describe the pre-implementation state and proposal, not the current application. See [ACTIVITY_HISTORY_DESIGN.md](../ACTIVITY_HISTORY_DESIGN.md) for the implementation record. The migration has only been applied to a disposable QA database; `dev.sqlite` was not changed.

## 1. Audit findings

- `prisma/schema.prisma` contains `Session`, `ImportBatch`, `ImportLine`, and `ImportReceiptCounter`; there is no `ActivityLog` model or activity migration.
- `ImportBatch` is tenant-scoped by `shop`, with unique `(shop, submissionId)` and `(shop, receiptCode)`. `ImportLine` ownership is derived via its batch; it has no `shop` field.
- `ImportBatch.actor` currently receives a Shopify session ID in the CSV flow. A session ID is not proof of a human identity and must not be reinterpreted/backfilled as one. Online Shopify `Session.userId` is the only reliable human identifier when `isOnline` and `userId` are both present. Never join session rows into history UI; they contain credentials.
- `webhooks.shop.redact` delegates to `redactShopData`, which transactionally deletes shop-owned batches, receipt counters and sessions. Future shop-level activity events must be included explicitly in the same redaction transaction; batch-linked rows may additionally cascade.
- The initial canonical proposal is preserved in [ACTIVITY_HISTORY_DESIGN.md](../ACTIVITY_HISTORY_DESIGN.md); subsequent implementation decisions are recorded there.

## 2. Current UI and route

- Added `/app/imports/activity`, as a URL-backed secondary destination in Imports. Primary Imports remains the existing flat App Bridge `NavMenu`; no nested App Bridge navigation is introduced.
- `app/routes/app.imports.activity.tsx` authenticates the Admin request and renders an unavailable message only. It does not query the database or Shopify, create sample rows, or write anything. It explains that StockHub stores import receipts but not a complete audit timeline and links to real Import History.
- `app/routes/app.imports.tsx` adds the Activity History secondary button and URL state. Active/current-page semantics are route-specific: New Import only at `/app/imports`, Import History under `/app/imports/history`, and Activity History only at `/app/imports/activity`.
- The page does not claim a feature flag is enabled, does not say there are zero events, and does not label fixtures as real. No DEMO fixture exists in the live UI.

## 3. Proposed schema and migration — not implemented

Use one immutable `ActivityLog` table. Use validated server-owned event/outcome unions rather than client-supplied strings. An operation attempt and terminal outcome are separate append-only records. Proposed fields:

| Field | Purpose |
|---|---|
| `id` | Unique event ID. |
| `shop` | Tenant key, derived from authenticated session only. |
| `eventType`, `outcome` | Validated event taxonomy and `ATTEMPTED`, `SUCCEEDED`, `FAILED`, `UNCERTAIN`, or `BLOCKED`. |
| `occurredAt`, `createdAt` | Business and persistence timestamps. |
| `actorType`, `actorId` | `SHOPIFY_USER`, `SYSTEM`, or `UNKNOWN`; online user ID only when verified. |
| `entityType`, `entityId` | Safe entity reference; no lookup by unscoped identifier. |
| `importBatchId`, `importLineId`, `receiptCode` | Optional same-shop linkage; receipt code is a display snapshot, not a tenant key. Validate line belongs to the batch. |
| `operationId`, `attemptId`, `sourceKey` | Non-secret operation correlation, retry grouping and per-row idempotent source identity. Never store the raw idempotency key. |
| `summary`, `metadataJson` | Short allowlisted summary and bounded event-specific metadata only. |

Proposed Prisma relation: composite `(shop, importBatchId)` foreign key to `(shop, id)`, adding `@@unique([shop, id])` to `ImportBatch` and its `activityLogs` back relation. This preserves shop-scoped ownership and cascade semantics. Any line ID must be verified under that batch before insertion. Do not relate to Session.

Potential migration sequence after approval: create ActivityLog and its shop-leading indexes, add the composite batch uniqueness/relation, then add durable attempt identity/ordinal fields only if the chosen retry model requires them. No historical backfill is recommended because existing records cannot prove actor identity or every operation outcome. Migration must be reviewed and tested against a disposable DB copy. A development DB migration requires its own explicit approval.

## 4. Event taxonomy and source-key/idempotency proposal

Candidate events include CSV upload/preview completion, Merge/Resume initiation, per-line Draft creation and inventory adjustment/activation, and read-only Shopify-state verification. Do not emit events for reserved future features such as store settings until an actual operation exists.

- `BLOCKED` means preconditions prevented a mutation; it is not a Shopify failure.
- `FAILED` means a definite rejection; `UNCERTAIN` means outcome could not be established.
- `SUCCEEDED` requires confirmed Shopify response **and** successful local state persistence.
- For a remote mutation, append an immutable attempt event before the call and a separate terminal event after reconciliation. Both share a durable `attemptId`; deterministic `sourceKey` values (e.g. attempt/outcome suffix) are unique per shop. A request replay reuses identity; an intentional user retry gets a new identity.
- Existing `operationId` is safe to correlate but does not distinguish retries. A raw Shopify idempotency key must never appear in ActivityLog.
- If a remote mutation may have succeeded but terminal event persistence fails, leave the attempt row open; render “Outcome not recorded — treat as uncertain; reconcile before retry.” Never silently rewrite the attempt as success or failure.
- Logging outage behavior before mutations is unresolved: fail-closed is safer for audit completeness but changes Merge/Resume availability; fail-open preserves current behavior but creates an audit gap. Do not choose or implement either policy without approval and failure-boundary tests.

## 5. Isolation, indexes, pagination, privacy and retention

- Every read/write obtains `shop` from `authenticate.admin(request)`; ignore submitted/query shop IDs. Scope activity details, filters, counts, cursors, and joins by shop.
- Suggested indexes: unique `(shop, sourceKey)`; keyset `(shop, occurredAt, id)`; filtered keysets `(shop, eventType, occurredAt, id)` and `(shop, outcome, occurredAt, id)`; receipt drilldown `(shop, importBatchId, occurredAt, id)`. Keep shop as the leading key.
- Use keyset pagination ordered by `(occurredAt, id)` with page size 25 (hard maximum 100), a cursor bound to shop and filters, summary-only selection, and bounded detail fetch. Avoid offsets, fetch-all loading, and N+1 queries.
- Store only allowlisted data. Exclude tokens, session/cookie data, CSV content, raw request/GraphQL bodies, unrestricted Shopify errors, raw idempotency keys, and email by default. Prefer actor ID/type without actor label; any display-name snapshot requires a separate PII decision.
- Retention duration is unresolved. Proposal: no automatic purge in the initial version until a product/privacy/legal retention decision is made. Shop redaction must delete that shop's activity rows transactionally and idempotently with current shop data. Customer redaction should not erase merchant operations because no customer relationship exists.

## 6. Explicit approval gates before persistence work

1. Approve the ActivityLog schema/relation and event taxonomy.
2. Choose per-attempt immutable timeline vs. summarized attempt counter; approve durable attempt identity changes if required.
3. Approve actor identification, display-label and PII policy.
4. Decide fail-closed vs. fail-open behavior when pre-mutation audit insertion fails.
5. Approve terminal event failure/reconciliation display semantics and required failure-boundary tests.
6. Approve retention duration and shop-redaction deletion behavior.
7. Review the Activity History UI/query contract and pagination/detail behavior.
8. Authorize a reviewed migration, disposable-database validation and regression suite; separately approve any migration against a development database.

## 7. Files and verification

- UI changed: `app/routes/app.imports.tsx`, `app/routes/app.imports.activity.tsx`.
- No Prisma schema, migration, DB, webhook, ImportBatch/ImportLine data, Shopify mutation flow, or external Shopify API call changed.
- UI remains unavailable by design; no real activity rows exist to display. Browser visual QA has not been performed; visual acceptance remains pending.
- `npm run typecheck` — PASS.
- `npm run lint -- --no-cache` — PASS.
- `npm run build` — PASS; build emitted `/app/imports/activity` route bundle.
- Tester: `node --test tests/activity-history-route.test.mjs tests/app-shell-navigation.test.mjs tests/import-route-split.test.mjs` — PASS, 9/9. Activity route assertions cover URL/tab active semantics, honest unavailable UI and absence of event queries/writes.
- Coder: `node --test tests/activity-history-route.test.mjs tests/app-shell-navigation.test.mjs tests/import-route-split.test.mjs tests/import-ux-regressions.test.mjs` — PASS, 23/23.
- Tester: `node --test tests/*.test.mjs` — PASS, 144/144.
- Reviewer initially returned CHANGES_REQUIRED for the New Import tab's active state on the Activity route. That route-state bug was corrected; reviewer re-review is **APPROVED** for code/source. This is not visual acceptance.
- Polaris App Home component validator is unavailable in this environment because its installed skill bundle is missing `data/types/index.json`; used only documented existing `s-section`, `s-stack`, `s-banner`, and `s-link` components. This tooling limitation is not a code or visual verdict.

Passing checks do not imply that ActivityLog persistence is implemented or approved.
