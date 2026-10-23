# StockHub UI/UX & Performance Sprint Report

## Scope and constraints

This sprint preserves import/merge/resume business rules, inventory safety checks, tenant isolation, and authenticated Shopify read behavior. No database migration, Shopify write, deploy, commit, or push is in scope. Browser/runtime claims are reported only when directly measured.

## Phase 0 — Baseline and audit

### UI audit

| Page | Problem | UX impact | Performance impact | Priority | Proposed fix |
|---|---|---|---|---|---|
| App shell | Navigation loading is a plain text status; app already uses Shopify web components elsewhere. | Loading state is visually weak and not consistent with the Shopify Admin component language. | No measured render impact. | P2 | Keep App Bridge navigation; use a compact, accessible Shopify loading affordance. |
| Imports / Preview | `app/routes/app.imports.tsx` is 963 lines and combines server actions, upload, preview, history, verification, and confirmation UI. The selected receipt renders full row details and technical IDs inline. | Long page, difficult scanning, excess technical detail, and poor narrow-screen ergonomics. | Up to 250 preview rows can be rendered in one table. | P0 | Summary-first table, search/filter/pagination, expandable row/technical details, clearer workflow and actionable errors. |
| Import History | Loader fetches all line records for the latest 25 batches, then fetches the selected batch with all lines again. History table uses only receipt metadata and row count. | History is mixed with a large selected-batch detail view. | Concrete over-fetch and duplicated rows; theoretical ceiling is 25 × 250 lines before selected batch duplication. | P1 | Load compact history summaries/counts; fetch full lines only for the selected receipt. Add status/search/pagination controls. |
| Verify Shopify State | Result is rendered as a wide table; copy action has no visible success feedback. | Hard to scan and unclear whether copying succeeded; snapshot nature needs to be explicit. | No automatic Verify call; that is correct and will remain. | P1 | Row-level status filters, loading feedback, copy feedback, and snapshot warning without automatic calls. |
| Products | Cursor paging and title search exist; variants are nested text in a wide table, with no status/location filter. | Inventory/product state is harder to scan on small screens. | 25 products × up to 10 variants per request; not demonstrated as a bottleneck. | P2 | Improve compact responsive hierarchy and filters while preserving cursor/search semantics and unknown quantities. |
| Overview | Shows live connected-store status and product counts, but not recent import activity. | No quick operational summary for imports. | One combined GraphQL request; no evidence of a performance issue. | P2 | Add only truthful, store-scoped database KPIs/recent imports if simple to query. |
| Stores / Store Detail | Current authenticated store only, with repeated connection explanation/status. | Some duplicated copy; otherwise clear one-store authorization boundary. | One small GraphQL request per page. | P3 | Streamline repeated copy; preserve authenticated-shop matching. |

### Stack and responsive/runtime audit

- Embedded React Router app using App Bridge `NavMenu` and Shopify Polaris web components (`s-page`, `s-section`, `s-table`, `s-badge`, etc.). No Polaris React runtime or additional UI framework is installed. The existing component system is retained.
- Only the public login route has a CSS module; authenticated app layout relies on Shopify component defaults. No design-system dependency will be added.
- Browser automation/authenticated embedded session was unavailable for this baseline. Visual acceptance at 360/390/768/1280px, keyboard/screen-reader behavior, route latency, and actual loader response payload are **not verified**.
- Imports preview accepts up to 250 rows while merge accepts 50. This sprint will surface the limit and next step before the merchant reaches a merge dead end; it will not change server limits or merge behavior.

### Baseline checks and artifact sizes

| Check | Baseline |
|---|---:|
| `node --test tests/*.test.mjs` | 111 passed, 0 failed |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS — 335 client modules; 32 SSR modules |
| Client JavaScript output | ~298.02 kB (build artifacts, not browser transfer timing) |
| Client CSS output | ~0.76 kB |
| Server bundle | ~157.90 kB |
| `npx prisma validate` | PASS |

Build emitted existing React Router v8 future-flag warnings and empty auth/webhook route chunks. No failures. These baseline sizes describe the build output only; they are not user-perceived latency benchmarks.

## Sprint results

### UI before / after summary

| Surface | Before | After | Evidence / limit |
|---|---|---|---|
| App shell | Plain-text route-loading message | Shopify `s-spinner` plus polite `role="status"` announcement | Typecheck/build pass; browser/screen-reader behavior not verified. |
| CSV Preview | Up to 250 rows rendered with technical/error details inline | Search by SKU/product title, All/New/Existing/Blocked filter, 25 rows/page, native expandable row details | Existing data/action flow retained; interaction and mobile table layout not browser-tested. |
| Import History | 25 batches loaded with every child line, although the list used only counts; no history filters or older-page navigation | Receipt search, whitelisted status filter, deterministic bounded `(createdAt,id)` keyset Older/Newer pagination, compact batch summary and one batched grouped-count query; full lines fetched only for the selected batch. | Concrete response-data over-fetch removed. Query count is up to four when cursor validation is needed (cursor validation, page summaries, aggregate, selected detail) rather than two line-bearing queries; payload bytes and route latency were not measured. |
| Overview | Live product KPIs only | Adds shop-scoped import/failed batch counts and up to five recent receipts; DB failure is shown as unavailable | New KPI reads add three concurrent SQLite reads; no live DB/browser timing benchmark. |
| Products | Cursor-paginated title search | Adds whitelisted Active/Draft/Archived/Unlisted status filter; preserves search/status across cursor navigation | Search query syntax checked against Shopify product docs; live Shopify query and browser behavior not verified. |
| Stores | Already reflects only the currently authorized store and links to its detail page | No behavior change | Existing tenant boundary already matches the audit; no additional query or UI change was justified. |

The work prioritizes clarity and bounded rendering/data transfer; it does **not** claim faster live navigation. No before/after browser timing, request waterfall, visual screenshot, or screen-reader test was available.

### Current verification and review

- `node --test tests/*.test.mjs`: **115 passed, 0 failed** (baseline was 111; +4 source-contract regressions for compact history aggregation, History filtering/keyset links, Overview KPIs, and product status filter).
- `npm run lint`, `npm run typecheck`, `npm run build`, `npx prisma validate`: **PASS** on the final UI checkout.
- Independent reviewer: Sprint A design **APPROVED** after clarifying append-only attempt/outcome events; History query/presentation and keyset cursor **APPROVED**; Overview **APPROVED**; Products status filter **APPROVED**.
- Independent tester: all final automated checks pass. UI interaction tests are structural source assertions, not browser interactions; History aggregation is not fixture-backed.
- Current generated route assets: Imports 19.58 kB, Products 3.38 kB, Overview 3.28 kB; CSS 0.76 kB. These are build artifacts, not transfer timing or runtime performance measurements.
- Build still emits empty auth/webhook chunk notices and five React Router v8 future-flag warnings.
- Shopify Polaris validator was **not verified**: the installed toolkit validator could not resolve `typescript` from its skill directory. Project TypeScript, lint, and production build checks passed instead.
- Authenticated embedded browser, responsive breakpoints (360/390/768/1280), keyboard/screen-reader interactions, real route latency, large-list render timing, and live Shopify query behavior remain **not verified**.

Files touched by the current UI/design sprint: `app/routes/app.tsx`, `app/routes/app.imports.tsx`, `app/routes/app._index.tsx`, `app/routes/app.products.tsx`, `tests/imports-regressions.test.mjs`, `tests/overview-regressions.test.mjs`, `tests/products-filters.test.mjs`, `ACTIVITY_HISTORY_DESIGN.md`, and this report. The checkout was already entirely untracked before these changes, so Git cannot independently distinguish these edits from its pre-existing untracked baseline.

## Added scope — Activity History / Audit Trail (Sprint A design)

Architecture proposal is documented separately in [ACTIVITY_HISTORY_DESIGN.md](./ACTIVITY_HISTORY_DESIGN.md). The proposed model is tenant-scoped by `shop`, attributes a human only from an authenticated online Shopify user ID, links import records to receipt/batch/line, uses allowlisted metadata, and supports indexed keyset pagination. It also defines attempted/succeeded/failed/uncertain/blocked semantics and requires shop-redaction deletion.

No ActivityLog schema or migration has been created or applied. Retry identity, logging-outage policy, actor-label PII, and retention require an explicit design decision before persistence integration. Sprint 5.3 adds an authenticated, URL-backed Activity History route under Imports, but the page is intentionally unavailable and performs no event query or persistence; it directs merchants to real Import History. There are no demo/sample events. Visual QA remains pending. The design was independently reviewed and approved; no database or Shopify mutation changes occurred during Sprint 5.3.
