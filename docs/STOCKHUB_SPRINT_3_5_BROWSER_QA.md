# StockHub Sprint 3.5 — Authenticated Browser Acceptance

> **Follow-up (2026-10-23):** The user later asked to remove the Shipment section. The Shipment/Receipt UI routes have been removed from route discovery and navigation; the QA workflow checklist below is now historical and should not be used as a request to restore or accept that feature. Backend code, schema, migrations, database tables, and QA fixtures were retained without modification.

**Date:** 2026-10-23 (Asia/Ho_Chi_Minh)  
**Current result:** **PARTIAL** — QA database and Shopify preview runtime are ready; authenticated browser, end-to-end workflows, and live GraphQL authorization are **NOT VERIFIED** pending human browser interaction. Sprint 4 has not started.

## 1. Acceptance status

| Area | Status | Evidence |
|---|---|---|
| QA database isolation | **PASS** | Fresh empty SQLite DB created outside repo, all six migrations applied, zero Session/token records; startup app and React Router processes point to it. |
| Shopify CLI auth / target | **PASS** | `shopify app info --json` identified StockHub, client ID `30265d017d480d8c453704d17ae85870`, and development store `demo-app-d0c6tdk6.myshopify.com`. |
| Development runtime | **PASS** | `shopify app dev --store demo-app-d0c6tdk6.myshopify.com` reached “Ready”; tunnel returned HTTP 200. No process opened `dev.sqlite`. |
| Authenticated browser | **NOT VERIFIED** | No browser-control tool/session is available to this agent. Chrome/Firefox visual and console evidence is still needed. |
| Shipment / Receipt / CSV / inspection workflows | **NOT VERIFIED** | QA fixtures are ready, but no authenticated UI actions were performed. |
| Live read-only GraphQL scopes | **NOT VERIFIED** | CLI announced the configured scopes as auto-granted; no authenticated GraphQL response was captured. |
| Shopify Product/Variant/inventory writes | **PASS — none performed** | Only CLI preview, HTTP GET smoke check, and local QA DB seed writes occurred. |
| Legacy `ImportBatch` data | **PASS — untouched** | The app uses a separate QA DB; its `ImportBatch` and `ImportLine` counts are both 0. `dev.sqlite` hash is unchanged from before startup. |

## 2. Isolated QA database

- Path: `/tmp/stockhub-browser-qa-vWImhM/qa.sqlite` (parent directory mode `0700`; outside repository).
- Created from repository migrations, not copied from `dev.sqlite`; at creation `Session=0`, so no real session or token data was copied. A later read-only count observed `Session=1`; the source/actor was not established and no token fields were read. The QA DB file is mode `0600` and the parent directory is `0700`.
- Six migrations applied; Prisma reports schema up to date. SQLite `integrity_check=ok`; `foreign_key_check` has 0 violations; 15 tables exist.
- QA fixtures seeded for shop `demo-app-d0c6tdk6.myshopify.com`:
  - `shp_aa583e90-f02d-40b7-bfb2-122379212ebe`, reference `QA-20261023-BROWSER-01`, `OPEN`; expected `QA-SKU-001=10` and `QA-UNKNOWN-001=Unknown`.
  - `shp_5eafe025-9cb1-49b4-9682-4ca8b2175ace`, reference `QA-20261023-CLOSE-01`, `OPEN`; reserved for close/reopen lifecycle checks.
- No Receipt was seeded because it must select a real, active Shopify Location through the app. Both records are QA-labeled and belong only to the isolated database.
- Latest observed QA counts: `Session=1`, `Shipment=2`, `ReceivingReceipt=0`, `ReceivingImportAttempt=0`, `ReceiptInventoryOperation=0`, `ImportBatch=0`, `ImportLine=0`; integrity remains `ok`. The QA `Session` row must be treated as sensitive; it was not copied from `dev.sqlite` and its token was not inspected.
- The Prisma schema datasource was temporarily parameterized for startup, with `DATABASE_URL=file:/tmp/stockhub-browser-qa-vWImhM/qa.sqlite` inherited by Shopify CLI, Prisma hooks, and React Router. The original `prisma/schema.prisma` was restored byte-for-byte (SHA-256 `663569cf6193a7e096b9b49ea54957bbcf5bd5c8c33ce0ff636004e57ba4571f`).
- `prisma/dev.sqlite` remained at SHA-256 `b0ca93e521c13d04a0d5518dc1694c18f1712c23d2d9162b291e5933c95d6464` before and after app startup. No app process had it open.

## 3. Shopify preview and scope/config findings

- The CLI session is authenticated as the linked Shopify account; `app info` confirmed the exact app and target store.
- Preview process is still running for the manual QA window. Verified process environment for Shopify CLI, Prisma command, and React Router all contains `DATABASE_URL=file:/tmp/stockhub-browser-qa-vWImhM/qa.sqlite`.
- Shopify CLI startup hooks were `npx prisma generate` and `prisma migrate deploy && npm exec react-router dev`; both ran with the QA datasource. QA migration status is up to date. `dev.sqlite` was not opened.
- Shopify CLI reported: `Access scopes auto-granted: read_inventory, read_locations, read_products, write_inventory, write_products`. This matches the existing `shopify.app.toml` scope list; no scope was added or changed. `read_markets_home` was not added.
- The active dev tunnel is temporary: `https://category-memphis-opportunity-alleged.trycloudflare.com` (HTTP 200). React Router listens on `[::1]:43575` (HTTP 200); Shopify CLI proxy listens on `[::1]:42225`. Shopify Admin preview URL:
  **https://admin.shopify.com/store/demo-app-d0c6tdk6/apps/30265d017d480d8c453704d17ae85870?dev-console=show**
- The app’s remote configured `applicationUrl` still reports `https://example.com`; the dev session serves the generated tunnel preview. Local `shopify.app.toml` remains unchanged (`application_url=https://example.com`, auto-update enabled). The temporary preview is not a deployment.
- No live GraphQL request was made by the agent. Once authenticated, app screens exercise read-only Location, Product/SKU, and inventory snapshot queries; record visible results/errors, not just the configured scopes.

## 4. Browser acceptance checklist — owner action required

Use the Admin preview link above, sign in through Shopify’s own browser flow if needed, and verify the store shown is `demo-app-d0c6tdk6.myshopify.com`. Repeat in Chrome and Firefox. Do not provide passwords or tokens to the agent.

### B01–B09: embedded shell

1. Open the Admin preview URL in Chrome; confirm StockHub loads embedded in the specified development store (B01–B02).
2. Navigate between Home, Shipments, Imports, and other visible pages. Wait 2–3 seconds after first render, then reload (B03, B05, B06).
3. Check DevTools Console for `Hydration failed`, `Unexpected server HTML link element`, uncaught exceptions, or critical network errors (B04, B07). In particular, confirm CSS does not disappear after 1–2 seconds (Firefox regression).
4. Confirm there is no repeated/unexpected auth redirect (B08). Check layout around desktop 1440×900 and mobile 390×844 (B09).
5. Repeat steps 1–4 in Firefox. Capture screenshots plus console errors/network failures if any.

### S1–S6: Shipment / Receipt

1. In **Shipments**, open `QA-20261023-BROWSER-01`; verify shop ownership, `OPEN`, expected `QA-SKU-001: 10`, and `QA-UNKNOWN-001: Unknown` (not zero).
2. Create a Receipt Draft from this Shipment, choosing exactly one active Location in the UI. Create a second Receipt under the same Shipment and confirm independent IDs and Location assignment. Do not invent Location IDs.
3. Use `QA-20261023-CLOSE-01` for close/reopen: close it, verify it blocks a new Receipt, reopen with a reason, and ensure timeline/history remains.
4. Confirm no physical total is double-counted across separate Receipts.

### C01–C13: CSV and matching

1. Use **Import CSV** and test simple `SKU,Quantity`, Vietnamese headers, manual mapping, optional Product Group Code, existing SKU lookup, proposed new Variant/Product groups, multiple variants per proposal group, duplicate SKUs, invalid quantity, partial import (10 valid + 2 invalid rows), and Expected vs Received Goods.
2. For partial import, verify the 10 valid lines remain actionable and both invalid source rows remain visible with their original row numbers in the attempt/history. Do not click any action that would create a Shopify Product/Variant; proposal confirmations should remain local proposals only.
3. Use **Read-only Shopify SKU lookup** for an exact existing SKU. Verify existing match / no match / ambiguity outcomes and that no catalog mutation occurs.
4. Verify Import History retains each attempt and error row after navigation/reload. Avoid legacy ImportBatch Merge/Resume actions.

### Inspection / confirmation

1. Import 30 received units for a known existing Variant into a draft Receipt; prepare inspection and set Accepted=25, Damaged=3, On Hold=2. Confirm sum=30, proposed delta `+25`, and physical received remains 30. Try an invalid total and verify rejection.
2. Keep an unknown SKU as On Hold; verify it is not remapped and produces no executable operation.
3. Review final preview, then `Confirm Receipt` is safe for this S3 QA flow: the route freezes local business data and creates only `PENDING` operation records. Verify reload preserves it, a second confirm creates no duplicate, and operation status stays `PENDING`. **Do not run any Shopify inventory execution or Product/Variant creation action.**
4. Confirm Wrong Item is a separate exception and pending import errors remain visible.

### Live read authorization and side-effect guard

- Verify the app can read active Locations, Product/SKU matches, and inventory snapshot in the authenticated store context. Record which screen/query succeeds or its exact GraphQL error; do not infer live access from CLI’s auto-granted line.
- Do not install/change scopes, create Shopify Products/Variants, adjust inventory, deploy, or invoke legacy ImportBatch Merge/Resume.
- QA-only app writes (Shipment, Receipt, import, inspection, confirmation) should remain under QA references in the QA DB. Shopify inventory operations must remain `PENDING`.

## 5. Runtime handoff / cleanup note

The dev preview and temporary Cloudflare tunnel are intentionally left running so the owner can perform the authenticated browser checks. To stop after QA, interrupt the `shopify app dev` terminal session; do not kill unrelated processes. After stopping, regenerate Prisma Client from the restored repository schema (`./node_modules/.bin/prisma generate --schema prisma/schema.prisma`) before any normal local app run, so the generated client no longer expects the QA `DATABASE_URL` environment schema. Do not delete the QA DB or any untracked files as part of cleanup.

## 6. Repository and change report

- Updated only this report; it remains untracked, as does the existing repository content. No pre-existing untracked files were removed or cleaned.
- QA database is outside the repository. No code, migration, scope, local Shopify config, deployment, commit, or push changes were made.
- Automated browser/workflow tests and browser visual/console evidence are not available to the agent and remain **NOT VERIFIED**. Previously documented isolated migration regression tests (13/13) are not browser acceptance evidence.
