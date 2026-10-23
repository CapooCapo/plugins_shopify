# StockHub Sprint 5.1 — Import Workspace UI redesign

**Status: IMPLEMENTATION COMPLETE; VISUAL_QA_PENDING.** The code-level redesign is in place, but the embedded Shopify experience has not been visually accepted. Do not treat this report or passing code checks as UI/UX sign-off.

## Audit of the previous UI

- Primary app navigation already used the supported App Bridge `NavMenu` and included Imports. `/app/imports` and `/app/imports/history` are distinct URL routes presented by the Imports layout's secondary buttons.
- Import workspace already used Polaris Web Components (`s-*`) but mixed them with unstyled native file/select controls. Its page was split among several similarly weighted sections and three large step tiles, obscuring the actual next action.
- The new-import loader/action validates the upload, SKU/location matches and persists a receipt; it redirects to that receipt, which serves as the preview surface. Merge remains a separately confirmed receipt action. This server workflow was intentionally left unchanged.
- History already had server cursor pagination, shop-scoped filters and per-page line-count aggregation. Its rows duplicated the receipt link and expanded into dense per-line progress.
- Receipt detail already carried accurate state and action semantics, including the distinction between Draft creation and inventory activation failure, but presented seven columns (including error and details) across a wide table.

## Changes

- Kept App Bridge primary navigation and the URL-backed New Import / Import History secondary navigation.
- Reworked New Import into a compact Upload → Validate → Review receipt → Confirm merge workflow; grouped the destination, location selector, CSV chooser, constraints, optional columns and advanced authorization diagnostics. The prominent action now clearly names receipt creation, not a Shopify write.
- Consolidated optional-column guidance and advanced authorization diagnostics into one disclosure so installed scopes and verified Admin API domain are each presented once.
- Reworked History hierarchy and search/filter placement. Kept shop-scoped server cursor pagination and server-side line-count aggregation; rows show only one receipt link, location, date, row count and status. Removed duplicate link and expandable line-progress text.
- Reorganized receipt detail around summary, batch progress, explicit actions, verification snapshot and a Line Items table. Reduced the table to SKU, product, quantity, progress and expandable error/technical details; Shopify IDs stay in the expandable area. Added client-side search by SKU/product, status filter and 25-row pagination over the receipt's already-bounded lines. Preserved the existing Draft-created/inventory-activation-failed warning and did not change action handling.

## Routes and components

- `/app/imports` — `app/routes/app.imports._index.tsx`
- `/app/imports/history` — `app/routes/app.imports.history._index.tsx`
- `/app/imports/history/:batchId` — `app/routes/app.imports.history.$batchId.tsx`
- Imports shell and URL tabs — `app/routes/app.imports.tsx`
- App Bridge primary menu remains in `app/routes/app.tsx`.

## Visual and manual acceptance

- Before/after screenshots: **not captured**. The host browser exists, but local Vite preview returned HTTP 500 because `SHOPIFY_APP_URL` is absent; no authenticated Shopify session or isolated preview was established. No mock or hand-authored lookalike screenshot is presented as real evidence.
- New Import and History distinct routes: source-level implementation retained; not manually exercised in a browser during this work.
- Receipt detail, search/filter/pagination, loading/error/empty states, 390px and 1280px responsive behavior, keyboard/focus, and overflow: **not visually verified; VISUAL_QA_PENDING**.
- Performance comparison: **not measured**. The History cursor and aggregation strategy were preserved; no Shopify API or server operation was added.
- CSV preview: the existing validated, persisted receipt is the preview surface after upload. Its Line Items view includes search, status filter and pagination, with key fields in the table. Error rows expose a conditional “Error details” disclosure; every row exposes a separate “Technical details” disclosure with Shopify IDs and the existing copy workflows. No pre-submit inline preview or new write route was introduced; Merge still requires the existing explicit confirmation.

## Code checks

- `npm run typecheck` — PASS after reviewer corrections.
- `npm run lint -- --no-cache` — PASS after reviewer corrections.
- `npm run build` — PASS after reviewer corrections.
- `node --test tests/app-shell-navigation.test.mjs tests/import-route-split.test.mjs tests/import-ux-regressions.test.mjs` — PASS, 20/20 after updating source assertions for the revised disclosure structure.
- Full test suite — PASS, 140/140 (tester verification).
- Reviewer code review — APPROVED. Visual QA remains pending and is not implied by code review or test results.

Passing code checks do not substitute for visual QA.
