# StockHub — Sprint 2A Release Readiness

**Date:** 2026-10-22  
**Overall:** **BLOCKED for live acceptance/release.** The approved receipt migration is applied to Development `prisma/dev.sqlite` and verified. Local privacy-webhook checks pass. No Shopify Merge or inventory/product mutation was run. Shopify Admin UI acceptance remains for the owner to perform.

## Summary

| Area | Result | Evidence / remaining gate |
|---|---|---|
| Migration readiness | **PASS on Development DB** | Fresh online backup and restore proof passed; approved migration applied; data counts, history, integrity, indexes and receipt behavior verified. No test receipt was retained in the original DB. |
| Privacy webhooks | **PASS locally** | Three compliance topics and routes added; 3 regression tests pass; local SDK webhook requests with an invalid HMAC returned 401 and a correctly test-signed request returned 200. No Shopify-signed production request was used. |
| Production dependency advisories | **PASS after narrow override** | Four npm High entries collapsed to one `deepmerge-ts` advisory chain; override resolves patched 8.0.2; production audit now reports zero vulnerabilities. Prisma and Shopify adapter versions were not upgraded. |
| Shopify security check | **1 Low finding remains** | 30 agent checks passed, 5 were not applicable; deterministic check reports missing repository dependency-update automation. |
| Shopify Admin acceptance | **BLOCKED** | No authenticated embedded session or configured app URL/store is available. Merge/Resume and Shopify mutations were not run. |

## 1. Database Migration Readiness

### URL, migration state, and startup behavior

- `prisma/schema.prisma` uses the literal SQLite datasource `file:dev.sqlite`, resolved beside the schema as `prisma/dev.sqlite`; it does **not** read `DATABASE_URL`. No project `.env` file is present.
- Before this sprint, `prisma migrate status --schema prisma/schema.prisma` showed 3 migrations, with `20261022100000_auto_generated_import_receipts` pending on the original DB.
- `package.json` has no `predev` script. `dev` runs `shopify app dev`; `docker-start` calls `setup`, and `setup` runs `prisma generate && prisma migrate deploy`. Therefore `docker-start` can migrate this DB automatically; plain `dev` has no package-script migration hook.

### Backup, restore, and copy-only migration

- SQLite's backup API created a consistent backup and restored it into a second file. Backup and restored files both returned `integrity_check = ok`.
- Before migration: `Session=1`, `ImportBatch=1`, `ImportLine=10`; foreign-key check was empty.
- Prisma `migrate deploy` ran against an isolated copy, and `migrate status` then reported the copy up to date. Post-migration integrity and foreign-key checks passed; row counts remained `1 / 1 / 10`.
- The existing history entry retained receipt code `nhap_hang_001`, status `FAILED`, and all 10 lines. Its new `submissionId` is `NULL`. `ImportReceiptCounter` is empty because the old receipt code does not match the generated `IMP-YYYYMMDD-NNNNNN` format. The schema has no standalone `Receipt` table/model; receipt identity is `ImportBatch.receiptCode`.
- Duplicate insertion attempts were rejected for `(shop, receiptCode)`, `(shop, submissionId)`, `ImportLine.operationId`, and `ImportLine.idempotencyKey`; all attempts were rolled back and original copy counts remained unchanged.
- SQLite concurrency check used 8 independent processes × 25 transactional upserts on a temporary migrated database: expected and observed counter were both 200; integrity and FK checks passed.
- Local evidence files are under `/tmp/stockhub-migration-readiness.uQbIjr/` (backup, restored DB and migrated copy). They are test artifacts, not a new backup policy.

### Development migration result

**Approved Development migration completed on 2026-10-22.** The applied migration was only `20261022100000_auto_generated_import_receipts`. Preflight stopped the Shopify CLI and React Router development server that held open handles to this DB; no other project process remained using it. The datasource resolved to `/home/giahoang/dev/plugin_shopify/stockhub/prisma/dev.sqlite`.

Fresh pre-migration backup and restore proof:

- Backup: `/home/giahoang/dev/plugin_shopify/stockhub-safety-backups/dev.sqlite.pre-migration-20261022T082516Z.sqlite`
- Restored verification copy: `/tmp/dev.sqlite.restore-check-20261022T082516Z.sqlite`
- Both returned `integrity_check=ok`, empty foreign-key checks, counts `Session=1`, `ImportBatch=1`, `ImportLine=10`, and retained `nhap_hang_001`.

`npx prisma migrate deploy --schema prisma/schema.prisma` applied the single pending migration successfully. `npx prisma generate --schema prisma/schema.prisma` succeeded and `npx prisma migrate status --schema prisma/schema.prisma` reports the schema up to date.

Post-migration Development DB verification: `integrity_check=ok`, foreign-key check empty, counts remain `1/1/10`; history is now `receiptCode=nhap_hang_001`, `submissionId=NULL`, status `FAILED`, unchanged by the migration. `ImportReceiptCounter` exists and has no row for the legacy non-generated receipt. Expected unique indexes exist for `(shop,receiptCode)` and `(shop,submissionId)`.

Receipt behavior was tested on a post-migration copy, not the Development DB: `/home/giahoang/dev/plugin_shopify/stockhub-safety-backups/dev.sqlite.post-migration-test-20261022T082548Z.sqlite`. In a rolled-back transaction, duplicate receipt code and duplicate shop-scoped submission ID were each rejected; a counter insert/upsert advanced to 2; rollback restored the copy to one historical batch and zero counters. Copy integrity and FK checks passed. No test receipt was created or retained in the Development DB.

### Recovery plan retained for reference

If a future migration or post-check fails, stop all DB access; preserve the failed DB and sidecars for diagnosis; restore the verified backup through SQLite's backup API to a temporary file; verify it before replacing the target with all clients stopped. Keep the failed copy and do not retry blindly.

## 2. Shopify Privacy Webhooks

Added subscriptions for `customers/data_request`, `customers/redact`, and `shop/redact` using `compliance_topics` in `shopify.app.toml`. Each route awaits Shopify React Router SDK `authenticate.webhook(request)` before reading its payload. The SDK validates the raw-body HMAC and rejects invalid signatures; this was checked against the installed SDK and exercised locally: an invalid test signature returned **401**, and a correctly test-signed `customers/data_request` returned **200**.

- Customer data request/redaction validates positive Shopify shop/customer IDs. The current schema has no customer model or customer ID linked to ImportBatch/ImportLine. Session email/ID fields are merchant-admin authentication data, not customer records; these handlers therefore do not erase unrelated Import History or Sessions.
- Shop redaction validates `shop_id` and the SDK-derived shop, then transactionally deletes that shop's ImportBatch rows (ImportLine cascades), receipt counters, and Sessions. Repeated `deleteMany` delivery is idempotent.
- Regression coverage validates SDK-authenticator routing, payload validation, preservation of merchant data for customer-only requests, and transaction scope for shop deletion.
- **Not verified:** Shopify-originated signed delivery, production subscription registration, or successful `shop/redact` against the original database. The latter awaits migration approval; no valid shop-redaction request was sent to the local app.
- No remote configuration or production deployment was changed.

Shopify documents automatic verification in the [React Router webhook guide](https://shopify.dev/docs/api/shopify-app-react-router/latest) and the required [privacy compliance topics](https://shopify.dev/docs/apps/build/security/app-security-checks/missing-compliance-webhooks).

## 3. Production Dependency Risk

Before the change, `npm audit --omit=dev` reported **4 High package entries** from one advisory chain:

```text
@shopify/shopify-app-session-storage-prisma@11.0.1
  -> prisma@6.19.3
     -> @prisma/config@6.19.3
        -> deepmerge-ts@7.1.5
```

The common advisory is [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), fixed in `deepmerge-ts >= 8.0.0`. The vulnerable operation is recursive merging of attacker-supplied cyclic JavaScript objects. In this app it is only reached by Prisma's config loader; the project has no `prisma.config.*`, and no request/customer-controlled object reaches it. This indicates low practical remote exploitability for StockHub, but the dependency was still included in the production tree and deserved a fix.

The safe, scoped fix adds the npm override `deepmerge-ts: ^8.0.1`; lockfile resolution is **8.0.2**. Prisma remains 6.19.3 and the Shopify session-storage adapter remains 11.0.1. Validation performed in an isolated install: Prisma schema validation passed, the `deepmerge` API merge check passed, and production audit reported zero vulnerabilities. The full app was then tested and built with the override active. No `npm audit fix --force` or Prisma major upgrade was used.

**Remaining security item:** Shopify CLI reports one deterministic Low finding, `MISSING_DEPENDENCY_SECURITY_AUTOMATION`: no Dependabot or Renovate config exists in the repository. No automation config was added in this sprint.

## 4. Live Shopify Admin Acceptance Checklist

All items below are **PREPARED — NOT RUN** until the owner opens the app in the intended embedded Admin session. The Shopify CLI/React Router dev server are stopped after migration preflight and were not restarted because this approval excluded Shopify remote activity. The production build is ready; the owner can start the authorized dev preview before checking the UI. Do not submit Merge or Resume; this migration approval did not authorize Shopify mutations.

- [ ] **Authentication and scopes:** open StockHub from the intended store; verify installed grants match `read_products`, `read_inventory`, `read_locations`, `write_inventory`, and conditional `write_products`; confirm missing grants fail closed.
- [ ] **Overview, Stores, Products:** confirm the displayed shop identity matches the Admin store and the read-only product/store views load without leaking another shop's data.
- [ ] **Location HCM:** confirm the actual active HCM location and currency are returned from Shopify, including when beyond the first page; confirm inactive/unauthorized locations cannot be selected.
- [ ] **CSV upload and Validate:** use a non-production test CSV; verify file limits, required values, duplicate/ambiguous SKUs and quantities. Confirm validation/Preview does not write Shopify inventory or products.
- [ ] **Auto-generated Receipt:** confirm the receipt code format, stable receipt on same submission retry, conflict on token reuse with changed data, and a new receipt for a new submission.
- [ ] **Preview and Import History:** confirm preview details, reload behavior, historical receipt links and per-shop scoping.
- [ ] **Merge and Resume:** **DO NOT EXECUTE** until a separate explicit approval defines a disposable test product/location and accepted inventory delta. Before then, verify only that UI requires confirmation and server checks current scopes/location/batch state.

## Latest Verification

- `node --test tests/*.test.mjs`: **80/80 passed** after the Import History stage-label update.
- `npm run typecheck`: **passed**.
- `npm run lint`: **passed**.
- `npm run build`: **passed**, with existing React Router future-flag notices and empty client chunks for server-only routes.
- `shopify app config validate --json --no-input`: **valid; 0 issues**.
- `shopify app security check --yes`: engine/ruleset **4.9.4**; 30 agent checks passed, 5 not applicable; 1 deterministic Low finding (`MISSING_DEPENDENCY_SECURITY_AUTOMATION`). Results recorded and `shopify app security review` completed. The CLI warns `--yes` is deprecated; it still completed successfully.
- `npm audit --omit=dev` after override: **0 vulnerabilities**.
- Local runtime HMAC smoke: invalid signature **401**, valid test signature **200** for `customers/data_request`.
- Prisma schema validation: **passed** after the Import History incident fix.
- Development DB post-migration: `integrity_check=ok`, foreign-key check empty; counts `Session=1`, `ImportBatch=1`, `ImportLine=10`; all three migrations applied and `migrate status` reports up to date. Receipt compatibility and copy-only unique/counter operations are documented above.
- **Not verified:** live embedded Admin UI, fresh authenticated read of the 10 incident products (the saved token returned 401), actual Shopify webhook delivery, production webhook registration, or a real inventory mutation. The dev server was not restarted because the valid app URL/credentials are unavailable. No Shopify mutation, remote config change, app deploy, commit, or push was performed. The explicitly approved Development DB migration was applied as documented above.

## Import History Incident — 2026-10-22

- Matched the HCM batch by its exact creation timestamp: `00d660d3-3405-4f72-8ac0-f8f65a6a3e53` (`2026-10-22T07:02:01.115Z`). It has 10 lines, all `FAILED` at `INVENTORY_ACTIVATING`, with 0 succeeded and 0 uncertain. Each saved line contains distinct operation/idempotency identifiers and Shopify Product/Variant/Inventory Item IDs.
- A read-only Admin API check found all 10 products by their StockHub operation marker (evidence they were created by this batch), each SKU/variant/item matched its line, all products remain `DRAFT`, and no InventoryLevel exists at HCM. The stored Shopify error explains the failure: the old `inventoryActivate` request supplied both `available` and `onHand`, which Shopify rejects. No inventory was activated by this batch. Application request logs were not durably available; the conclusion is supported by persisted stages/errors plus read-only Shopify state.
- The receipt was stored under legacy `receiptKey=nhap_hang_001`; the approved migration preserved it as `receiptCode=nhap_hang_001`. The UI now displays a truthful fallback for records without a code rather than fabricating one.
- Fixes: activate inventory with `available` only; reconcile legacy failed activations against the operation marker, saved identifiers/SKU, tracking state, and selected-location level before Resume; mark unsafe/unverifiable outcomes `UNCERTAIN`, and persist a fresh idempotency key only after confirming no level exists. Batch aggregation now prioritizes unresolved outcomes, reports `COMPLETED` only when all rows succeeded, `PARTIAL` for mixed known outcomes, and `FAILED` for zero successes with no unresolved outcomes. History separates failed and blocked counts and shows per-line stage, IDs, and error details.
- Regression coverage includes 10/10, 0/10, 7/10, Shopify success followed by Prisma write failure, safe Resume/idempotency behavior, distinct failed/blocked counts, and legacy receipt fallback. **Historical batch status was not edited.** No Shopify API mutation, Resume, deployment, commit, or push was performed during this incident work.
- Per-line UI milestones distinguish `PRODUCT_CREATED` as “Draft Product Created”, failed `INVENTORY_ACTIVATING` as “Inventory Activation Failed”, and succeeded/completed rows as “Import Line Completed”; raw stage/status and saved errors remain visible.

## Historical Batch Acceptance Preparation — 2026-10-22

- The Development server was **not restarted**: no StockHub dev process was active or holding `prisma/dev.sqlite`; `shopify.app.toml` still points at `https://example.com`; runtime `SHOPIFY_APP_URL`, `SHOPIFY_API_KEY`, and `SHOPIFY_API_SECRET` are absent; and no project `.env` file is present. Starting `shopify app dev` would not produce an authenticated embedded session under this configuration, so no CLI setup/link/tunnel operation was started.
- A fresh read-only Admin API check for the 10 saved Product IDs was attempted against `2026-10`; the locally stored offline session expired at `2026-10-22T08:44:07.639Z` and Shopify returned HTTP 401. The token was not refreshed. Earlier successful read-only reconciliation (above) found all 10 matching Drafts, operation markers, variants, tracked inventory items, and no HCM InventoryLevels, but that is not a fresh recheck.
- Static local classification finds 10 failed rows at `INVENTORY_ACTIVATING` with saved IDs and activation-user-error codes. Until a fresh authenticated read confirms marker/SKU/resource identity and no HCM InventoryLevel, **0 rows are currently certified safe to Resume; all 10 are held from retry pending reconciliation**. Their persisted DB status remains `FAILED`, not changed to `UNCERTAIN`; the Resume path will stop without mutation and mark/keep an outcome `UNCERTAIN` when reconciliation is missing or mismatched. No Resume or Shopify mutation was invoked.
- The Shopify Admin GraphQL `2026-10` schema bundled with the developer tooling defines `inventoryActivate.available` as optional `Int`, `onHand` as a separate optional `Int`, and `@idempotent(key: String!)`. Current application code supplies `available` only and retains `@idempotent(key: $key)`. For an unknown result, retry reuses the same key; for a prior explicit userError, Resume rotates the key only after confirming no level exists. No second inventory addition was made in this check.

## Git / Change Scope

The checkout had no commit and its project files were untracked before these edits, so Git cannot distinguish pre-existing project content from newly added files. No existing files were deleted. No commit or push was made. Review the working tree in place before integrating or deploying.
