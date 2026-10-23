# StockHub UI Rescue report

## Scope and evidence

The supplied screenshots were treated as the visual baseline. The local evidence below is an actual React-component harness: it mounts the production Overview, Products, and New Import route components, imports the production stylesheet, and uses the Polaris web-component bundle. It is **not** an authenticated Shopify Admin E2E session.

After-capture evidence:

- `tests/visual-harness/screenshots/overview-1280.png`
- `tests/visual-harness/screenshots/overview-390.png`
- `tests/visual-harness/screenshots/products-1280.png`
- `tests/visual-harness/screenshots/products-390.png`
- `tests/visual-harness/screenshots/products-sku-1280.png`
- `tests/visual-harness/screenshots/products-sku-390.png`
- `tests/visual-harness/screenshots/new-import-1280.png`
- `tests/visual-harness/screenshots/new-import-390.png`

## Audit and root causes

| Baseline issue | Root cause found | Resolution |
| --- | --- | --- |
| New Import did not present a clear merchant workflow | The page opened with a generic Imports context and its two-column area was delegated to implicit component spacing. The form began lower than its guidance panel. | Added a New import page header and app-owned desktop/mobile layout columns. The upload form and guidance panel now share a desktop baseline and stack at 390px. |
| Import navigation could render as a blank area in the component harness | `s-button-group` delegated the layout to an element that produced no visible child controls in the local Polaris harness. | Removed only the grouping wrapper; the actual Polaris buttons remain and now sit in an app-owned flex tab row. |
| Stores gave a merchant a small session card with no at-a-glance operational data | The route loaded only shop identity. Location and receipt context existed only on the detail screen. | Added safe, read-only location count, import receipt count, and an explicit verified/unverified permission state. The only action remains the real Store Details route. |
| Import History did not have a clear page-level hierarchy | The list began directly in a generic section under the Imports shell. | Added a contextual History header and a bounded surface around the existing compact filter/table/pagination flow. |
| Overview and Products were visually dense/empty in the supplied baseline | The current route components already contain the corresponding grid, compact table, responsive row, and toolbar work. | Re-captured the actual components at desktop and mobile, including SKU-search and expand/collapse interactions. |

## Files changed in this pass

- `app/routes/app.imports._index.tsx` — New Import header and explicit form/guidance layout.
- `app/routes/app.imports.tsx` — visible, responsive import tabs without the blank grouping wrapper.
- `app/routes/app.stores.tsx` — useful single-store summary and honest connection information.
- `app/routes/app.imports.history._index.tsx` — page hierarchy for compact history browsing.
- `app/styles/stockhub.css` — responsive layout, Store summary, headers, tab row, and History surface.
- `tests/visual-harness/main.tsx` — harness mirrors the route’s visible import-tab composition.

## Validation results

- React visual harness captured at 1280×900 and 390×900 for Overview, Products, Products SKU search, and New Import.
- New Import geometry: desktop form and guidance share a top edge; at mobile the guidance follows the form; neither capture overflows horizontally.
- Overview: KPI cards share a desktop row, are within the 110–140px height contract, and Recent Imports starts in the first desktop viewport.
- Products: desktop toolbar remains compact; collapsed desktop rows are 61px; variant details expand and collapse; mobile actions meet the harness touch-size contract.
- `node --test tests/*.test.mjs` — 17 passing, 0 failing.
- `npm run lint` — passing.
- `npm run build` — passing.
- `npm run typecheck` — passing.

The Shopify AI Toolkit Polaris validator could not be run because the installed toolkit bundle cannot resolve its own `typescript` dependency. No Shopify mutation, scope/config/webhook change, database migration, reset, deployment, or commit was made.

## Reviewer verdict

| Page | Evidence | Verdict |
| --- | --- | --- |
| Overview | Actual-component captures at 1280px and 390px | Approved for component-level visual review. |
| Products | Actual-component captures at 1280px and 390px, including SKU search and expand/collapse | Approved for component-level visual review. |
| New Import | Actual-component captures at 1280px and 390px | Approved for component-level visual review. |
| Stores | Build, lint, typecheck, and read-only UI regression test | Code-reviewed; a component screenshot is still required before a visual verdict. |
| Import History / Receipt Detail | Build, lint, typecheck, and import UX regression tests | Code-reviewed; a component screenshot is still required before a visual verdict. |

The captured pages no longer show the reported vertical KPI stack, blank Quick Actions, oversized Products filter stack, or unstructured New Import form. Stores and History retain honest data boundaries: no invented multi-store registry, no fake connection action, and no fabricated activity timeline.

## Remaining limits and merchant acceptance

- No live authenticated Shopify Admin session was available, so a live iframe capture and merchant acceptance are still pending.
- The visual harness is explicitly not a claim of Shopify E2E or live-session visual QA.
- Activity History remains honestly unavailable until an approved audit-event model exists; no fake rows or buttons were added.
