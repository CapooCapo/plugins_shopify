# BI-00 — Import Capacity Baseline

**Measured:** 2026-10-28 · **Branch:** `staging/merge-reliability` · **Scope:** local fixtures and disposable loopback PostgreSQL only

## Summary

The current upload limit is **250 data rows and 1,000,000 CSV bytes** for both Inventory Import and Catalog Import. The multipart request cap is 1,065,536 bytes (CSV plus 64 KiB overhead). Inventory Merge additionally rejects a receipt above **50 total rows**, rather than selecting the next 50 rows; therefore a 51–250-row upload is valid as a preview but cannot be merged as-is. Catalog has a different contract: rows map into product drafts, groups are reviewed independently, and each Create/Update product-group mutation is capped at 250 variants. These are separate state machines; a shared upload/parser layer must not unify their validation, approval, or execution rules.

CSV parsing/normalization and PostgreSQL inserts are not the measured bottleneck at 1,000 synthetic rows. The blocking constraints are the 250-row intake guards and Inventory Merge's whole-receipt 50-row guard. Live Shopify lookup and mutation latency, throttling, and worker/request duration remain unmeasured; those require development-store API traffic and are deliberately excluded from this benchmark.

## Existing path and limits

| Surface | Current behavior / limit | Capacity implication |
|---|---|---|
| Inventory CSV upload | Bounded multipart read; 1 MB CSV / 250 data-row checks in `csv-limits.js`, route and parser | 1,000-row files are rejected before a receipt exists |
| Inventory preview persistence | Shop-scoped, serializable receipt + nested line writes, idempotent submission token and duplicate-file checksum; persists normalized operation rows, but not original CSV bytes | Row persistence is atomic; exact source-file retention needs a deliberate schema addition |
| Inventory Shopify comparison | SKU lookup in bounded groups of 20, up to 100 variants/page and 20 pages per lookup; incomplete lookup blocks matching rows | A 1,000-distinct-SKU preview can require many read requests; do not classify incomplete results as unmatched |
| Inventory execution | `mergeImportBatch` checks the **whole** batch size against 50 and then processes lines sequentially with durable per-line state/lease and Shopify idempotency; UNKNOWN work is not safe for automatic resend | No current internal chunking. A 1,000-row workflow needs bounded, persisted chunk progression while preserving reconciliation rules |
| Catalog CSV upload | Same 1 MB / 250-row limit; original CSV, headers and checksum are persisted, then mapping writes normalized lines via `createMany` and group suggestions | 1,000 rows are rejected; existing persisted source data can be reused |
| Catalog compare | Reads a paginated Shopify variant snapshot (250/page, up to 100 pages / 25,000 variants, with inter-page wait) | Whole-store comparison cost grows with store size; retain bounded/incomplete semantics and assess targeted SKU lookup before raising limits |
| Catalog execution | Product groups are explicitly reviewed/confirmed; Create/Update execution rejects a group above 250 variants and uses durable per-group operation/item/attempt history | Catalog remains product-metadata execution, not inventory Merge; any multi-request product execution needs a separate idempotent plan |

## Synthetic in-memory measurements

Fixtures are generated in memory: 6-column Inventory CSV and 10-column Catalog CSV. For each operation, 15 samples were measured with forced GC before each timed call; values below are the median `performance.now()` duration and immediate `heapUsed` delta. Runtime: Node v26.9.0. Fixture generation is outside the timed operation.

| Data rows | Inventory parse + validation (ms / heap delta KiB) | Catalog parse (ms / heap delta KiB) | Catalog normalize (ms / heap delta KiB) | Inventory / Catalog CSV bytes |
|---:|---:|---:|---:|---:|
| 50 | 0.206 / 171 | 0.297 / 158 | 0.127 / 151 | 4,261 / 6,169 |
| 250 | 0.544 / 846 | 0.234 / 795 | 0.490 / 735 | 21,865 / 31,172 |
| 500 | rejected at row cap (0.230 ms / 614 KiB) | parsed, then rejected at row cap (0.446 ms / 1,599 KiB) | not reached | 44,115 / 62,714 |
| 1,000 | rejected at row cap (0.243 ms / 614 KiB) | parsed, then rejected at row cap (0.904 ms / 3,191 KiB) | not reached | 88,619 / 126,092 |

These are parser/normalizer deltas, not peak RSS. Inventory's parser stops when its bounded record count is crossed; Catalog currently constructs the rows before checking the row cap. Thus the measured Catalog rejected-path allocation grows with the submitted file, even though uploads remain byte-bounded.

## Isolated PostgreSQL persistence measurements

Database: fresh, disposable PostgreSQL 16 `stockhub_regression`, user `stockhub_test`, bound to exact loopback `127.0.0.1:55432`; migration guard verified server and client addresses. Five samples per size; reported values are median write-transaction duration, excluding fixture construction and post-write count verification. Each fixture's row count was checked, then rows were deleted. No Shopify API was called.

| Data rows | Inventory receipt + nested line insert | Catalog mapping CAS + `createMany` lines |
|---:|---:|---:|
| 50 | 9.54 ms | 10.31 ms |
| 250 | 22.28 ms | 24.39 ms |
| 500 | 36.29 ms | 45.29 ms |
| 1,000 | 65.54 ms | 74.17 ms |

Catalog timing excludes original-upload receipt creation and group-suggestion computation; Inventory timing models persisted normalized line records and does not yet include a source CSV column. These local timings establish that one 1,000-row database transaction is inexpensive on this host, not that a 1,000-row Shopify mutation request is safe.

## Bottleneck conclusion and M1 design direction

1. Raise both domain row ceilings to at least 1,000 while keeping the measured 1 MB byte limit, bounded multipart body read, malformed-row rejection, and clear over-limit errors. Existing fixtures of 1,000 rows are 89–127 KB, well under that limit; a larger-than-limit file remains rejected rather than buffered without bound.
2. Preserve Inventory receipt semantics and its server-side Shopify-state verification. Store the original source CSV (or a lossless row representation) alongside the checksum so every input row can be reconstructed. Give each row a stable tenant/receipt-scoped identity.
3. Replace Inventory's all-or-nothing 50-row batch-size check with **server-defined, persisted chunks of at most 50 eligible lines**. Persist progress per line/chunk, revalidate current state at each boundary, and make interruption recovery resume only safe pending work. UNKNOWN operations must route to reconciliation and never be automatically resent.
4. Keep Catalog mapping, grouping, field decisions, explicit confirmation, and product execution separate from Inventory. Persist the full 1,000-row draft once, keep pagination/bounded UI rendering, and execute only explicitly confirmed groups through the existing operation/item/attempt ledger. Do not split an oversized product group into extra mutations unless an idempotent multi-call product plan is proven; return a clear conflict otherwise.
5. Add route and PostgreSQL tests for 1,000-row accounting, row identity, progress monotonicity, duplicate submission/file handling, concurrency, interruption after a chunk, tenant isolation, and UNKNOWN reconciliation. No successful test may imply a Shopify mutation was performed.

## Verification baseline

- `npm test`: 326 total, 288 passed, 0 failed, 38 PostgreSQL-gated skipped.
- Fresh guarded PostgreSQL setup: all 8 migrations applied successfully to the disposable `stockhub_regression` database.
- `npm run test:postgres`: 50 passed, 0 failed, 0 skipped; includes inventory merge lease/recovery, catalog persistence/execution, P1 review CAS/staleness, and database guard cases.
- Git was not changed by the benchmark report itself; Development/Render TOML edits, backup, and the existing roadmap are pre-existing WIP and must remain unstaged.

## Limits of this benchmark

No authenticated Shopify query, mutation, rate-limit measurement, browser acceptance, multi-worker load test, concurrent upload load test, or production-like catalog-size test was performed. The parser data are synthetic and do not prove a particular merchant's file fits under 1 MB. These remain separate functional/live acceptance checks for M1/M2.
