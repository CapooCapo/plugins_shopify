# StockHub Activity History — Sprint A Design Proposal

**Status:** implemented in the application and covered by automated checks; migration is present but has not been applied to `dev.sqlite`.  
**Scope:** this document began as a proposal. The implementation decisions below supersede the original open approval questions; historical sections describe the design rationale and planned checks.

## Implementation decision record — 2026-10-23

- Added shop-scoped append-only `ActivityLog` events for saved import previews, Merge/Resume attempts and results, per-SKU outcomes, and read-only Shopify state verification.
- Preview and its audit event are saved atomically. A Merge/Resume attempt event is committed before Shopify writes; if the process stops before a result event, the timeline retains an unresolved attempt instead of claiming success.
- Human attribution uses only Shopify's authenticated online `userId`; offline or unidentified sessions are shown as **Unknown user**. Email, session rows, and credentials are never loaded for the Activity History page.
- Events contain bounded allowlisted counts, SKU/quantity outcome summaries, and safe error codes only; no CSV contents, tokens, cookies, raw GraphQL errors, or idempotency keys.
- Queries are authenticated and shop-scoped, bounded to 25 events per page, and keyset-paginated. Shop redaction deletes the shop's activity in the same transaction as other shop data. No historical events are backfilled, and no retention job is enabled.
- No new third-party package or Shopify scope was added. The new migration was deployed only to a disposable QA database; existing development data was not migrated.

## 1. Current architecture

- `Session` is Shopify authentication storage. It is shop-scoped and contains access/refresh tokens plus optional online-user fields.
- `ImportBatch` is shop-scoped, has a receipt code and an optional `actor`, and owns `ImportLine` rows. Batch/receipt and submission uniqueness are already scoped by `shop`.
- `ImportLine` contains operation identity, import state/stage, Shopify resource IDs, and errors. It has no shop column; ownership is derived through its batch.
- `ImportReceiptCounter` is keyed by `(shop, dateKey)`.
- There is no `Store` model. `shop` is the tenant boundary.
- Current CSV persistence passes `session.id` into `ImportBatch.actor`. A session ID is not a reliable human identity and old values must not be reinterpreted or backfilled as a person.
- The installed Shopify Prisma session storage maps the online associated-user ID to `Session.userId`. A human actor may be attributed only from the authenticated online session when `isOnline` and `userId` are both present. Offline sessions have no reliable human actor. Do not join to or expose token-bearing session data to render history.

### Existing-solution preflight

- The app currently depends on Prisma/SQLite and Shopify's app/session packages; `package.json` has no audit-log dependency.
- A Prisma extension such as [`@kuruwic/prisma-audit`](https://github.com/KuruwiC/prisma-audit) can automatically capture generic Prisma writes, but the reviewed README describes GitHub-release installation and low-level change tracking. That does not by itself encode StockHub's Shopify mutation outcomes, durable retry attempts, or the distinction between product creation and import-line completion; automatic before/after/request capture would also need strict redaction. It is not a drop-in replacement for domain events.
- The reviewed [`mediavine/prisma-audit-log-extension`](https://github.com/mediavine/prisma-audit-log-extension) describes a cloud Bemi ingestion service with hosted PostgreSQL and no self-hosted option, which does not match this app's current SQLite/local persistence boundary.
- Recommendation: do not add an audit package or external service for this feature. Keep the proposed domain-owned Prisma model and explicit server-action event recording; this remains a proposal, not implementation approval.

## 2. Proposed minimal record

Use one append-only `ActivityLog` table. Keep event names and outcomes as validated application string unions, consistent with the existing batch state representation; do not persist arbitrary client-supplied event names or metadata. Rows are immutable after insertion; an operation attempt and its terminal outcome are separate rows, not an update to the attempt row.

```prisma
model ActivityLog {
  id              String   @id
  shop            String
  eventType       String
  outcome         String   // ATTEMPTED | SUCCEEDED | FAILED | UNCERTAIN | BLOCKED
  occurredAt      DateTime @default(now())
  actorType       String   // SHOPIFY_USER | SYSTEM | UNKNOWN
  actorId         String?  // Shopify online user ID, serialized as decimal text
  actorLabel      String?  // optional minimal display snapshot; PII decision required
  entityType      String?  // e.g. IMPORT_BATCH, IMPORT_LINE, SHOP
  entityId        String?
  importBatchId   String?
  importLineId    String?  // validated to belong to importBatchId on write
  receiptCode     String?  // immutable display snapshot; not a tenant key
  operationId     String?  // safe operation identifier; never raw idempotency key
  attemptId       String?  // durable non-secret identity grouping one mutation attempt
  sourceKey       String   // deterministic non-secret deduplication identity
  summary         String   // short allowlisted human-readable description
  metadataJson    String?  // bounded allowlist only; never raw GraphQL/request/session data
  createdAt       DateTime @default(now())

  batch ImportBatch? @relation(fields: [shop, importBatchId], references: [shop, id], onDelete: Cascade)

  @@unique([shop, sourceKey])
  @@index([shop, occurredAt, id])
  @@index([shop, eventType, occurredAt, id])
  @@index([shop, outcome, occurredAt, id])
  @@index([shop, importBatchId, occurredAt])
}
```

The relation requires adding `activityLogs ActivityLog[]` and `@@unique([shop, id])` to `ImportBatch` so the composite foreign key enforces same-shop batch linkage. The globally unique batch ID remains unchanged. At write time, verify any `importLineId` belongs to that batch; never look up a line by ID alone. Receipt code is a snapshot, not a cross-shop lookup key. Avoid a Session relation because sessions rotate and contain credentials.

### Actor and metadata policy

- `SHOPIFY_USER` plus the authenticated Shopify online `userId` only when both online-session conditions are met.
- Otherwise `UNKNOWN` for an interactive action, or `SYSTEM` for a genuinely automated event. Do not claim a named actor where the platform did not provide one.
- Prefer no `actorLabel`; if a human-readable label is required, use a minimal sanitized name snapshot and approve its PII/retention implications. Never store email by default.
- Metadata is an event-specific allowlist of bounded fields (for example, row counts, stage, safe resource GIDs, sanitized error code). Exclude access/refresh tokens, cookies, raw request/GraphQL payloads, CSV contents, raw idempotency keys, and unrestricted error bodies.

## 3. Event taxonomy and outcomes

| Event type | Granularity | Meaning |
|---|---|---|
| `CSV_UPLOADED` | batch | File accepted/persisted; do not include CSV contents or sensitive filename paths. |
| `PREVIEW_COMPLETED` | batch | Validation/preview result persisted, including aggregate counts. |
| `MERGE` | batch | User initiated Merge; separate from per-line Shopify outcomes. |
| `RESUME` | batch | User initiated Resume; separate from per-line outcomes. |
| `PRODUCT_CREATED` | line | Draft product creation result; does not mean the import line completed. |
| `INVENTORY_UPDATED` | line | Inventory activation/adjustment result and safe quantity delta when appropriate. |
| `SHOPIFY_STATE_VERIFIED` | batch/line | Read-only snapshot result; never implies future mutation safety. |
| `STORE_SETTINGS_UPDATED` | shop | Reserved until an actual settings action exists; emit nothing today. |

Outcomes are `ATTEMPTED`, `SUCCEEDED`, `FAILED`, `UNCERTAIN`, and `BLOCKED`. `BLOCKED` means preconditions prevented an attempt; it must not be described as a Shopify mutation failure. A definite Shopify rejection is `FAILED`; timeout/ambiguous response is `UNCERTAIN`. `SUCCEEDED` requires confirmed Shopify response and successful local state persistence. Product creation success is never equivalent to ImportLine completion.

For each remote mutation attempt, append one `ATTEMPTED` row before the call and then a separate terminal row (`SUCCEEDED`, `FAILED`, or `UNCERTAIN`) after local reconciliation. Both rows share `attemptId`; each has its own deterministic `sourceKey` (for example, `<attemptId>:attempt` and `<attemptId>:outcome`). Retry of the same request reuses its `attemptId` and source keys; an intentional retry receives a new durable attempt ID. For local-only actions, one event row can directly record the final outcome. Activity History groups the pair as one attempt and may show both timestamps/details.

If the terminal insert/transaction fails after Shopify may have changed state, the immutable attempt row remains with no terminal row. UI must label it **Outcome not recorded — treat as uncertain; reconcile before retry**, not as failed or safely retryable. A stale attempt row is never silently rewritten to `FAILED` or `SUCCEEDED`.

## 4. Retry identity — decision required before Sprint C

Every persisted activity row needs a stable, non-secret `sourceKey`, unique within the shop. A key based only on `(operationId, stage)` deduplicates requests but collapses retries; a random key per HTTP execution permits duplicate events on request replay.

**Recommended:** give each deliberate Merge/Resume invocation a durable `attemptId`, and each per-line stage attempt a stable ordinal or child attempt ID persisted before the Shopify call. Derive `sourceKey` from that identity and row kind (`attempt`/`outcome`). Replayed requests reuse the same identity; a new human retry receives a new one. This likely requires a small attempt identity/ordinal field or equivalent persisted request record and is a schema/workflow change for separate approval.

**Lower-schema alternative:** one summary record per operation/stage with `attemptCount` and `lastAttemptAt`, upserted by a stable key. This prevents duplicates but loses a separately inspectable event for each retry. It is not recommended if the requirement is a true audit timeline.

Never use a raw Shopify idempotency key in ActivityLog. Existing `operationId` is safe as a link, but it alone cannot distinguish repeated attempts.

## 5. Transaction and failure boundaries

- CSV persistence and preview completion are local-only: write batch/counter/line data and corresponding activity row in the same SQLite transaction.
- Shopify calls cannot participate in a SQLite transaction. Never hold a database transaction open across network calls.
- For Merge/Resume: durably claim the existing operation, allocate the attempt identity, and persist the immutable `ATTEMPTED` event before the Shopify mutation. After the response, persist the line outcome and append the terminal activity event together in a short local transaction.
- A definite rejection appends `FAILED`; an ambiguous response appends `UNCERTAIN`. If Shopify may have succeeded but local final persistence fails, the attempt remains without a terminal row and is presented conservatively as uncertain; never infer success or permit unsafe retry from a missing log update.
- **Logging outage policy is an approval decision:** fail-closed before a Shopify mutation if the required `ATTEMPTED` record cannot be persisted is the safer audit guarantee, but it changes Merge/Resume availability/behavior. Fail-open preserves existing behavior but creates an audit gap. Do not implement either policy until its scope is approved and failure-boundary tests exist. After a remote mutation, audit-log errors must not overwrite the existing safety state or hide reconciliation needs.

## 6. Isolation, deletion, retention, and pagination

- Every query/write derives `shop` from `authenticate.admin(request)`; ignore shop values supplied by query params/forms.
- Every activity list/detail query includes `shop`; batch linkage uses the composite shop/batch relation; line IDs are validated under that batch.
- `shop/redact` must delete ActivityLog rows for that shop in the same transaction as ImportBatch, counters, and Session deletion. Cascade handles batch-linked events; explicit `deleteMany({where:{shop}})` also removes shop-level events. Repeated redaction remains idempotent. Customer redaction must not delete merchant activity because no customer relationship exists.
- Do not backfill historical logs: existing records do not prove actor identity or every operation outcome.
- Retention duration is a product/privacy/legal decision. Proposal: no automatic purge job in the initial release; define and approve a policy before scheduling deletion. Shop redaction always purges immediately. A 365-day policy can be evaluated, not assumed or claimed compliant.
- Use keyset pagination ordered by `(occurredAt, id)`, scoped by shop, with page size 25 (hard max 100). Encode/bind cursor to shop and active filters. Select summary columns only; retrieve bounded details separately. Avoid offset pagination, fetch-all queries, and per-row N+1 lookups.

## 7. Migration proposal and approval gate

Proposed migration would create `ActivityLog`, add the composite batch uniqueness/relation, and optionally add durable attempt identity fields after the dedupe decision. No migration file is created here, and none is applied. No historical backfill is proposed. Before Sprint C, approve:

1. The schema/relation and event taxonomy.
2. Per-attempt timeline vs summarized retry record.
3. Actor-label/PII policy.
4. Fail-closed vs fail-open logging outage policy.
5. Retention policy and shop-redaction deletion behavior.
6. Activity UI and query requirements.

After approval, create a reviewed migration, test it on a disposable copy, add regression tests, and only then request separate authorization for any development database migration. The original database is not part of this design stage.

## 8. Future acceptance matrix

- Success, definite failure, precondition block, uncertain response, and Shopify-success/local-write-failure each produce the correct outcome; attempted/succeeded/failed/uncertain must never be conflated.
- Replayed action ID is deduplicated; a deliberate retry is distinguishable; successful Resume-skipped lines produce no new mutation-success event.
- Cross-shop insert, detail read, filter, search, count, and next-page cursor cannot expose another shop's rows.
- Shop-redact deletes only that shop's events transactionally and idempotently; customer redaction preserves merchant history.
- Activity HTML/copy/metadata contain no credentials, raw idempotency key, CSV contents, email by default, or unrestricted raw errors.
- Pagination is bounded, deterministic under new insertions, uses shop-leading indexes, and causes no per-row import-line/Shopify lookups.

## 9. Post-approval test and benchmark plan

This is a test-design result for a future approved implementation, not evidence that ActivityLog works today. Existing merge, verification, privacy-webhook, and Activity History route tests are useful behavioral references, but none currently asserts ActivityLog persistence.

| Test area | Planned regression assertions |
|---|---|
| Outcome semantics | Cover attempted, confirmed success, definite failure, uncertain, and blocked-before-mutation for each event-producing path. Success requires both confirmed Shopify response and successful local persistence. Product creation alone must not mark the import line complete. |
| Failure boundaries | Inject Shopify rejection, timeout/ambiguous response, and failure to persist a terminal audit row after a potentially successful Shopify call. In the last case retain an open attempt shown as uncertain/reconcile-needed; separately test the approved policy for failure to persist the pre-mutation attempt. |
| Retry/idempotency | Replaying the same request/attempt identity creates no duplicate event; an intentional retry gets a distinct attempt identity; attempts correlate with terminal rows; successful or skipped Resume lines produce no new mutation-success event. Assert raw Shopify idempotency keys never enter storage or UI. |
| Shop isolation and relationships | With two shops, scope list/detail/search/filter/count/receipt/line lookups and next-page cursors; tampered shop parameters cannot override authenticated shop. Reject mismatched batch/line ownership. |
| Actor attribution | Online session with `isOnline` and `userId` records the user ID; missing/offline identity yields `UNKNOWN`; use `SYSTEM` only for genuine automation. Never infer a human from legacy `ImportBatch.actor` or load token-bearing Session data into history responses. |
| Privacy deletion | Extend `tests/privacy-webhooks.test.mjs`: shop redaction deletes activity and existing shop data in the same transaction, remains idempotent, cannot touch another shop, and rolls back as a unit on failure. Customer redaction preserves merchant activity. |
| Sanitization | Store and render sentinel tokens, cookies, email, CSV content, raw GraphQL payloads/errors, and raw idempotency keys in test inputs; assert none leak into stored metadata, HTML, or copied details. Allow only bounded event-specific safe codes/IDs. |
| Pagination/performance | Use a disposable SQLite database to verify stable `(occurredAt, id)` keyset order, page/max bounds, cursor binding to shop and filters, and deterministic behavior as new rows arrive. Assert no fetch-all/offset path, no session/line expansion in summary queries, and no N+1. Inspect shop-leading indexes with `EXPLAIN QUERY PLAN` where practical. |

Relevant current reference tests include `tests/import-merge.test.mjs` (uncertain retries, idempotency, Shopify success followed by local write failure and replay), `tests/import-state-verification.test.mjs` (read-only verification and sanitization), and `tests/privacy-webhooks.test.mjs` (shop/customer redaction). These test current import behavior only; the future audit assertions above are not presently covered.

**Benchmark status:** no Activity History route/database benchmark was run in Sprint A because there is no ActivityLog schema or persisted feed. After approval, benchmark only against a disposable SQLite database with an agreed representative data volume; record bounded query count, `EXPLAIN QUERY PLAN`, and measured page latency separately. Synthetic results must not be reported as live Shopify or production-database latency, and a latency target must be agreed against the deployment environment before calling performance accepted.

## 10. Gated implementation sequence

1. **Sprint A — this proposal:** architecture, event/outcome semantics, schema/migration proposal, privacy boundaries, and unresolved policy decisions. No application/schema/migration change is authorized by this document.
2. **Sprint B — UI, separately scoped:** design and visually review a Polaris table/timeline, search and Store/Event Type/Status/Date filters, bounded pagination, activity detail with expandable technical metadata, related receipt/product links, and responsive states. Until real persisted events exist, the deployed route remains the honest unavailable state; any preview fixture must be isolated, explicitly labeled, and excluded from production behavior.
3. **Sprint C — integration/performance, only after separate approval:** approve the schema and policies in section 7; create/review a migration; validate on a disposable database; then implement idempotent server-action event recording and shop-scoped list/detail queries; run the regression plan above. Applying any migration to the original/development database requires its own explicit approval. No historical backfill, Shopify mutation, commit, push, or deploy is included in Sprint A.

## Review evidence

Read-only architecture review and independent design critique confirmed the model relationships, actor limitation, deduplication tradeoff, transaction boundary, webhook deletion requirements, pagination strategy, and unresolved policy choices. An independent test-design review mapped future assertions for outcomes, failure boundaries, retry identity, cross-shop access, deletion, sanitization, pagination/performance, and actor attribution. No code, Prisma schema, migration, database, or Shopify state was changed for Sprint A; this document now records the review/test plan and the package preflight.
