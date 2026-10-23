# StockHub Sprint 5.2 — Overview, Products & Stores UI

**Status: CODE/UI IMPLEMENTATION COMPLETE; VISUAL_QA_PENDING.** The route-level redesign is implemented and must not be treated as visual acceptance.

## Audit findings and truthful data boundaries

- Overview's existing five KPIs included a literal “Not calculated” store-wide SKU placeholder. Available live data supports the authenticated shop, product counts with Shopify's `EXACT`/`AT_LEAST` precision, shop-scoped import counts and failed batches, plus five recent receipts.
- Products already uses bounded server cursor pagination, title search and exact-variant SKU search, and status filters. The existing query returns only the first ten variants for ordinary product listing. `inventoryQuantity` is Shopify's product-wide total across locations; it cannot be presented as location-specific stock.
- Stores is one session-authorized Admin shop, not a connected-shop registry. Store detail already scopes route access to the authenticated shop, loads up to ten locations, five recent receipts and current scope/location verification.
- If current grant checks cannot be cross-verified, the UI must show an unknown/unverified state rather than a confirmed missing-scope or connected status.

## Changes made

- Overview: removed the unsupported SKU-total placeholder and numeric “Store = 1” metric. Reorganized the page around the current session shop as nonnumeric context, three supported summary metrics, clear quick-action buttons and a compact recent-receipt table. Product precision and unavailable import reads remain explicit; recent imports remain limited to five and shop-scoped. Added a route-pending `s-spinner` with accessible label while keeping the dashboard page shell stable.
- Products: consolidated search controls into responsive Polaris `s-select`/`s-option` controls and made the search intent and product-wide quantity semantics clear. Reduced the catalog's primary table to Product, Status and Variant details; variant SKU, price and total sellable quantities live in an expandable per-product disclosure, with a truthful notice when only the first ten are loaded. Kept the existing cursor pagination and exact SKU result semantics; no location filter or new API query was added.
- Stores: replaced the database-like one-row table with a focused current-session shop summary and a single Store details action. No connect/disconnect/sync affordances were added.
- Store detail: status now reads “Authorization verified” only after scope grants agree with the location query; otherwise it says “Authorization unknown.” Missing permissions are described as confirmed missing only when grants are verified. The unverified/mismatch state does not claim missing scopes.
- Existing App Bridge `NavMenu` remains the primary navigation. No loader query/API behavior, tenancy checks, database schema or mutation semantics were changed; Store Detail's presentation now interprets its existing loader-derived `scopesVerified` and `missingReadScopes` fields as verified/missing versus unknown.

## Routes

- `/app` — `app/routes/app._index.tsx`
- `/app/products` — `app/routes/app.products.tsx`
- `/app/stores` — `app/routes/app.stores.tsx`
- `/app/store/:shop` — `app/routes/app.store.$shop.tsx`

## Verification and limitations

- Visual screenshots at desktop/mobile: **not captured**. The local Vite preview returned HTTP 500 because `SHOPIFY_APP_URL` is absent; no authenticated Shopify session or isolated preview was established. Thus 390px/1280px layout, overflow, keyboard/focus, search/filter/pagination interactions, empty/loading/error states, and visual before/after remain **VISUAL_QA_PENDING**.
- Performance: no new Shopify calls or unbounded result sets were added. The existing products cursor and first-ten-variants bound remain; Overview recent batches and Store detail recent imports remain capped at five.
- Polaris loading pattern: Shopify's [SkeletonPage migration guidance](https://shopify.dev/docs/apps/build/app-home/migrate-from-polaris-react/skeleton-page) states there is no direct web-component skeleton equivalent and recommends keeping the `s-page` shell with a labelled `s-spinner` in the pending content region; the Overview uses that supported pattern rather than inventing a skeleton element.
- Shopify Polaris App Home validator: **BLOCKED** because the installed skill bundle is missing `data/types/index.json` (it contains only `data/supported-versions-schema.json`). Typecheck, lint and production build are separate code checks, not a Polaris validator verdict or visual verification.

## Checks

- `npm run typecheck` — PASS.
- `npm run lint -- --no-cache` — PASS.
- `npm run build` — PASS.
- `node --test tests/app-shell-navigation.test.mjs tests/overview-regressions.test.mjs tests/products-filters.test.mjs tests/stores-readonly-ui.test.mjs` — PASS, 5/5 (tester verified; includes confirmed-missing vs unknown authorization regression).
- Full test suite — PASS, 141/141 (tester verified; not run by this implementation agent).
- Shopify Polaris App Home validator — BLOCKED by missing bundled `data/types/index.json`; see above.
- Reviewer verdict: **APPROVED for code/source review** after the requested metric and loading-state corrections. This is not visual acceptance; **VISUAL_QA_PENDING** remains until an authenticated/isolated preview can be captured and checked.

These checks do not substitute for visual QA.
