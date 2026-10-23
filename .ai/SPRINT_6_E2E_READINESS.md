# Sprint 6 — Shopify End-to-End Readiness

**Audit date:** 2026-10-23  
**Decision:** **NO-GO for mutation acceptance now.** Automated QA and source-level safety review pass, but the authenticated Development Store UI/session and fresh Shopify state for `nhap_hang_001` were not available to this run. Do not Merge, Resume, or alter test/merchant products until the approval gates below are satisfied.

## Executive result

- **Local automated QA:** PASS — 145/145 tests, lint, typecheck and build.
- **Runtime preview:** an already-running Shopify CLI dev process exposes a reachable Cloudflare preview URL; HTTP GET returned 200. The process was not started or stopped by this audit.
- **Runtime URL mapping:** the raw app-process environment does not contain `SHOPIFY_APP_URL`, but the existing `vite.config.ts` maps a trusted CLI-provided `HOST` into `SHOPIFY_APP_URL` before loading the app. A `loadConfigFromFile()` harness using the observed tunnel `HOST` reproduced this mapping and the expected Vite host/HMR configuration. This makes the observed development path internally consistent; it is **not** proof that an authenticated SDK request succeeds, nor does it prove the remote registered installation URL. No source fix was warranted.
- **Authentication:** API key/secret environment variables are present in the running child (values intentionally not read or printed); there is no connected browser profile available to inspect an authenticated Shopify Admin session. The runtime `SCOPES` value is an app/requested scope setting, **not evidence of the shop's currently granted scopes**.
- **Live UI and fresh Shopify read:** BLOCKED. No Overview/Stores/Products/Imports/History UI acceptance, screenshot, current SDK shop/session/grant check, or fresh Product/Variant/InventoryItem/InventoryLevel API reconciliation was possible.
- **Mutation plan:** prepared below; no mutation was attempted. No test SKU/product was designated, so testing must wait for owner input and explicit write approval.

## Phase 1 — Runtime & Auth

### Checkout and process state

- Repository: `/home/giahoang/dev/plugin_shopify/stockhub`.
- Before QA, repository content was already untracked and `git rev-parse HEAD` had no resolvable commit. These pre-existing files were preserved; no reset/clean/commit/push/deploy occurred.
- An existing `shopify app dev` process (PID 2547 at inspection) and its `cloudflared`/React Router children were active before this audit inspected them. They were left running and untouched.
- The child process (PID 3815) CWD is this checkout, and its open SQLite file descriptor points to `/home/giahoang/dev/plugin_shopify/stockhub/prisma/dev.sqlite`. It exposes runtime `HOST` and `APP_URL` as `https://archives-scenario-lined-cats.trycloudflare.com`, `PORT=39889`, and `SCOPES=read_inventory,read_locations,read_products,write_inventory,write_products`. The ephemeral preview URL answered HTTP 200 on a read-only request. Treat the tunnel URL as temporary and do not mistake it for the Shopify Admin installation URL.
- No project `.env*` file was found at the inspected depth. `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` exist in the running app child environment; secret values were neither read nor printed.
- `SHOPIFY_APP_URL` is absent from the raw React Router child environment, and `app/shopify.server.ts` initializes `appUrl` from `process.env.SHOPIFY_APP_URL || ""`. However, `vite.config.ts` already maps trusted `HOST` to `SHOPIFY_APP_URL` when loading Vite config. A config-loader harness with the observed `HOST` and absent `SHOPIFY_APP_URL` confirmed the resulting SDK-facing value, `allowedHosts`, and HMR host are the tunnel URL. The observed dev path is therefore **not a verified env mismatch**. `APP_URL` is not directly consumed by this mapping; if a future CLI runtime supplies only `APP_URL` and no `HOST`, that case is not covered by this workaround. The app's HTTP root response still does not verify SDK auth, callback URL, installation URL, or session-token handling.
- `shopify.app.toml` still has `application_url = "https://example.com"` and OAuth redirect URL `https://example.com/api/auth`, plus `embedded = true`, API version `2026-10`, and scopes `read_products,read_inventory,read_locations,write_inventory,write_products`. These are local TOML declarations, not proof of the connected Shopify app's remotely registered URL or the Development Store's effective grants.
- `shopify.web.toml` defines `predev = "npx prisma generate"` and `dev = "npx prisma migrate deploy && npm exec react-router dev"`. This is a real startup side effect. This audit did **not** invoke `shopify app dev`, `npm run dev`, `npm run setup`, `docker-start`, or a migration command. The existing process predated the audit. A read-only SQLite check found all three migrations already applied; the newest applied migration is `20261022100000_auto_generated_import_receipts`. No migration was run by this audit.
- No authenticated browser session was available to this run, so an authenticated Development Store session could not be opened here. Per instruction, no further browser-profile discovery was attempted. No Shopify session row/token was read, created, deleted, refreshed, or manually altered.

### Auth verification boundary

Source-level wiring uses Shopify SDK authentication (`app/shopify.server.ts`, `app/routes/app.tsx`, route loaders/actions) and Prisma session storage. This is not equivalent to proving a current store session. The following remain **NOT VERIFIED**:

1. Current shop domain returned by `authenticate.admin` in the active embedded session. **The configured development URL mapping was verified; live SDK authentication was not.**
2. Effective granted scopes returned by the SDK / Shopify, as distinct from runtime requested scopes.
3. App Bridge session-token exchange and authenticated loader/action behavior in a browser.
4. Shopify Admin's registered installation/application URL and callback configuration for this app.

No `shopify store auth` command was run; it would establish a CLI auth session, contrary to the instruction not to create a manual session to mask an app-auth problem. The read-only app verification should use the existing authenticated embedded SDK session once an owner browser is connected.

### Owner browser handoff (read-only)

1. In Shopify Admin for the intended Development Store, open **Apps → StockHub → Open app**. Do not use the tunnel URL directly as proof of embedded authentication.
2. Confirm the app loads in the Admin frame. In **Stores** (or the app's current-shop authorization view), note the shop domain and effective granted scopes shown from the authenticated SDK/API; the `SCOPES` environment variable is only the requested runtime scope list.
3. Open **Imports → History**, locate receipt `nhap_hang_001`, and open its detail page.
4. Click **Verify Shopify State** only. Do not click Merge or Resume. This should perform the app's explicit read-only verification path.
5. Use **Copy Result** and send the copied result with its timestamp. A screenshot of the embedded app and receipt detail is helpful but optional. If auth fails, send the exact safe error text and whether Shopify Admin redirected or displayed an app error; do not create/delete/refresh CLI sessions to hide the failure.

## Phase 2 — Read-only Verification

### Browser UI

| Surface | Source-level inspection | Authenticated live/UI result |
|---|---|---|
| Overview `/app` | Read-only Shopify product counts and shop-scoped recent import aggregates are present. | **BLOCKED / not verified** — no authenticated browser. |
| Stores `/app/stores`, `/app/store/:shop` | Shows the current authenticated shop, locations and scope-verification state; it is not a multi-store CRUD connector. | **BLOCKED / not verified**. |
| Products `/app/products` | Cursor-based product/SKU reads exist; shown inventory quantity is product-wide, not per location. | **BLOCKED / not verified**. |
| New Import `/app/imports` | CSV validation and receipt creation paths exist; requires read-only Shopify product/location lookups. | **BLOCKED / not verified**. |
| History `/app/imports/history` and receipt detail | Shop-scoped cursor history, line status/details, and explicit Verify action exist. | **BLOCKED / not verified**. |

No screenshot was captured. Automated tests exercise helpers/source contracts and do not count as GUI acceptance.

### `nhap_hang_001` local snapshot and live classification

The current `prisma/dev.sqlite` was queried through a read-only SQLite connection, without selecting the Session table. It contains one matching batch:

- Receipt: `nhap_hang_001`
- Persisted shop: `demo-app-d0c6tdk6.myshopify.com` (**historical receipt metadata; not confirmed as the currently authenticated shop**)
- Location: `HCM` / `gid://shopify/Location/116249067816`
- Persisted batch status: `FAILED`; no `completedAt`
- Lines: 10, all persisted `FAILED` at `INVENTORY_ACTIVATING`, error code `INVENTORY_ACTIVATE_USER_ERROR`; each has saved Product, Variant and InventoryItem IDs.

No fresh Shopify Admin query was performed. Therefore every row's **current audit classification is UNCERTAIN due to missing live evidence**; this is an audit conclusion, not a database status update. No row is certified `SAFE_CANDIDATE` or newly determined `BLOCKED` from current Shopify state.

| CSV row | SKU | Persisted status/stage | Audit classification now | Why |
|---:|---|---|---|---|
| 2 | `SP-AOSOMI-001` | FAILED / INVENTORY_ACTIVATING | **UNCERTAIN** | Saved Shopify IDs exist, but Product/Variant/SKU/InventoryItem/InventoryLevel were not freshly matched. |
| 3 | `SP-AOPOLO-002` | FAILED / INVENTORY_ACTIVATING | **UNCERTAIN** | Same missing fresh Shopify reconciliation. |
| 4 | `SP-JEANS-003` | FAILED / INVENTORY_ACTIVATING | **UNCERTAIN** | Same missing fresh Shopify reconciliation. |
| 5 | `SP-SNEAKER-004` | FAILED / INVENTORY_ACTIVATING | **UNCERTAIN** | Same missing fresh Shopify reconciliation. |
| 6 | `SP-TWSANC-005` | FAILED / INVENTORY_ACTIVATING | **UNCERTAIN** | Same missing fresh Shopify reconciliation. |
| 7 | `SP-PILLOW-006` | FAILED / INVENTORY_ACTIVATING | **UNCERTAIN** | Same missing fresh Shopify reconciliation. |
| 8 | `SP-KEYBRD-007` | FAILED / INVENTORY_ACTIVATING | **UNCERTAIN** | Same missing fresh Shopify reconciliation. |
| 9 | `SP-MOUSE-008` | FAILED / INVENTORY_ACTIVATING | **UNCERTAIN** | Same missing fresh Shopify reconciliation. |
| 10 | `SP-RACKET-009` | FAILED / INVENTORY_ACTIVATING | **UNCERTAIN** | Same missing fresh Shopify reconciliation. |
| 11 | `SP-BOTTLE-010` | FAILED / INVENTORY_ACTIVATING | **UNCERTAIN** | Same missing fresh Shopify reconciliation. |

The prior `RELEASE_READINESS.md` documents an earlier read-only check that found ten Draft products and no HCM InventoryLevel at that time. That is historical, not the new live verification requested here; it is insufficient to authorize Resume now. Database statuses remain `FAILED` and unchanged.

### Per-location inventory display

The Products page selects Shopify `inventoryQuantity`, which is product-wide across locations, and presents locations separately in the store/import context. It does not show stock quantity per selected location. Therefore **per-location stock visibility is not implemented/accepted** in this UI. A fresh InventoryLevel check at HCM remains not verified.

## Phase 3 — Write Acceptance Plan (prepared, not executed)

No SKU, product, or test location was designated for mutation. Use only owner-designated test products after approval; never use commercial products.

1. **Preflight and baseline:** confirm the authenticated Development Store domain and granted scopes through the app SDK; choose a designated test location; record existing product/variant/SKU/InventoryItem IDs and exact location-level inventory before any write. Confirm one reserved new SKU and one reserved existing SKU; ensure neither collides with merchant data.
2. **New SKU case:** submit a CSV containing only the designated new SKU through the existing UI; inspect receipt/validation; only after explicit approval, Merge once. Then read back Product status (expected Draft), Variant SKU, InventoryItem tracking and HCM InventoryLevel. Compare exact created quantity and one receipt/line outcome.
3. **Existing SKU case:** capture baseline quantity `N`; submit only the designated existing SKU with approved increment `D`; after explicit approval, Merge once; read back the same InventoryLevel and confirm `N + D`, with no other location changed.
4. **Duplicate submission/idempotency:** repeat the same submission identity and same payload; verify the same receipt is returned and no second quantity delta occurs. Reusing the identity with a changed payload must conflict. Test unknown-result recovery only with read-only reconciliation before any retry.
5. **Resume case:** do not use the historical `nhap_hang_001` batch as a test fixture. If the owner later approves one designated failed test line, first reconcile its Shopify state. Resume only when safe state is proven and separate explicit approval is given; compare pre/post location levels and receipt/line states.
6. **Recovery:** retain before/after snapshots and operation/receipt identifiers. For the new test product, remove it or leave it Draft only as the owner directs; for existing SKU, restore exactly the captured baseline quantity if the approved test protocol requires it. Cleanup/restoration is itself a Shopify mutation and requires explicit authorization. Never automatically delete a product or compensate an uncertain operation.

## Phase 4 — QA and independent review

### Automated checks run in this Sprint 6 audit

| Command | Result |
|---|---|
| `node --test tests/*.test.mjs` | **PASS — 145/145**, 0 fail/cancel/skip/todo |
| `./node_modules/.bin/eslint --ignore-path .gitignore .` | **PASS**, uncached |
| `npm run typecheck` | **PASS** (`react-router typegen && tsc --noEmit`) |
| `npm run build` | **PASS**; existing React Router future-flag warnings only |

Runtime observed by QA: Node `v26.9.0`, npm `12.0.2`, Vite `6.4.5`. Typecheck generated ignored `.react-router/`; build generated ignored `build/`. No source files changed. All tests are local automated checks; none performs authenticated Shopify E2E acceptance.

### Independent source review — auth, isolation, inventory safety

Reviewer found substantial source-level safeguards and no proven vulnerability in the reviewed paths:

- Shopify SDK auth precedes route data access; batch/history/detail lookups and line aggregates are scoped to the authenticated `session.shop`.
- Merge independently reloads/claims the batch by authenticated shop; server action requires explicit confirmation, checks current scope agreement, shop domain and active location.
- Existing-SKU adjustments recheck target IDs/SKU/quantity, require a positive delta and use persisted idempotency keys; new-product work creates Draft and reconciles markers/IDs before inventory activation.
- Verify is read-only in code; tests assert no Prisma writes in that path.

Reviewer caveat: stale `RUNNING` batch claim can be reclaimed after 15 minutes; line-level idempotency/reconciliation is intended to protect retries, but this needs a controlled mutation exercise before relying on it in production. Static review does not prove live token grants, cross-shop browser behavior, or Shopify mutation outcomes.

### Acceptance gaps

- Authenticated GUI review and screenshots: **BLOCKED / not verified**.
- Live SDK domain, effective grants, session-token exchange: **NOT VERIFIED**.
- Fresh read-only Shopify reconciliation of all ten receipt lines: **NOT VERIFIED**.
- Shopify CLI `app security check`: **not run in this sprint**; this was not a full Shopify security scan.
- Mutation tests, migration, commit, push and deploy: **not run**, as instructed.

## Final GO / NO-GO and approvals needed

### Decision

**NO-GO for running Merge/Resume or any Shopify mutation on the Development Store now.**

The code and automated QA are in good shape for a controlled next step, but the actual authenticated shop/session/grants and current state of the failed receipt have not been established. Additionally, no test SKU/product was designated. `nhap_hang_001` remains persisted `FAILED`; all ten rows remain UNCERTAIN for fresh live verification.

### Gates before any mutation test

1. Connect an already-authenticated browser session for the intended Development Store, or otherwise make the app's existing SDK-authenticated session available. Do not create/refresh a manual session to bypass an app-auth problem.
2. Confirm the target Development Store domain and effective granted scopes as returned by `authenticate.admin` / Shopify, plus the intended HCM location.
3. Name one reserved new SKU/product, one reserved existing SKU/product, their exact approved quantities, and whether test-created product cleanup is expected.
4. Approve the bounded write plan: exact Merge/Resume action(s), maximum inventory delta, selected location, duplicate/idempotency scenarios, and restoration/cleanup actions. Each restoration/deletion is a separate mutation authorization.
5. Open the app from the intended Shopify Admin and confirm authenticated SDK shop/session/grants. The observed development `HOST` mapping does not require a source fix; the remote registered installation/callback URL remains unknown until verified from the authenticated Admin/app configuration or a successful embedded flow.

Only after these gates should the outcome be reconsidered to **GO for the specifically approved Development Store test**. This report does not grant mutation authorization.

## Change report / Git

- **Goal:** establish Sprint 6 end-to-end readiness and a mutation test plan without running writes.
- **File added:** `SPRINT_6_E2E_READINESS.md` only.
- **Behavior/data changes:** none. Existing `shopify app dev` process was left running. Local receipt/migration state was read only; no session data was inspected or changed.
- **Checks:** tests 145/145, lint, typecheck and build passed; independent source review found no proven vulnerability. Live/UI checks remain blocked.
- **Risks/uncertainties:** live SDK authentication and remote installation/callback URL remain unverified; effective granted scopes unknown; preview tunnel ephemeral; receipt state needs fresh Shopify reads; no live GUI/screenshots.
- **Git:** pre-existing project files remain untracked; no commit exists/resolves. QA-generated `.react-router/` and `build/` are ignored. No commit, push, deploy, reset, clean or cleanup occurred.
