# StockHub P0 document hydration report

## Result

**Document-shell fix: PASS in the actual production React Router application.**

The production route was server-rendered, then hydrated in Chrome from the production client bundle at 1280px and 390px. At initial load, 3 seconds, and 10 seconds, there were no console errors, the document was not replaced, and the StockHub stylesheet persisted.

Embedded `/app/*` pages require a real Shopify Admin session and could not be loaded with local test credentials. Their document shell is the same root route; their App Bridge-specific verification remains a separate live-session follow-up.

## Root cause

`app/root.tsx` rendered the whole document (`html`, `head`, `body`) from the root route's default component. React Router Framework mode hydrates `document` via `HydratedRouter`; its documented document-shell contract is an exported root `Layout({ children })`, while the default root component renders only `<Outlet />`.

The old shape was unsafe when React Router selected a boundary/error route: the initial server route tree and the first client route tree could disagree over whether the default root component itself supplied the document shell. That directly explains Firefox's document-level diagnostics:

- missing matching `<head>` under `<html>`;
- an unexpected `<link>` at the document level;
- React replacing `#document` after failed hydration.

The App Bridge bundle appearing in the stack is not treated as the cause. It is a caller present when React reports the failure; the mismatch is in StockHub's root document ownership.

## Exact code change

`app/root.tsx` now has one stable document owner:

- `export function Layout({ children })` renders `html`, `head`, `Meta`, `Links`, `body`, `ScrollRestoration`, and `Scripts`.
- The default `App` returns only `<Outlet />`.
- The existing direct Inter links remain inside `head`.
- CSP/document headers, Shopify App Bridge setup, routes, and all business workflows are unchanged.

This is a structural React Router fix. It does not suppress warnings, defer stylesheet loading, reload the page, or disable SSR.

## Server/client evidence

The raw SSR response from the new production build contains exactly one shell:

```html
<html lang="en">
  <head>
    <meta ...>
    <link rel="preconnect" ...>
    <link rel="stylesheet" href="...inter...">
    <link rel="stylesheet" href="/assets/root-....css">
  </head>
  <body class="stockhub-app-frame">...</body>
</html>
```

Production browser capture recorded the same document shape after hydration:

- `document.documentElement.children`: `["HEAD", "BODY"]`
- `headChildren`: the same two metas plus preconnect, Inter stylesheet, StockHub root stylesheet, and route stylesheet
- `stockhubStylesheet`: `true`
- `consoleErrors`: `[]`

Evidence files:

- `tests/hydration-harness/screenshots/production-login-hydration.json`
- `tests/hydration-harness/screenshots/production-login-1280-initial.png`
- `tests/hydration-harness/screenshots/production-login-1280-3s.png`
- `tests/hydration-harness/screenshots/production-login-1280-10s.png`
- `tests/hydration-harness/screenshots/production-login-390-initial.png`
- `tests/hydration-harness/screenshots/production-login-390-3s.png`
- `tests/hydration-harness/screenshots/production-login-390-10s.png`

## Files changed

- `app/root.tsx`
- `tests/document-shell-hydration.test.mjs`
- `tests/hydration-harness/capture-production.mjs`

The earlier P0 formatter work remains relevant and unchanged: it prevents timezone/locale text mismatches in Overview, Products, Stores, Import History, and Receipt Detail.

## QA

| Check | Result |
| --- | --- |
| Raw production SSR document | PASS |
| First production client hydration | PASS |
| `<head>` / `<link>` console warnings | PASS — none recorded |
| Full-document replacement | PASS — body persisted |
| CSS persistence at 3s and 10s | PASS |
| 1280px capture | PASS |
| 390px capture | PASS |
| Automated tests | PASS — 19 tests, 0 failures |
| Typecheck | PASS |
| Lint | PASS |
| Production build | PASS |
| Authenticated App Bridge routes | BLOCKED — no Shopify Admin session in this workspace |

## Remaining live verification

With an authenticated Admin session, reload Overview, Products, Stores, Imports, History, and Receipt Detail once in Firefox. Expected result: no document hydration errors, no full-document replacement, and unchanged root stylesheet link after 10 seconds. If a new error appears, record the exact route, full React component stack, browser extensions, and a pre/post-hydration `document.head` snapshot; do not attribute it to App Bridge without a matching DOM mutation.

## Toolkit note

Shopify App Home documentation search was unavailable in this environment. The Polaris component validator passed; local React Router production hydration capture, tests, typecheck, lint, and build validate the document-shell behavior itself.
