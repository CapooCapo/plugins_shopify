# Sprint 5.4 — Performance QA

## Scope

This sprint audited the existing [UI/UX performance report](./UI_UX_PERFORMANCE_REPORT.md) and made one narrow query-shape optimization on Overview. No schema/migration, database write, Shopify mutation, tenant/auth behavior, import state semantics, or verification caching was changed. The unauthenticated/live UI was not available for visual or latency QA.

## Baseline audit and evidence quality

The older `UI_UX_PERFORMANCE_REPORT.md` contains historical UI findings and build/check results from earlier sprints. Its ~298.02 kB client JavaScript, 0.76 kB CSS, and ~157.90 kB server bundle are historical artifact sizes, not a same-revision baseline and not transfer or latency measurements. Its 111-test baseline likewise predates the current suite. I do not use those figures as a before measurement for this sprint.

Before this change, source inspection of `app/routes/app._index.tsx` showed three concurrent shop-filtered Prisma operations for the Overview import summary: `count` for all batches, `count` for exact `FAILED`, and `findMany` for the five most recent receipts. The schema declares `ImportBatch.status` as `String`, not an enum. Prisma 6.19.3 supports `groupBy`; therefore grouping by status can retain unknown/future status values rather than relying on a hard-coded status list.

## Change and before/after

The Overview loader now uses one `importBatch.groupBy({ by: ["status"], where: { shop: session.shop }, _count: { _all: true } })` call. A pure reducer sums every returned group into the total and adds to the failed count only when `status === "FAILED"`. The separate recent-receipts query remains shop-scoped, deterministically ordered, limited to five, and selects only displayed fields.

| Metric | Before | After | Evidence type |
|---|---:|---:|---|
| Overview import-summary Prisma calls | 3 | 2 | Source inspection: one status aggregation plus one recent-five query. This is a DB-call-count reduction, **not** a measured latency improvement. |
| Overview browser chunk | 3,967 bytes (`app._index-BDtj-RqK.js`) | 3,967 bytes (same filename/content hash after server-only loader change) | Local build artifact observation; no client code was added. |
| Full client JavaScript artifacts | Not captured before this change | 326,644 bytes raw, summed from `build/client/assets/*.js` | Current local build only; not gzip transfer size, browser download, or a before/after comparison. |
| Client CSS artifacts | Not captured before this change | 760 bytes raw | Current local build only. |
| SSR bundle | Not captured before this change | 211,699 bytes raw | Current local build only; not a runtime memory/latency measure. |

No live SQLite query count/timing, request waterfall, authenticated route latency, bundle transfer, browser rendering time, or user-perceived speed was available. No runtime performance uplift is claimed.

## Correctness and checks

The helper was exercised for empty input, failed-only input, mixed known statuses, unknown/future status, and differently-cased `failed`. Empty groups return zero totals; unknown statuses remain included in the total and only exact `FAILED` contributes to the failed count. Existing shop scoping and bounded recent receipts are asserted by the Overview source-contract test.

- `npm run typecheck`: PASS (run in this checkout).
- `npm run lint`: PASS (run in this checkout).
- `npm run build`: PASS (run in this checkout; React Router emitted its existing future-flag warnings and empty auth/webhook chunks).
- `npx prisma validate`: PASS (independently run by tester; no migration was executed).
- Focused `tests/overview-regressions.test.mjs`: 2/2 PASS (tester-owned verification).
- Full `node --test tests/*.test.mjs`: 145/145 PASS (tester-owned verification).
- Tester parser harness (Node v26.9.0, 35 repetitions per size, pre-generated CSV input, one warmup):

  | CSV rows | Result | Median | p95 |
  |---:|---|---:|---:|
  | 10 | Accepted | 0.029 ms | 0.129 ms |
  | 100 | Accepted | 0.080 ms | 0.232 ms |
  | 500 | Rejected at the documented 250-row cap | 0.029 ms | 0.158 ms |
  | 1,000 | Rejected at the documented 250-row cap | 0.027 ms | 0.088 ms |

  These are parser-only measurements. The 500/1,000-row cases are rejection-path measurements, not successful large-file parsing or UI/table-render measurements; none represents production data or browser performance.

## Limitations / not verified

- **VISUAL_QA_PENDING.** No authenticated or isolated Shopify preview was available; local Vite preview was previously blocked by missing `SHOPIFY_APP_URL`. No screenshot, interaction, responsive, or accessibility acceptance is claimed.
- No DB was configured for a read-query benchmark; no query latency was measured. The 3→2 figure is a source-level call-count comparison only.
- No production-sized data set or browser render benchmark was run. The measured parser timings above are not treated as application or UI performance data.
- No schema/migration, DB writes, Shopify writes, or deploy occurred.
