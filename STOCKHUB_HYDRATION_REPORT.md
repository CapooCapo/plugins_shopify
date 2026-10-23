# StockHub P0 hydration report

## Status

- **Root cause:** identified and fixed.
- **Live embedded-app reproduction:** NOT REPRODUCED locally; no authenticated Shopify Admin browser session is available in this workspace.
- **Automated regression:** PASS.
- **CSS persistence in a live iframe:** BLOCKED pending authenticated-session validation.
- **Visual QA initial / 3s / 10s in a live iframe:** BLOCKED pending authenticated-session validation.

## Exact mismatch cause

SSR-visible components formatted server-provided timestamps using the runtime locale and timezone:

- `app/components/OverviewDashboard.tsx`
- `app/routes/app.stores.tsx` (Store Detail table)
- `app/routes/app.imports.history._index.tsx`
- `app/routes/app.imports.history.$batchId.tsx`

Products also rendered prices with `Intl.NumberFormat(undefined, ...)`, which selects the server/browser default locale independently.

This produces different initial text nodes when the server and embedded browser do not share timezone/locale. Evidence from the same timestamp, `2026-10-22T08:00:00Z`:

| Runtime timezone | Previous `toLocaleString()` output |
| --- | --- |
| `UTC` | `10/22/2026, 8:00:00 AM` |
| `Asia/Ho_Chi_Minh` | `10/22/2026, 3:00:00 PM` |

React hydration requires those server/client text nodes to be identical. A date in an Overview/Stores/History/Receipt response could therefore generate the reported mismatch; after React abandons hydration and remounts, Polaris custom elements can visibly re-upgrade, making the incident appear like a CSS loss.

## Diagnosis exclusions

- No browser-only API is evaluated during initial render. `document`, `window`, and `navigator` accesses are only in event handlers/effects or guarded helpers.
- `randomUUID()` occurs in server loader/action paths, not component render.
- Initial component state is deterministic (`false`, empty strings, empty sets).
- `app/root.tsx` imports the app stylesheet statically and renders React Router `Links`; no application code removes or replaces stylesheet links after hydration.
- The Inter CDN stylesheet can cause a font swap, but it does not explain a React hydration error or removal of StockHub CSS.
- No invalid native HTML nesting that explains the reported text mismatch was found in the audited Overview, Products, Stores, and Imports render paths.

## Minimal fix

Added `app/utils/stockhub-format.js`:

- `formatStockhubDateTime` uses only UTC getters and produces `YYYY-MM-DD HH:mm UTC`.
- `formatStockhubMoney` uses the fixed `en-US` locale.

All SSR-visible timestamp and price renderers now call these helpers. This keeps server markup and the first client render byte-for-byte stable across user locale/timezone differences. It does not defer rendering, disable SSR, suppress hydration warnings, reload stylesheets, or change Shopify workflows.

## Files changed

- `app/utils/stockhub-format.js`
- `app/components/OverviewDashboard.tsx`
- `app/components/ProductsCatalog.tsx`
- `app/routes/app.stores.tsx`
- `app/routes/app.imports.history._index.tsx`
- `app/routes/app.imports.history.$batchId.tsx`
- `tests/hydration-formatters.test.mjs`

## Regression results

- `node --test tests/*.test.mjs` — **18 passing, 0 failing**.
- `npm run typecheck` — **PASS**.
- `npm run lint` — **PASS**.
- `npm run build` — **PASS**.
- The hydration formatter test verifies a timestamp remains `2026-10-22 08:00 UTC` while process timezone changes between UTC, Asia/Ho_Chi_Minh, and America/New_York.
- The same test prevents UI renderers from reintroducing `toLocaleString()` or `Intl.NumberFormat(undefined, ...)`.

## Required live follow-up

In an authenticated Shopify Admin iframe, reload Overview, Products, Stores, New Import, Import History, and a Receipt Detail page with a timestamp. Capture console errors plus the document head at initial load, 3 seconds, and 10 seconds. Expected result: no hydration warning/error; StockHub CSS `<link>` remains present; layout does not remount or change after Polaris finishes loading.

If the Firefox console still reports hydration after this fix, capture the complete React component stack and mismatch snippet, the exact route URL, browser locale/timezone, and DOM/head snapshots before and after the error. That will distinguish an external extension/Shopify DOM mutation from another render mismatch.

## Toolkit note

Shopify App Home documentation search was unavailable in this environment, and the installed Shopify AI Toolkit component validator cannot resolve its own `typescript` dependency. Local typecheck, lint, build, and regression tests were used instead.
