# StockHub UI Redesign Report

## Scope delivered

This pass adds app-owned Egyptian Blue design tokens and branded page composition across existing app routes without changing route loaders/actions, GraphQL, Prisma, authentication, shop isolation, import validation, Verify, Merge, or Resume behavior.

The following existing route surfaces now use app-owned responsive page/panel wrappers while retaining their Polaris/App Bridge composition:

- `/app` — Overview
- `/app/stores` and `/app/store/:shop` — Stores and Store Details
- `/app/products` — Products
- `/app/imports` — New Import
- `/app/imports/history` — Import History
- `/app/imports/history/:batchId` — Receipt Detail and Verify
- `/app/imports/activity` — honest unavailable Activity History state

Overview now uses a wide shop-context hero, full-width metrics panel, and balanced quick-action/recent-import panels. Products uses a branded search panel and catalog/empty/error surfaces. Stores and Store Detail use a connection summary hero and responsive information panels. New Import uses separate workflow and upload panels; History and Receipt Detail use dedicated review surfaces, with Verify results isolated in a highlighted read-only panel. The History filter layout stacks on narrow screens while preserving its GET fields and route behavior. Products, Stores, History, and Receipt Detail share an accessible route-pending indicator that appears only while React Router is loading or submitting. Receipt Detail also has an explicit receipt header and accessible completion progress: only `SUCCEEDED` lines count as completed, so failed/blocked/uncertain rows cannot inflate progress. Activity's unavailable state is presented as a bounded information card. Imports retains the branded app-owned secondary-navigation container. Status badges pair persistent text labels with semantic tones and Polaris icons for success, failure/block, attention, progress, and information; unknown values remain neutral/informational, and FAILED is never displayed as completed. Native links, controls, labels, and disclosures receive shared styling and visible keyboard focus. Shopify Polaris web components remain unmodified and theme-compatible; their own section cards are not double-wrapped with another card surface.

The locked React Router Shopify package is `@shopify/shopify-app-react-router` 3.0.2. Its `AppProvider` injects the unpinned Polaris runtime URL `https://cdn.shopify.com/shopifycloud/polaris.js`. Custom CSS cannot recolor Polaris primary buttons; Egyptian Blue is used on StockHub-owned surfaces and accents, while Polaris primary styling remains controlled by Shopify Admin/theme.

## Changed files

- `app/root.tsx` — load global design stylesheet and mark the app document body.
- `app/styles/stockhub.css` — tokens, native-element styles, accent, responsive and reduced-motion rules.
- `app/routes/app.imports.tsx` — class on app-owned tab navigation only.
- `app/routes/app.imports._index.tsx` — replace inline upload-surface decoration with an app-owned class.
- `app/routes/app._index.tsx`, `app/routes/app.products.tsx`, `app/routes/app.stores.tsx`, `app/routes/app.store.$shop.tsx`, `app/routes/app.imports.history._index.tsx`, `app/routes/app.imports.history.$batchId.tsx`, and `app/routes/app.imports.activity.tsx` — wrap existing page content in app-owned responsive branded surfaces; no loader/action changes.
- `app/components/RoutePending.tsx` — shared accessible React Router navigation/submission status indicator used by Products, Stores, History, and Receipt Detail; it does not change route behavior.
- `app/routes/app.imports.history._index.tsx` — responsive app-owned filter toolbar; preserves the same GET submission fields and method.
- `docs/ui-preview/index.html`, `docs/ui-preview/README.md`, and `docs/ui-preview/screenshots/` — isolated fictional fixtures, responsive captures, and a receipt preview reflecting the source header/progress UI. History filter controls in the static fixture are explicitly labeled native stand-ins, not functional route controls.
- `STOCKHUB_DESIGN_SYSTEM.md` — token and platform-boundary reference.
- `STOCKHUB_UI_REDESIGN_REPORT.md` — this report.
- `STOCKHUB_PERFORMANCE_REPORT.md` — measurement scope and limits.
- `tests/import-ux-regressions.test.mjs`, `tests/imports-regressions.test.mjs`, and `tests/import-route-split.test.mjs` — update source assertions to allow semantic badge tone/icon props while still requiring one compact, human-readable status badge without additional line/progress content.

## Verification and limitations

- Routes and behavior were preserved; this was a layout and presentation-only pass.
- Baseline screenshots were not captured before editing, and an authenticated Shopify Admin browser was unavailable. An isolated Polaris fixture preview with visibly fictional data is available at `docs/ui-preview/index.html`; it does not load React Router, Shopify data, or the database. Firefox headless snapshots are provided at 390/768/1280px for Overview, Products, Stores, New Import, Import History, and Receipt Detail, and at 1280px for the other fixture screens. These are **static fixture previews, not screenshots of the StockHub app**; they cannot establish route behavior, live data, App Bridge interactions, or before/after change. Some App Bridge/Polaris controls may render differently in this standalone context. Live routes, embedded auth, and before/after comparison remain **VISUAL_QA_PENDING**.
- Responsive fixture review caught and corrected a clipped History filter layout; New Import fixture markup was corrected to show the single file input used by source. Responsive fixtures are not equivalent to authenticated app rendering. Authenticated Admin interaction, browser keyboard/accessibility review, and cross-theme acceptance remain **not verified**.
- Final automated QA: `node --test tests/*.test.mjs` **PASS 145/145**; `npm run lint`, `npm run typecheck`, and `npm run build` **PASS**. Build emitted existing React Router future-flag warnings only.
- The Shopify Polaris App Home validator was **BLOCKED**: its installed script runtime could not resolve its required `typescript` package alongside the validator script; the bundled component type index is also absent. No validator dependency was installed. Project typecheck and build are separate checks, not a Polaris validator result.
- Independent source reviewer: **APPROVED** for route markup, token boundary, semantic status text/tone/icon mappings, docs, and the refreshed receipt fixture evidence. This does not approve the live visual gate.
- Authenticated Admin screenshots and before/after evidence remain a required follow-up.
