# StockHub UI Design Brief — Shopify Ops Workspace

**Status:** Design contract for the scoped Overview, Products, and Imports refresh.  
**Direction:** A — Shopify Ops Workspace, with B — Exception-first.  
**Audience:** Shopify merchants preparing product/inventory imports and resolving data issues.

## Product goal

Make StockHub the clear workspace for reviewing import quality and resolving bad or missing CSV rows before any Shopify mutation. Use Shopify Admin for capabilities it already owns; StockHub focuses on safe import preparation, validation, and import history. Keep the UI light, minimal, table-first, and Polaris-aligned. Use restrained, accessible Ready / Warning / Error signals. Do not restore Shipment or Receiving UI or workflows.

## Shared shell and interaction rules

- Preserve the existing Shopify embedded app shell and navigation. Reuse Polaris web components/design primitives and existing StockHub styles before introducing new components or dependencies.
- Page headers use one clear title, short purpose statement, and one primary action where appropriate. Avoid decorative charts and redundant KPI cards.
- Status always has text/icon as well as color. Loading, empty, error, and stale/concurrent-update states are explicit. Mutations announce success/failure accessibly and keep focus in a predictable place.
- Wide data tables may scroll horizontally on tablet/desktop when necessary; at narrow mobile widths switch to readable stacked cards with the same essential fields/actions. Never hide a safety-critical status, row identity, or error explanation.
- No action against Shopify is performed while the merchant is editing a draft. Only the existing, explicit Merge/Resume confirmation can start Shopify writes.

## Overview

1. Header: **Overview**, current store identity, concise purpose, primary **New import** action.
2. **Needs attention** section comes first when failed, uncertain, partial, or otherwise actionable imports exist. Each item shows receipt, location, timestamp, status, affected row summary where available, and a direct link to its history/detail route. Provide a calm empty state when no action is needed. The current count only includes failed/uncertain batches, so broaden it only when loader evidence supports actionable partial batches.
3. **Recent imports** table/list: receipt, location, created time, status, and link to details/history. Keep this operational, not chart-driven.
4. Compact product/import counts may remain only where accurate and useful; do not present totals as actionable work or add chart visualizations.

## Products

1. Header explains that this is a read-only catalog view of the current Shopify store; do not imply StockHub can edit Shopify products here.
2. Filter toolbar: product-name/SKU search, product-status filter, page-size control, and clear/reset affordance. Preserve cursor-based pagination and current query state.
3. Product table: product identity (thumbnail where present, title, status), variant count/expansion, price range with currency, and inventory total. Give columns sufficient spacing and align numeric values. Variant detail remains explicitly nested/expanded so product/variant grouping is visible without implying variants are separate products.
4. Mobile cards retain title, status, price, inventory and variant disclosure. Product-management actions should link to Shopify Admin if already present; do not introduce new mutation capabilities.

## Imports — Draft workspace

### Before merge

1. Header identifies the receipt/file, store and selected location; make the current phase **Draft — not sent to Shopify** unmistakable.
2. Summary counts are **Ready**, **Warning**, and **Error**, derived from current validation. These are presentation buckets mapped from existing row states (do not rename persisted statuses). Counts are interactive filters. Show separate upload/CSV validation versus Shopify execution failure categories; never label an API failure as a CSV issue.
3. Toolbar supports search, status/type filters, sortable columns, page size and pagination. Table identifies each row, SKU, product/variant data, quantity/price as relevant, grouping context, validation status, and row actions.
4. Add, edit and delete are available only for a PREVIEWED, not-yet-merged draft. Edit/add re-run the same validation pipeline and refresh status/counts; delete has a row-specific confirmation/undo-safe affordance. Grouping is a display/review aid only; merchant must explicitly confirm grouping before any grouped operation. Never infer a product group and merge automatically.
5. Selecting a warning/error opens an accessible inline detail panel or dialog showing source (CSV validation or Shopify execution), affected field, row, cause, and a concrete correction. Preserve machine/API detail separately from actionable plain-language guidance.
6. Allow explicit partial merge only when at least one Ready row exists and the merchant confirms the number of rows to be processed and excluded. Failed/blocked rows remain attached to the receipt and are easy to edit/review or use to prepare a corrected follow-up; do not erase history.
7. Merge is a distinct, explicit action with confirmation. Draft editing itself must never call Shopify mutation APIs. Existing duplicate detection, idempotency keys, concurrency guards, resume flow, activity log, and import history remain intact.

### After merge / history

- Lock CRUD once any Shopify execution begins. Show per-line execution state and distinguish API failure/uncertainty from CSV validation. Preserve retry/resume safeguards and immutable history; do not allow a UI edit to rewrite a row already applied or in-flight.

## Responsive and accessibility contract

- Validate at 375/390px mobile, 768px tablet, and 1280px+ desktop. Keep primary actions reachable without horizontal page overflow.
- All controls have labels; row actions are keyboard reachable and have contextual accessible names. Details are operable by keyboard, status changes are announced, focus is managed after dialog close/submission, and text/status contrast is checked.
- On mobile, replace dense tables with row cards; preserve search/filter, status counts, pagination, error details and edit actions without requiring precision hover.

## Safety and data boundaries

- Do not drop or rewrite existing database tables, migrations, or historic import records. Do not perform migrations against production or write to a live Shopify store during this work.
- Keep all Shopify mutation in the existing explicit merge/resume path. Respect existing tenant scoping and server-side authorization for every draft edit.
- Preserve duplicate-file detection, submission identity, row operation/idempotency identifiers, concurrency checks, activity logging and uncertain-result handling.
- Do not add unrequested workflows/features or restore Shipment/Receiving.
- Existing `ImportLine` persists normalized fields but may not preserve the original CSV record. Before implementing CRUD/revalidation, inspect parser/persistence behavior and choose the smallest safe approach: validate edited normalized values using the same rules, or preserve enough source data locally if required. Do not claim a full CSV reparse when the source data is unavailable. Any schema migration stays local/unapplied to production and must retain backward compatibility.
- Existing batch checksum identifies the original upload and powers duplicate-file detection; do not recompute it when a draft row changes. Existing line `operationId`/`idempotencyKey` must be preserved during ordinary draft edits. Group membership has no current persisted representation; implement grouping as an explicit review selection/confirmation, not inferred or silently persisted.
- Existing batch/line states include PREVIEWED, BLOCKED, RUNNING, COMPLETED, PARTIAL, UNCERTAIN and FAILED. CRUD must be server-guarded by authenticated shop ownership and PREVIEWED batch state, with stale/concurrent update detection; lock rows once execution begins.

## Delivery sequence and acceptance evidence

1. Shared UI components/layout: verify existing routes retain shell/navigation and page hierarchy; lint/typecheck.
2. Import table + CRUD: focused unit/action tests prove add/edit/delete are tenant-scoped, restricted to editable PREVIEWED drafts, and do not call Shopify mutation; duplicate/history/idempotency invariants remain.
3. Validation statuses/details: prove revalidation updates all three counts and actionable details distinguish CSV vs Shopify API failures; partial-merge confirmation retains excluded/error rows.
4. Products table readability: verify filters, cursors, variants, numeric alignment and no unintended write actions.
5. Responsive/accessibility/QA: inspect actual rendered Overview, Products and Imports at the target widths; keyboard/status/empty/loading/error states; run relevant lint/typecheck/tests and report actual results. Existing `docs/ui-preview` screenshots are static fixtures only and cannot establish route/runtime correctness.

Do not deploy, change production configuration, apply production migrations, or modify production Shopify data as part of this work.
