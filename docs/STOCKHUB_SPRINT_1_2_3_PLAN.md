# StockHub Sprints 1–3 Execution Plan

**Status:** Approved for implementation by the user request in this session.  
**Repository:** `/home/giahoang/dev/plugin_shopify/stockhub`  
**Run boundary:** audit and lock baseline → Sprint 1 → Sprint 2 → Sprint 3. Do not begin Sprint 4.

## Preflight snapshot and constraints

- Shopify embedded application using React Router `7.18.2`, TypeScript `5.9.3`, SQLite, and Shopify Admin GraphQL API October 2026. Lockfile resolves Prisma CLI `6.19.3` (manifest range `^6.16.3`).
- `git status` reports every project file untracked; branch `main` has no commits. Preserve the existing checkout and its contents. Do not run destructive Git commands or claim a meaningful committed diff.
- Existing Prisma schema contains `Session`, `ImportBatch`, `ImportLine`, and `ImportReceiptCounter`; `ImportBatch` has shop-scoped idempotency/reference constraints, while import operations already have stable IDs and persisted statuses.
- Existing modules include authenticated imports/history, CSV preview/parser, shop location loading, import persistence, Shopify merge/verification services, and tests. Prefer extending these over replacing them.
- CSV parser currently accepts fixed headers (`sku`, `quantity`, `title`, `description`, `price`, `image_url`), requires SKU/quantity, and treats duplicate exact SKUs as invalid rows. It preserves source line numbers and handles quoted CSV/BOM/CRLF. Flexible mapping and Expected/Received modes are new work.
- Existing ImportBatch preview, receipt numbering and import history are not physical Shipment/Receipt facts. Product lookup is exact SKU-based; ambiguity is blocked, but product grouping and explicit option proposals are absent.
- `app/routes/app.imports._index.tsx` and `app/utils/import-merge.server.ts` contain authenticated Shopify product/inventory mutation paths (including Merge/Resume). New Sprint 1–3 actions must not dispatch to them.
- `shopify.web.toml` `dev` command runs `npx prisma migrate deploy` before the server. `setup` and `docker-start` also migrate. Do not run these against the existing DB.
- Read-only inspection of `prisma/dev.sqlite` found 3 batches; `nhap_hang_001` for the demo shop is `FAILED`. Never resume, modify, seed over, or reinterpret it.
- Scripts include `dev` (Shopify CLI, possible config/tunnel side effects), `setup` (Prisma generate and migrate deploy; forbidden against current DB), `build`, `lint`, `typecheck`, and focused CSV tests. Do not start Shopify CLI without inspecting lifecycle effects. Use temporary isolated SQLite for migration tests.
- No existing Shopify dev-store changes or database mutations are permitted in these sprints.
- Baseline broad regression run: `node --test tests/*.test.mjs` → 152 passed, 0 failed (source/mock/service-level checks; not authenticated Shopify/browser evidence).

## Dependency order

`Audit + functional plan + acceptance matrix → Sprint 1 domain foundation → Sprint 2 import/matching against Shipment/Receipt drafts → Sprint 3 inspection/confirmation and pending-operation preparation → independent review and consolidated report.`

Sprints are sequential; dependent sprint implementation starts only after the preceding sprint's essential contracts and checks are reviewed. Any unexpected baseline change invalidates the affected sprint assumptions and requires reinspection.

## Step 0 — Audit and plan freeze

### Goal

Inventory existing implementation, schema/migrations, scripts/side effects, historical data, authentication/shop isolation, and tests. Publish the functional contract and scenario acceptance matrix before schema or product behavior changes.

### Reuse map (initial, to confirm during audit)

| Area | Initial disposition | Existing evidence |
| --- | --- | --- |
| Shopify auth and shop context | REUSE | `app/shopify.server.ts`; routes call `authenticate.admin` and use session shop |
| Location discovery/validation | REUSE / EXTEND | `app/utils/shopify-locations.server.ts`; imports validate against current active locations |
| CSV parsing/limits | EXTEND | `app/utils/csv.server.ts`, `app/utils/csv-limits.js`; current parser has fixed headers and validation |
| Import Batch/Line persistence/history | EXTEND, preserve legacy | `prisma/schema.prisma`, `app/utils/import-receipts.server.ts`, import history routes |
| Product/variant lookup | EXTEND | imports route performs shop-authenticated SKU lookup and classifies ambiguous matches |
| Shopify writes | KEEP OUT OF SCOPE | `app/utils/import-merge.server.ts` contains live mutation paths; new workflows must not call them |
| Shipment, Receipt aggregate and inspection | NEW additive domain layer | Existing ImportBatch is a legacy import attempt/receipt-like record, not sufficient evidence to reinterpret as a confirmed physical Receipt |

### Planned baseline documents

- `docs/STOCKHUB_MVP_FUNCTIONAL_PLAN_v1.md`
- `docs/STOCKHUB_SPRINT_1_2_3_PLAN.md`
- `docs/STOCKHUB_RECEIVING_ACCEPTANCE.md`

### Acceptance

- Audit identifies reusable and unsafe-to-reuse functions with source references.
- Scope and decisions are frozen without reinterpreting legacy data.
- Acceptance matrix states expected results for T01–T18.

## Sprint 1 — Shipment and Receipt foundation

### Goal and excluded work

Create a shop-scoped Shipment aggregate, Receipt drafts each bound to one Shopify Location, list/detail/timeline actions, closure and reasoned reopen events. No inventory/product Shopify mutations, no advanced purchasing, no full exception-resolution workflow.

### Initial likely write scope (refine after audit)

- Additive Prisma models and generated migration under `prisma/` for Shipment, Shipment line expectations (optional), Receipt, append-only shipment events, and any necessary constraints/indexes.
- New focused domain modules under `app/utils/` for shipment persistence, duplicate reference normalization, state transitions, and invariants.
- New React Router routes/components and route registration for Receiving shipments, detail, create, and Receipt draft initiation.
- Focused tests/fixtures under `tests/` for isolated temporary SQLite or service-level fake DB paths.

### Acceptance

1. Shipment ID is server-generated; shop, reference type, issuer and reference are validated.
2. Duplicate reference is detected only by shop + reference type + issuer + normalized value; no silent merge/create.
3. Expected quantities are nullable; null never means zero or auto-close.
4. One Shipment can contain multiple Receipt drafts at different Locations; each draft has exactly one active, authenticated-Shopify Location.
5. Closed Shipment rejects a new Receipt; reopening requires a reason and appends an event.
6. Closure can retain visible exceptions and uncertain operations, but blocks unresolved drafts/unclassified counts/material unexplained differences.
7. No Shopify write APIs called; legacy ImportBatch/Line and dev DB are untouched.

### Verification

Targeted S1 business and route tests; isolated migration deployment to a disposable SQLite DB; full regression, lint, typecheck, production build; reviewer checks isolation/data integrity and actual route/UI evidence when runtime access is safe. Do not run `npm run setup` against the project database.

## Sprint 2 — CSV import and Product/Variant matching

### Goal and excluded work

Support Expected Goods and Received Goods CSV modes, mapping/validation, partial row processing, shop-scoped matching, proposals/review decisions, explicit duplicate-row decisions, and durable original source data. Do not create Shopify Products/Variants or adjust inventory.

### Initial likely write scope (refine after Sprint 1)

- Extend `app/utils/csv.server.ts` or add focused mapping/validation modules without regressing its parser safeguards.
- Add additive import-attempt/source-row/mapping/review models and isolated migration if required.
- Add focused import workflow routes/components integrated with Shipment/Receipt Draft.
- Preserve Import History behavior and existing `ImportBatch`/`ImportLine` schema/data as legacy records.
- Extend focused CSV/import/matching tests and non-sensitive fixtures.

### Acceptance

1. SKU+Quantity minimum, flexible mappings, UTF-8/Vietnamese headers and leading-zero SKUs preserved.
2. File-level unreliable structure/mapping blocks all processing; row-level errors retain original values/row and allow valid rows to continue.
3. Expected Goods never create physical Received quantity or Shopify operations.
4. Matching is shop-scoped; ambiguous SKU/variant is blocked for review; new product/variant are proposals only.
5. Duplicate SKU rows require explicit merge and preserve source rows; conflicting rows are not auto-merged.
6. Re-upload produces duplicate warning only and no receipt/operation replay.
7. Tests cover user T01, T04, T07–T10, T14–T16, T18 as applicable; no Shopify mutations.

### Verification

Parser/mapping/matching tests including all required edge cases, preserved legacy regression tests, isolated migration tests, full regression, lint, typecheck, build, independent review. UI acceptance requires actual embedded app/browser evidence when available; fixtures alone are not live acceptance.

## Sprint 3 — Quality Inspection and Receipt confirmation

### Goal and excluded work

Inspect Receipt Draft lines, capture Wrong Items/exceptions, validate physical quantity balances, show a final inventory preview, confirm immutable business data idempotently, and prepare stable, not-executed future inventory operations. No Shopify mutations and no full Resolution workflow.

### Initial likely write scope (refine after Sprint 2)

- Focused inspection/confirmation service under `app/utils/` with transactional concurrency/idempotency.
- Additive receipt-line inspection, exception, confirmation, and prepared-operation records/migration as needed.
- Routes/components for inspection, discrepancy summary, final preview, confirm result and pending Shopify sync states.
- Tests for quantity conservation, immutable confirmation, races/double-submit, operation identity, and legacy behavior.

### Acceptance

1. Non-negative integer quantity conservation; 70 received = 65 accepted + 5 damaged yields proposed Shopify delta +65 only.
2. Unmatched physical goods can be held and never become a Shopify target/delta.
3. Mark All Accepted is explicit, reversible before confirmation, and excludes blocked rows.
4. Cannot confirm unbalanced rows, unresolved required classification, or unexplained material discrepancies.
5. Confirmation freezes original physical data; repeated/concurrent confirm yields one confirmation and one pending operation set.
6. Prepared operations have stable identity, shop, source Receipt/line, one location, exact target when known, accepted delta, and not-executed state.
7. UI never claims Shopify sync succeeded; closure retains exceptions and history.
8. Future Resolution can link to original receipt without recounting physical quantity; no full resolution implementation in S1–3.
9. Tests cover T02–T06, T11–T18 as applicable; all Shopify write paths remain unused.

### Verification

Business-rule tests, transaction/concurrency tests, migration tests on isolated SQLite, regression, lint, typecheck, build, independent security/business review, actual UI gate if authenticated browser/runtime is available. Shopify live behavior and all mutation claims remain NOT VERIFIED/not applicable by scope.

## Cross-cutting safety and quality gates

- No `dev.sqlite` migration/reset/seed/truncate, no existing batch Merge/Resume, no Shopify product/inventory mutation, scope/config/deploy change, commit, push, or publish.
- Verify all loaders/actions authorize via Shopify auth and use authenticated shop from server context, never a client-supplied shop identifier.
- Generated migration is additive, reviewed, and tested only in a disposable DB. Existing data compatibility must be inspected without writing the live dev database.
- No tests, fixtures, or screenshots are described as Shopify-live proof.
- Sprint report status is `PASS`, `PARTIAL`, or `BLOCKED`; required unrun checks are `NOT VERIFIED` and prevent claiming PASS.

## Change Map and concurrency

Shared/high-conflict surfaces: `prisma/schema.prisma`, Prisma migrations/client generation, `app/routes/app.imports._index.tsx`, global routing/CSS, package scripts, and shop-auth/data-access helpers. Sprint 1 owns Shipment/Receipt files and additive schema first; Sprint 2 extends import/matching only after S1 review; Sprint 3 owns inspection/confirmation after S2 review. No simultaneous edits to shared schema/routes. Specialist work is bounded by exact sprint files; reviewer/tester are read-only unless explicitly tasked to own tests.
