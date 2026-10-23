# StockHub Sprint 1–3 Execution Report

**Repository:** `/home/giahoang/dev/plugin_shopify/stockhub`  
**Plan baseline:** `STOCKHUB_MVP_FUNCTIONAL_PLAN_v1.md`, `STOCKHUB_SPRINT_1_2_3_PLAN.md`, `STOCKHUB_RECEIVING_ACCEPTANCE.md`  
**Overall status:** **PARTIAL** — implementation, automated functional checks, and independent code review passed; authenticated embedded-browser outcome and live Shopify inventory snapshot permission remain unverified.  
**Scope boundary:** Sprints 1–3 only. No Shopify mutations, existing development database migration, legacy batch modification, commit, push, or deploy was performed.

## Summary

The existing application was audited before changes. Its legacy `ImportBatch` / `ImportLine` workflow was retained as import history and was not reinterpreted as physical Shipment or Receipt data. New Shipment, Receipt, CSV-import, inspection, exception, and pending-operation records were added additively. Authenticated loaders/actions use the shop from the server-side Shopify session; Receipt records are bound to one Location.

All migrations were exercised against disposable temporary SQLite databases. The repository's existing `prisma/dev.sqlite` was not migrated, reset, seeded, or otherwise written. Existing Shopify product/inventory mutation paths were not called. The only new Shopify GraphQL operation is a read-only inventory snapshot query; it passed schema validation for Admin API `2026-10`.

### Overall verification

- Final full suite: `node --test tests/*.test.mjs` — **192/192 passed**.
- Focused final Sprint 3 tests: `node --test tests/receiving-s3-inspection.test.mjs tests/receiving-s3-concurrency.test.mjs` — **3/3 passed**.
- Final `npm run lint` — **PASS**.
- Final `npm run typecheck` — **PASS**.
- Final `npm run build` — **PASS**; existing React Router future-flag and empty webhook-chunk notices remain.
- Final `npx prisma validate` — **PASS**.
- Independent review: Sprint 1 approved; Sprint 2 approved; Sprint 3 P1 and disposition-guard fixes approved.
- Authenticated embedded application/browser and live Shopify matching/snapshot: **NOT VERIFIED**.

## Sprint 1 Report

### Completed

- Added shop-scoped Shipment foundation, validated reference identity, optional expectations, list/detail routes, Receipt Draft creation, closure/reopen events, and Shipment-to-Receipt relationships.
- A Shipment can have multiple Receipt Drafts; each Receipt has one shop and one Shopify Location. Closed Shipments reject new Receipts until reasoned reopen.
- No Shopify inventory or product writes were introduced.

### Reused

- Existing Shopify admin authentication and server-derived shop context.
- Existing active Location lookup/validation.
- Existing app shell and React Router structure.
- Existing ImportBatch history remains separate and unchanged.

### Changed

- Added additive Shipment/expectation/Receipt/event Prisma models and migration `20261023090000_add_shipments_receipts`.
- Added `app/utils/shipment-domain.js` and `app/utils/shipments.server.ts`.
- Added shipment list, create, and detail routes; connected Receiving through `app/routes/app.tsx`.
- Added migration/service tests under `tests/shipments-*`.

### Tests

- At Sprint 1 checkpoint: full suite **159/159**; focused Shipment/migration tests **7/7**.
- Lint, typecheck, and production build passed.
- Independent reviewer: **APPROVED**. Isolated migration checks used temporary SQLite.

### Architecture review

- Shop ownership and composite shop relations were checked; reference uniqueness uses shop, reference type, issuer, and normalized reference while retaining display text.
- Nullable expected quantities remain unknown, not zero. Receipt creation is idempotent by server-issued form identity.
- Legacy import history was not migrated or mutated.

### Risks / blockers

- Authenticated embedded UI was not available for visual/runtime acceptance: **NOT VERIFIED**.

### Approval required

- Apply the additive migration to any persistent/shared database only through a separately approved migration operation.

### Status

**PARTIAL** — implementation, functional checks, and review passed; authenticated UI outcome is not verified.

## Sprint 2 Report

### Completed

- Added Expected Goods and Received Goods CSV modes, flexible Vietnamese/English header mapping, manual mapping overrides, source-row preservation, row/file validation, leading-zero SKU handling, shop-scoped matching, proposal decisions, duplicate-row merge decisions, and duplicate-upload protection.
- Expected Goods now persist as a preview/attempt first. Only explicit confirmation applies valid and explicitly merged expected quantities. Re-upload and merge decisions alone do not write expected quantities.
- Received Goods require a same-shop, same-Shipment Receipt Draft. Shopify Admin GraphQL usage is read-only; no Product/Variant or inventory mutation is performed.

### Reused

- Existing CSV parsing safeguards and authenticated routes, extended rather than replaced.
- Existing Shipment/Receipt Draft, Shopify auth, and shop-context services.
- Existing legacy ImportBatch history remains separate and untouched.

### Changed

- Added `ReceivingImportAttempt`, `ReceivingImportRow`, and proposal-group data with additive migration `20261023130000_receiving_csv_imports`.
- Extended `app/utils/csv.server.ts`; added `app/utils/receiving-import.server.ts` and the Shipment CSV-import route.
- Added mapping, validation, proposal, persistence-boundary, and isolated-Prisma regression tests.

### Tests

- Final Sprint 2 checkpoint: full suite **189/189**; focused proposal/Prisma tests **21/21**.
- Lint, typecheck, build, and Prisma validation passed.
- Independent reviewer: **APPROVED** after fixing preview-before-write, stale proposal-group eligibility, and merge-after-confirm guards.
- Temporary Prisma tests verified no expectation writes before explicit confirmation, eligible valid/merged rows applied once, replay idempotency, partial-row retention, Received-mode boundaries, and shop isolation.

### Architecture review

- Exact-SKU ambiguity is never auto-resolved; proposal groups are revalidated before confirmation, and grouped rows must be split before subsequent matching.
- Expected/Received modes are distinct, source rows and row errors are retained, and expected quantities are only written by the explicit confirmation path.
- New S2 Shopify calls are GraphQL reads only. No Shopify mutation was found in the new workflow.

### Risks / blockers

- Authenticated embedded UI and live Shopify matching were not verified.

### Approval required

- Persistent database migration remains a separate approval gate. No Shopify scope/config change is included.

### Status

**PARTIAL** — implementation, functional checks, and review passed; authenticated UI/live matching are not verified.

## Sprint 3 Report

### Completed

- Added Receipt inspection preparation and editing, explicit Mark All Accepted, Wrong Item exception capture, quantity discrepancy summary, final preview with per-line read-only inventory snapshot, confirmation, and pending future inventory operations.
- Enforces integer/nonnegative counts and `Received = Accepted + Damaged + On Hold`. Wrong Items remain separate exceptions. Only accepted quantity for an exact existing variant can become a proposed delta; unresolved/blocked items do not produce operations.
- Receipt confirmation is shop-scoped, immutable, idempotent, and uses an atomic `DRAFT` compare-and-set. Only the winning confirmation creates the event and stable `PENDING` operation records; losing concurrent requests reload the winning result.
- New Received Goods imports are rejected after inspection has begun, preventing source-row omission from a prepared/confirmed Receipt.
- Wrong-item disposition is runtime-whitelisted to `HOLD` or `RETURN` before persistence.
- UI labels prepared operations as pending/not executed; no Shopify sync is claimed.

### Reused

- S1 Receipt Draft, single-Location association, Shipment route, and shop authentication.
- S2 source rows, matching outcomes, import errors, and proposal records.
- Existing Shopify Admin client for the preview-only read.

### Changed

- Added additive migration `20261023180000_receipt_inspection_foundation` and inspection, exception, confirmation, and inventory-operation models.
- Added `app/utils/receiving-inspection.server.ts` and `app/routes/app.receipts.$receiptId.tsx`.
- Extended `app/routes/app.shipments.$shipmentId.tsx`, `app/utils/shipments.server.ts`, and temporary-database fixtures/tests.
- Added inspection, wrong-item validation, late-import guard, and concurrency regressions.

### Tests

- Final full suite: **192/192**.
- Focused Sprint 3 inspection/concurrency suite: **3/3**; independent temporary-Prisma concurrency/inspection checks passed.
- Lint, typecheck, production build, and Prisma validation passed.
- Read-only snapshot query validated by Shopify's Admin GraphQL schema validator for version `2026-10`.
- Independent reviewer approved the two P1 fixes (late-import coverage and atomic concurrent confirmation) and the runtime disposition whitelist.

### Architecture review

- Temporary SQLite migration tests exercise all additive migrations; no current project database was written.
- Tests verify 70 received → 65 accepted + 5 damaged → proposed `+65`, unmatched goods held with no operation, wrong items separate, stable pending operation identity, concurrent/double confirmation, source immutability, and shop isolation.
- No Shopify mutation operation was introduced or executed.

### Risks / blockers

- Authenticated embedded UI and real Shopify snapshot/matching remain **NOT VERIFIED**.
- The Shopify query validator listed `read_products`, `read_inventory`, `read_locations`, and `read_markets_home` as required. Current `shopify.app.toml` includes `read_products`, `read_inventory`, and `read_locations`, but not `read_markets_home`. This was not confirmed against the live installed app. No scope or app configuration was changed. The live snapshot permission is therefore **NOT VERIFIED** and may require separate scope review/approval if Shopify rejects the query.
- The query's available quantity is a timestamped preview snapshot, not a guarantee that stock remains unchanged after preview.
- Full post-confirmation Resolution workflow remains deferred to Sprint 5; Sprint 3 only preserves the Receipt lineage/data boundary.

### Approval required

- Approval before applying migrations to a persistent/shared database.
- Separate review/approval before any Shopify scope change, app reauthorization, or deployment. None was performed.

### Status

**PARTIAL** — code, functional checks, and independent review passed; authenticated UI and live Shopify read authorization are unverified.

## Module architecture after Sprints 1–3

- **Shipment domain:** Shipment identity, optional expectations, state transitions, Receipt Draft association, and append-only lifecycle events.
- **Import domain:** Expected/Received modes, mapping, validation, source-row persistence, matching, proposal/merge decisions, and explicit expected-plan confirmation.
- **Inspection domain:** Physical quantity classification, Wrong Item/other exception capture, immutable Receipt confirmation, and stable pending operation preparation.
- **Shopify boundary:** Authenticated, shop-scoped reads for matching and preview; no product creation or inventory writes in these sprints.
- **Legacy import history:** Existing `ImportBatch` / `ImportLine` records and historical statuses remain separate and preserved.

## Missing features and Sprint 4 prerequisites

- No authenticated browser QA or live Shopify read proof. Do not claim the embedded UI or live workflow is accepted yet.
- Confirm the `read_markets_home` validator requirement against Shopify's actual authorization diagnostics; obtain approval before any scope/config change.
- Apply reviewed migrations to a non-production database only after a separate explicit migration authorization; current dev database remains unchanged.
- Sprint 4 must add separately reviewed execution/idempotency/reconciliation for pending operations. Current `PENDING` records are not executed, retried, or marked synced.
- Sprint 5 must implement linked Resolution/Adjustment workflow for correcting confirmed Receipt data without recounting original physical quantities.

## Repository and delivery status

- No commit, push, deploy, or publish was performed.
- The checkout was already reported as broadly untracked before implementation; it remains an uncommitted working tree. No destructive Git cleanup was run.
- No current `prisma/dev.sqlite` migration/write, historical ImportBatch modification, Shopify API/CLI write, app-scope change, or product/inventory mutation was performed.
