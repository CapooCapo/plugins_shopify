# StockHub Sprint 3.5 — Migration Readiness Audit

**Audit date:** 2026-10-23  
**Scope:** Read-only preflight for Sprints 1–3 migrations and browser acceptance.  
**Recommendation:** **NO-GO for applying S1–S3 migrations to the current `dev.sqlite` at this time.** The three migrations are pending and structurally additive, but the only verified on-disk backup is stale relative to current legacy data. Create and verify a fresh backup/restore point, then obtain owner approval before applying migrations.  
**Actions not performed:** No migration, reset, database write, Shopify mutation, scope change, Shopify CLI restart, commit, push, or deploy.

## 1. Database hiện tại

Database inspected read-only: `prisma/dev.sqlite` (118,784 bytes at audit time), SQLite `journal_mode=delete`.

### Current tables and data

| Table | Rows | Notes |
|---|---:|---|
| `Session` | 1 | Session scope read below; access token was not selected or printed. |
| `ImportBatch` | 3 | 1 `FAILED`, 2 `PREVIEWED`. |
| `ImportLine` | 30 | 10 `FAILED` at `INVENTORY_ACTIVATING`; 20 `BLOCKED` at `PREPARED`. |
| `ImportReceiptCounter` | 2 | Existing legacy counter data retained. |
| `_prisma_migrations` | 3 | All recorded as finished, none rolled back. |

The three applied migrations are `20240530213853_create_session_table`, `20261022050000_create_import_batches`, and `20261022100000_auto_generated_import_receipts`. `nhap_hang_001` remains part of the historical failed ImportBatch and must not be resumed, reclassified, or rewritten as a new Receipt.

Read-only checks:

- `PRAGMA integrity_check` → `ok`.
- `PRAGMA foreign_key_check` → no rows.
- `PRAGMA user_version` → `0` (Prisma uses `_prisma_migrations`; this value is not its migration ledger).
- The audit connection reported `PRAGMA foreign_keys=0`. SQLite foreign-key enforcement is connection-specific; this observation is **not** evidence about Prisma's application connections. The database's foreign-key check returned no violations.
- `./node_modules/.bin/prisma migrate status --schema prisma/schema.prisma` → 6 migrations found; the following three are pending: `20261023090000_add_shipments_receipts`, `20261023130000_receiving_csv_imports`, `20261023180000_receipt_inspection_foundation`.
- `prisma migrate diff --from-url 'file:./prisma/dev.sqlite' --to-schema-datamodel prisma/schema.prisma --script` produced only creation of the new domain tables/indexes; it showed no alteration/drop of legacy `Session`, `ImportBatch`, `ImportLine`, or `ImportReceiptCounter`.

Current local `Session.scope` is `read_locations,write_inventory,write_products`; its stored `expires` value is `2026-10-23T08:22:55.963Z` at this audit snapshot. This is local session metadata, not a fresh successful API authentication check. Current configured scopes are described in §6.

## 2. Migration diff (Sprints 1–3)

The three pending migrations are additive. No new columns are added to the existing legacy tables. S3 adds nullable confirmation columns to the `ReceivingReceipt` table created by S1 and adds a nullable field to the S3 exception table; these are new StockHub tables, not legacy schema alterations.

### Tables and columns to be created

- **`Shipment`** — `id`, `shop`, `referenceType`, `reference`, `referenceNormalized`, `issuer`, `issuerNormalized`, `notes`, `status`, `createdAt`, `updatedAt`, `closedAt`.
- **`ShipmentExpectation`** — `id`, `shipmentId`, `sku`, `expectedQty`, `createdAt`.
- **`ReceivingReceipt`** — `id`, `shop`, `shipmentId`, `requestId`, `locationId`, `locationName`, `status`, `confirmedAt`, `confirmationId`, `createdAt`, `updatedAt`.
- **`ShipmentEvent`** — `id`, `shop`, `shipmentId`, `type`, `reason`, `metadata`, `createdAt`.
- **`ReceivingImportAttempt`** — `id`, `shop`, `shipmentId`, `receiptId`, `mode`, `fileName`, `fileChecksum`, `dedupeKey`, `mappingJson`, `status`, `createdAt`.
- **`ReceivingImportRow`** — `id`, `attemptId`, `rowNumber`, `rawValuesJson`, `sku`, `quantity`, `productGroup`, `validationJson`, `outcome`, `decision`, `decisionReason`, `proposalJson`, `proposalGroupId`, `matchedProductId`, `matchedVariantId`, `createdAt`.
- **`ReceivingImportProposalGroup`** — `id`, `attemptId`, `groupKey`, `productName`, `status`, `decision`, `createdAt`.
- **`ReceiptInspectionLine`** — `id`, `shop`, `receiptId`, `sourceRowId`, `sku`, `productName`, `receivedQty`, `acceptedQty`, `damagedQty`, `onHoldQty`, `matchOutcome`, `matchedProductId`, `matchedVariantId`, `createdAt`, `updatedAt`.
- **`ReceiptInspectionException`** — `id`, `shop`, `receiptId`, `lineId`, `sourceRowId`, `requestId`, `type`, `quantity`, `suspectedSku`, `reason`, `disposition`, `status`, `createdAt`.
- **`ReceiptInventoryOperation`** — `id`, `shop`, `receiptId`, `lineId`, `operationKey`, `locationId`, `targetVariantId`, `inventoryItemId`, `acceptedDelta`, `snapshotAvailable`, `snapshotTakenAt`, `status`, `createdAt`.

All ten tables have a primary key on `id`, except `ImportReceiptCounter` which is an existing composite-key table and is unchanged.

### Indexes and uniqueness constraints to be added

`Shipment`

- Unique: `(shop, referenceType, issuerNormalized, referenceNormalized)`; `(shop, id)`.
- Non-unique: `(shop, status, createdAt)`; `(shop, referenceNormalized)`.

`ShipmentExpectation`

- Unique: `(shipmentId, sku)`.
- Non-unique: `(shipmentId)`.

`ReceivingReceipt`

- Unique: `(shop, requestId)`; `(shop, id)`.
- Non-unique: `(shop, shipmentId, createdAt)`; `(shop, locationId)`.

`ShipmentEvent`

- Non-unique: `(shop, shipmentId, createdAt)`.

`ReceivingImportAttempt`

- Unique: `(shop, dedupeKey)`.
- Non-unique: `(shop, shipmentId, createdAt)`; `(shop, fileChecksum, mode)`.

`ReceivingImportRow`

- Unique: `(attemptId, rowNumber)`.
- Non-unique: `(attemptId, outcome)`; `(sku)`.

`ReceivingImportProposalGroup`

- Unique: `(attemptId, groupKey)`.
- Non-unique: `(attemptId, status)`.

`ReceiptInspectionLine`

- Unique: `(sourceRowId)`; `(shop, id)`.
- Non-unique: `(shop, receiptId, createdAt)`; `(receiptId, sku)`.

`ReceiptInspectionException`

- Unique: `(shop, requestId)`; `(receiptId, lineId, type)`; `(receiptId, sourceRowId, type)`.
- Non-unique: `(shop, receiptId, status)`; `(sourceRowId)`.

`ReceiptInventoryOperation`

- Unique: `(shop, operationKey)`; `(shop, lineId)`.
- Non-unique: `(shop, receiptId, status)`.

These are 31 explicitly created indexes, in addition to table primary-key indexes. SQLite treats `NULL` values as distinct for unique indexes; unique indexes involving nullable exception keys do not by themselves prevent duplicates where one of the indexed values is `NULL`. The application also relies on request identity and service-level checks for those cases.

### Foreign keys and referential actions

The migration adds these relationships:

- `ShipmentExpectation.shipmentId → Shipment.id` — cascade delete/update.
- `ReceivingReceipt(shop, shipmentId) → Shipment(shop, id)` — restrict delete, cascade update.
- `ShipmentEvent(shop, shipmentId) → Shipment(shop, id)` — restrict delete, cascade update.
- `ReceivingImportAttempt(shop, shipmentId) → Shipment(shop, id)` — restrict delete/update cascade.
- `ReceivingImportAttempt(shop, receiptId) → ReceivingReceipt(shop, id)` — restrict delete/update cascade; nullable `receiptId` supports Expected Goods mode.
- `ReceivingImportRow.attemptId → ReceivingImportAttempt.id` — cascade delete/update.
- `ReceivingImportRow.proposalGroupId → ReceivingImportProposalGroup.id` — set null on delete, cascade update.
- `ReceivingImportProposalGroup.attemptId → ReceivingImportAttempt.id` — cascade delete/update.
- `ReceiptInspectionLine(shop, receiptId) → ReceivingReceipt(shop, id)` — restrict delete/update cascade.
- `ReceiptInspectionLine.sourceRowId → ReceivingImportRow.id` — restrict delete/update cascade.
- `ReceiptInspectionException(shop, receiptId) → ReceivingReceipt(shop, id)` — restrict delete/update cascade.
- `ReceiptInspectionException(shop, lineId) → ReceiptInspectionLine(shop, id)` — restrict delete/update cascade.
- `ReceiptInspectionException.sourceRowId → ReceivingImportRow.id` — restrict delete/update cascade.
- `ReceiptInventoryOperation(shop, receiptId) → ReceivingReceipt(shop, id)` — restrict delete/update cascade.
- `ReceiptInventoryOperation(shop, lineId) → ReceiptInspectionLine(shop, id)` — restrict delete/update cascade.

### Migration-related risks

- **Data loss / legacy compatibility:** no legacy table or legacy column is altered by these migrations; existing Session/ImportBatch/ImportLine data is not backfilled or reinterpreted. Current table and migration diff support this. Migration tests on disposable SQLite were previously reported passing.
- **Unique collisions at migration time:** the target new tables are absent in the current DB, so their new unique indexes have no pre-existing rows to collide with at migration time. Unique conflicts can occur later on duplicate shipment references, expectation SKUs, request IDs, import dedupe keys/rows, inspection source rows, exception identities, and operation identities; application code must continue surfacing those conflicts rather than silently dropping data.
- **Partial migration / schema drift:** all three migrations are pending. If execution stops mid-migration, do not assume it rolled back completely or rerun blindly; preserve the database plus journal/WAL sidecars, inspect `_prisma_migrations` and actual schema, and recover from a fresh verified backup if required.
- **Business invariants are application-level:** quantities and status strings use SQLite integer/text columns; the schema does not add SQL `CHECK` constraints for non-negative integer counts or `received = accepted + damaged + onHold`. Route/service validation and tests enforce these rules, so writes bypassing the app are outside the proven boundary.
- **Nullable unique keys:** SQLite's `NULL` uniqueness behavior means the three-column exception unique indexes do not make a nullable key globally idempotent. Do not treat them as a substitute for service-level request identity.
- **Shop isolation:** composite shop FKs exist for Receipt, Shipment, inspection and operation links. Some child links use globally unique row IDs without carrying a shop column in that FK; authenticated server-side shop scoping remains necessary.

## 3. Legacy data compatibility

- `Session` is unchanged. Current DB has one Session row; no token fields were read.
- `ImportBatch`, `ImportLine`, and `ImportReceiptCounter` are unchanged by the S1–S3 migrations.
- Current legacy data is 3 batches / 30 lines / 2 counters. Batch status distribution is 1 `FAILED`, 2 `PREVIEWED`; line distribution is 10 `FAILED` / `INVENTORY_ACTIVATING`, 20 `BLOCKED` / `PREPARED`.
- `nhap_hang_001` remains the failed legacy batch. No new Shipment or Receipt will claim it as confirmed physical receipt history.
- The earlier `RELEASE_READINESS.md` records that the prior `20261022100000_auto_generated_import_receipts` migration was approved and applied on 2026-10-22. The current ledger confirms it is applied. That is a prior migration, not an S1–S3 migration.
- No S1–S3 migration was applied during this audit.

## 4. Backup / recovery plan

### Existing evidence checked

- `RELEASE_READINESS.md` documents a prior SQLite Online Backup API backup/restore rehearsal and successful integrity/FK checks before the 2026-10-22 migration.
- The documented pre-migration backup still exists at `stockhub-safety-backups/dev.sqlite.pre-migration-20261022T082516Z.sqlite` (81,920 bytes). Read-only verification returned `integrity_check=ok`, no FK violations, and counts `Session=1`, `ImportBatch=1`, `ImportLine=10`.
- **This backup is stale for restoring the current database:** it has 1 batch/10 lines, while current `dev.sqlite` has 3 batches/30 lines. Do not restore it over the current DB unless the owner explicitly accepts losing subsequent data.
- The previously documented restore-check file `/tmp/dev.sqlite.restore-check-20261022T082516Z.sqlite` and evidence directory `/tmp/stockhub-migration-readiness.uQbIjr/` are no longer present. The previous report records that a restore rehearsal succeeded then; that exact temporary restore artifact cannot be rechecked now.
- No automated backup/restore script or scheduled job was found in project scripts. `RELEASE_READINESS.md` contains a manual recovery runbook.

### Required before a future migration

1. Obtain explicit owner approval for a migration window and ensure no application/CLI process is writing the DB.
2. Create a **fresh, uniquely named backup of the current 3-batch/30-line database** using SQLite Online Backup API (or `VACUUM INTO`) rather than a raw file copy while writes may be active. Store it outside the repo with restrictive permissions; never overwrite the existing backup.
3. Open the backup read-only and verify `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, expected row counts, and `_prisma_migrations`; document the filename, size, timestamp, and result.
4. Rehearse restore from that fresh backup into a temporary path, verify it again, and retain the rehearsal evidence. Do not run project migrations during the rehearsal unless the owner has authorized isolated-copy migration testing.
5. Apply only the intended migration against the intended database after approval. Verify migration ledger, integrity, FK check, legacy row counts/statuses, and expected new tables/indexes before restarting normal writers.

### Recovery if migration or verification fails

1. Stop all DB writers and Shopify/React Router dev processes; do not retry migration blindly.
2. Preserve the failed DB file and any `-journal`, `-wal`, or `-shm` sidecars for diagnosis.
3. Restore the fresh approved backup through SQLite's Backup API into a separate temporary file; verify integrity, FK status, migration ledger, and legacy counts.
4. Only after verification and with all writers stopped, replace the target by the restored file using an owner-approved atomic recovery procedure. Keep the failed copy; do not delete or overwrite the only backup.

SQLite's Online Backup API produces a consistent snapshot of a live database; SQLite also documents `VACUUM INTO` as a safe alternative. A raw copy during an active transaction can be inconsistent. References: [SQLite Online Backup API](https://www.sqlite.org/backup.html), [SQLite corruption guidance on backup/restore](https://sqlite.org/howtocorrupt.html).

## 5. Startup scripts and Shopify config side effects

Inspected `package.json`, `shopify.web.toml`, `shopify.app.toml`, and `Dockerfile`.

- `npm run dev` invokes `shopify app dev`. `shopify.web.toml` has `predev = "npx prisma generate"` and `dev = "npx prisma migrate deploy && npm exec react-router dev"`. **This path automatically attempts pending migrations** and must not be run before migration approval.
- `npm run setup` executes `prisma generate && prisma migrate deploy`.
- `npm run docker-start` executes `npm run setup && npm run start`, so it also migrates.
- `npm run start` runs the built React Router server and has no migration command in the package script, but it can connect to/use the DB; it was not run.
- `npm run build`, lint, typecheck, and Prisma validation do not have a migration command in the inspected scripts.
- `config:link` / `config:use` can change local Shopify CLI app-config linkage/selection; they were not run. `deploy` is an external Shopify action and was not run.
- `shopify.app.toml` has `application_url = "https://example.com"`, `automatically_update_urls_on_dev = true`, and `include_config_on_deploy = true`. Shopify CLI dev can update local URLs/config, so it is not a safe way to start a browser check before approval.
- No project `.env` file or `SHOPIFY_*` process variables were present at audit time. Therefore an authenticated embedded browser run was not available from this checkout/configuration.

## 6. Shopify GraphQL query and scope findings

The snapshot query in `app/utils/receiving-inspection.server.ts` reads `ProductVariant → InventoryItem → InventoryLevels → Location.id / available quantity`. It was schema-validated for Admin GraphQL `2026-10`; no live Shopify API request was made during this audit.

| Source | Scopes observed |
|---|---|
| `shopify.app.toml` declared config | `read_products`, `read_inventory`, `read_locations`, `write_inventory`, `write_products` |
| Current local `Session.scope` | `read_locations`, `write_inventory`, `write_products` |
| Snapshot query field access | `InventoryLevel` requires `read_inventory`; `Location` accepts `read_locations` **or** `read_inventory` **or** `read_markets_home`. |

Shopify's authentication docs state a write scope for a resource also grants read access to it. Thus the existing `write_products` and `write_inventory` grants cover the query's product/inventory read needs, while `read_locations` directly satisfies Location access. `read_markets_home` is an alternative Location scope, not an additional mandatory scope for this query. **Do not add it.** This conclusion follows Shopify's field-scope documentation; live token authorization was not tested. Sources: [InventoryLevel access requirement](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/InventoryLevel), [Location alternative scopes](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Location), [scope semantics](https://shopify.dev/docs/apps/build/authentication-authorization).

Current DB session metadata has a stored scope string and a future expiry at audit time, but no API call was made to prove that token works. The local app URL is `example.com`, and runtime Shopify environment variables are absent. No scope/config edits, app redeploy, or reauthorization was performed.

## 7. Browser acceptance checklist (owner-run after approval)

**Do not use `npm run dev` or `docker-start` until migration approval**, because they apply migrations. First arrange an approved runtime and current URL/config without silently changing scopes or deploying.

### Access and navigation

- [ ] Open StockHub from the authenticated Shopify Admin for `demo-app-d0c6tdk6.myshopify.com` using an approved runtime URL.
- [ ] Confirm app authentication succeeds, the expected shop is shown, and no other shop's Shipment/Receipt data is visible.
- [ ] Confirm navigation to Shipments/Receiving and the current Location list loads without permission errors.

### Shipment and Receipt

- [ ] Create a Shipment with reference/issuer; confirm duplicate detection is scoped correctly and does not silently create a duplicate.
- [ ] Verify missing Expected Quantity displays as unknown, not zero.
- [ ] Create two Receipt Drafts for one Shipment at different Locations; each Receipt remains bound to exactly one Location.
- [ ] Confirm a Closed Shipment rejects a new Receipt; reopen requires a reason and preserves the prior event.

### CSV and matching

- [ ] Upload Expected Goods: inspect mapped source rows/errors, verify no Received quantity/Shopify operation appears before explicit confirmation, then confirm and verify the expected plan only.
- [ ] Upload Received Goods with valid and invalid rows: confirm source values, row numbers and error reasons remain visible; invalid structure/mapping blocks the file.
- [ ] Verify leading-zero SKUs, duplicate SKU merge decisions, ambiguous Shopify SKU handling, and blocked/unmatched rows.
- [ ] Verify upload is rejected once inspection has started; no source rows silently disappear.

### Inspection, snapshot and confirmation

- [ ] Prepare a Receipt and classify 70 physical units as 65 Accepted + 5 Damaged; verify the balance and proposed Shopify delta is exactly `+65`.
- [ ] Mark All Accepted intentionally, edit one line, and confirm it is reversible before confirmation.
- [ ] Keep unknown/ambiguous SKU On Hold; verify it creates no target or proposed delta.
- [ ] Add a Wrong Item with actual description, quantity, reason, suspected SKU, and `HOLD` or `RETURN`; try a forged invalid value only in a safe test environment and verify it is rejected server-side.
- [ ] Confirm snapshot displays the correct Receipt Location, timestamp, and current Available quantity; treat it as a snapshot, not a promise.
- [ ] Confirm UI says sync is pending/not enabled; it must never imply inventory was updated.
- [ ] Double-click/submit Confirm twice and verify one confirmed Receipt, one confirmation event, one stable pending operation per eligible line, and unchanged confirmed source data.
- [ ] Verify exceptions remain visible after Shipment closure; do not trigger S4 execution or any legacy Merge/Resume.

### Visual/responsive evidence

- [ ] Capture authenticated embedded screenshots at desktop (1280px) and mobile (390px) for Shipment list/detail, CSV preview, inspection, and final confirmation state.
- [ ] Check navigation, forms, error/empty/loading states, table usability, and horizontal overflow.
- [ ] Record app URL/runtime version and whether any Shopify authorization error appeared. Do not include access tokens in screenshots/logs.

No step in this checklist authorizes Shopify inventory/product mutations, Merge/Resume of historical batches, scope changes, or deployment.

## 8. GO / NO-GO and approval gate

### Recommendation: **NO-GO for migration on the current dev database now**

Reasons:

1. S1–S3 migrations are not yet applied, and `npm run dev` / `setup` / `docker-start` can apply them automatically.
2. The currently available verified backup is from before the current two later batches/20 lines were added; restoring it would lose current history.
3. The app URL is still `https://example.com`, and no runtime Shopify env is set, so embedded browser acceptance cannot yet be conducted safely.
4. The code migrations are structurally additive and the previous sprint report records isolated SQLite tests passing, but approval must be based on a fresh backup of today's DB and the intended runtime/config.

### Owner approval required before proceeding

- [ ] Approve creation of a fresh, consistent backup and restore rehearsal for the current `dev.sqlite`.
- [ ] Review and explicitly approve applying the three pending S1–S3 migrations to this dev database after backup verification.
- [ ] Decide/approve a safe authenticated browser runtime and URL setup. Shopify CLI dev must not be started implicitly because its config says it updates URLs and its web command runs migrations.
- [ ] No `read_markets_home` change is proposed. If live read authorization fails despite the existing write/read scopes, inspect Shopify's actual granted scopes/errors before asking for a specific permission change.

Until these gates are approved and completed, keep the existing database and app configuration unchanged; do not start Sprint 4.
