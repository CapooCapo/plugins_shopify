# StockHub Sprint 3.5 — Backup, Restore & Migration Rehearsal

**Run date:** 2026-10-23 (Asia/Ho_Chi_Minh)  
**Scope:** Fresh SQLite backup, separate restore rehearsal, then S1–S3 migration rehearsal on a second isolated copy.  
**Recommendation:** **GO to owner review/approval for a later migration window; NOT authorization to migrate `prisma/dev.sqlite`.**  
**Real database:** No migration or application write was performed on `prisma/dev.sqlite`.

## 1. Source database metadata

- Repository: `/home/giahoang/dev/plugin_shopify/stockhub`.
- Prisma datasource in `prisma/schema.prisma`: SQLite, literal `file:dev.sqlite`, resolving to `/home/giahoang/dev/plugin_shopify/stockhub/prisma/dev.sqlite`.
- Source size at rehearsal: 118,784 bytes. Source mtime remained `2026-10-23 14:22:56 +0700` through the rehearsal.
- `PRAGMA journal_mode`: `delete`.
- `dev.sqlite-wal`, `dev.sqlite-shm`, and `dev.sqlite-journal`: absent at inspection.
- A Node application process (PID 15020) had the database file open. It was not stopped or restarted. SQLite Online Backup API was used to obtain a consistent snapshot while it was open.
- Source `PRAGMA integrity_check`: `ok`; `PRAGMA foreign_key_check`: no rows.
- No access token or refresh token fields were read, printed, or included in the comparison hashes.

### Source baseline and migration ledger

| Table | Source rows |
|---|---:|
| `Session` | 1 |
| `ImportBatch` | 3 |
| `ImportLine` | 30 |
| `ImportReceiptCounter` | 2 |
| `_prisma_migrations` | 3 |

Applied migrations at source snapshot:

1. `20240530213853_create_session_table`
2. `20261022050000_create_import_batches`
3. `20261022100000_auto_generated_import_receipts`

Pending at source snapshot:

1. `20261023090000_add_shipments_receipts`
2. `20261023130000_receiving_csv_imports`
3. `20261023180000_receipt_inspection_foundation`

The 3 batch / 30 line / 2 counter baseline matches the earlier preflight. The historical failed `nhap_hang_001` batch was neither resumed nor modified.

## 2. Fresh backup and verification

- Backup: `/home/giahoang/dev/plugin_shopify/stockhub-safety-backups/dev.sqlite.sprint3-5-20261023T073601Z.sqlite`
- Created with Python `sqlite3.Connection.backup()` (SQLite Online Backup API) from a read-only source connection.
- Backup size: 118,784 bytes; file mode `0600`; containing directory mode `0700`.
- New timestamped filename; no existing backup was overwritten. Backup is outside the Git repository and was not uploaded or committed.
- Backup `integrity_check`: `ok`; `foreign_key_check`: no violations.
- Counts and all 3 applied migration names matched the source baseline.
- Canonical row hashes were computed for `Session` using only non-token fields (`id`, `shop`, `state`, `isOnline`, `scope`, `expires`), and for the four legacy/import tables. Only hashes/counts were emitted; no row contents or credentials were logged.

**Result: BACKUP PASS.**

## 3. Restore rehearsal

- Restored to a new, independent path: `/tmp/stockhub-s3-5-restore-vio7sue7/dev.sqlite`.
- Restore used SQLite Online Backup API; restore directory mode `0700`, DB file mode `0600`.
- Both backup and restore returned `integrity_check=ok` and zero FK violations.
- Compared table names, every table row count, canonical row digest per table, and schema SQL fingerprint: all matched exactly, including the migration ledger.

**Result: RESTORE PASS.** Temporary rehearsal artifacts were retained; no cleanup was performed.

## 4. Migration rehearsal

### Isolation proof and command path

- Created a second independent copy at `/tmp/stockhub-s3-5-migrate-09krve10/migration-copy.sqlite` (mode `0600`) from the verified fresh backup.
- Copied Prisma schema and migration files into `/tmp/stockhub-s3-5-migrate-09krve10/prisma/`; the temporary schema datasource was rewritten to the absolute migration-copy path.
- Set process `DATABASE_URL=file:/tmp/stockhub-s3-5-migrate-09krve10/migration-copy.sqlite` for CLI invocations. Prisma schema URL is authoritative here; both it and the CLI output identified the same temporary path.
- Before applying, direct `node_modules/.bin/prisma migrate status --schema /tmp/stockhub-s3-5-migrate-09krve10/prisma/schema.prisma` reported the temporary `migration-copy.sqlite` path and exactly the three intended pending migrations.
- Applied only with direct `node_modules/.bin/prisma migrate deploy --schema /tmp/stockhub-s3-5-migrate-09krve10/prisma/schema.prisma`. No npm lifecycle command, Shopify CLI, `predev`, app restart, or app config command ran.
- Afterward, Prisma reported schema up to date; `prisma validate` succeeded.

### Migration result and schema objects

All three pending migrations completed successfully on the temporary copy. New domain tables:

- `Shipment`
- `ShipmentExpectation`
- `ReceivingReceipt`
- `ShipmentEvent`
- `ReceivingImportAttempt`
- `ReceivingImportRow`
- `ReceivingImportProposalGroup`
- `ReceiptInspectionLine`
- `ReceiptInspectionException`
- `ReceiptInventoryOperation`

The only column additions to these new tables during later migrations were `ReceivingReceipt.confirmedAt`, `ReceivingReceipt.confirmationId`, `ReceivingImportRow.decisionReason`, `ReceivingImportRow.proposalJson`, `ReceivingImportRow.proposalGroupId`, and `ReceiptInspectionException.suspectedSku`. No column was added to or removed from legacy `Session`, `ImportBatch`, `ImportLine`, or `ImportReceiptCounter`.

New unique indexes/constraints:

- `Shipment`: `(shop, referenceType, issuerNormalized, referenceNormalized)`; `(shop, id)`.
- `ShipmentExpectation`: `(shipmentId, sku)`.
- `ReceivingReceipt`: `(shop, requestId)`; `(shop, id)`.
- `ReceivingImportAttempt`: `(shop, dedupeKey)`.
- `ReceivingImportRow`: `(attemptId, rowNumber)`.
- `ReceivingImportProposalGroup`: `(attemptId, groupKey)`.
- `ReceiptInspectionLine`: `(sourceRowId)`; `(shop, id)`.
- `ReceiptInspectionException`: `(shop, requestId)`; `(receiptId, lineId, type)`; `(receiptId, sourceRowId, type)`.
- `ReceiptInventoryOperation`: `(shop, operationKey)`; `(shop, lineId)`.

New non-unique indexes:

- `Shipment`: `(shop, status, createdAt)`; `(shop, referenceNormalized)`.
- `ShipmentExpectation`: `(shipmentId)`.
- `ReceivingReceipt`: `(shop, shipmentId, createdAt)`; `(shop, locationId)`.
- `ShipmentEvent`: `(shop, shipmentId, createdAt)`.
- `ReceivingImportAttempt`: `(shop, shipmentId, createdAt)`; `(shop, fileChecksum, mode)`.
- `ReceivingImportRow`: `(attemptId, outcome)`; `(sku)`.
- `ReceivingImportProposalGroup`: `(attemptId, status)`.
- `ReceiptInspectionLine`: `(shop, receiptId, createdAt)`; `(receiptId, sku)`.
- `ReceiptInspectionException`: `(shop, receiptId, status)`; `(sourceRowId)`.
- `ReceiptInventoryOperation`: `(shop, receiptId, status)`.

Foreign-key constraints created:

- `ShipmentExpectation.shipmentId → Shipment.id` (delete cascade).
- `ReceivingReceipt(shop, shipmentId) → Shipment(shop, id)` (delete restrict).
- `ShipmentEvent(shop, shipmentId) → Shipment(shop, id)` (delete restrict).
- `ReceivingImportAttempt(shop, shipmentId) → Shipment(shop, id)` and nullable `(shop, receiptId) → ReceivingReceipt(shop, id)` (delete restrict).
- `ReceivingImportRow.attemptId → ReceivingImportAttempt.id` (delete cascade); nullable `proposalGroupId → ReceivingImportProposalGroup.id` (delete set null).
- `ReceivingImportProposalGroup.attemptId → ReceivingImportAttempt.id` (delete cascade).
- `ReceiptInspectionLine(shop, receiptId) → ReceivingReceipt(shop, id)` and `sourceRowId → ReceivingImportRow.id` (delete restrict).
- `ReceiptInspectionException(shop, receiptId) → ReceivingReceipt(shop, id)`, nullable `(shop, lineId) → ReceiptInspectionLine(shop, id)`, and nullable `sourceRowId → ReceivingImportRow.id` (delete restrict).
- `ReceiptInventoryOperation(shop, receiptId) → ReceivingReceipt(shop, id)` and `(shop, lineId) → ReceiptInspectionLine(shop, id)` (delete restrict).
- Foreign-key update actions are `CASCADE` in the migration SQL.

Post-migration checks:

- SQLite `integrity_check=ok`; `foreign_key_check` returned no violations.
- All 10 new tables, expected columns, indexes, and FKs were present.
- Legacy row counts and canonical row hashes matched the fresh backup: Session 1, ImportBatch 3, ImportLine 30, ImportReceiptCounter 2.
- The 3 original completed `_prisma_migrations` rows (including their recorded fields/checksums) were unchanged. The ledger correctly grew from 3 to 6 rows after applying S1–S3.
- Prisma status: schema up to date; Prisma schema validation passed.

**Result: MIGRATION REHEARSAL PASS on isolated copy only.**

## 5. Regression checks

Ran focused migration/receiving tests, all using isolated temporary SQLite databases (test sources were inspected before execution):

```text
node --test \
  tests/shipments-migration.test.mjs \
  tests/receiving-import-prisma-isolated.test.mjs \
  tests/receiving-s2-prisma.test.mjs \
  tests/receiving-s3-inspection.test.mjs \
  tests/receiving-s3-concurrency.test.mjs
```

**13 tests passed, 0 failed.** These tests and fixture results do not prove a live Shopify workflow. No authenticated browser test or live Shopify API request was performed.

## 6. Failures, risks, and limits

- No rehearsal step failed. The source DB remained at 3 migrations with the original table counts and source file size/mtime unchanged after the run.
- The app process had the source DB open. Online backup makes a consistent point-in-time backup; before a real migration, the owner must arrange a safe maintenance window and ensure no app process can write during the migration.
- `npm run dev`, `npm run setup`, and `npm run docker-start` can apply migrations. Do not use them as a way to conduct browser acceptance before explicit migration approval. `shopify.web.toml` also allows Shopify CLI dev to update local URLs/config; no CLI command was run.
- The old backup `dev.sqlite.pre-migration-20261022T082516Z.sqlite` remains stale relative to today's 3-batch/30-line DB. Do not restore it over the source DB.
- New unique indexes are empty at migration time. Conflicts are therefore not a migration-time collision risk on this source; future duplicate inputs must still be handled by application logic. SQLite allows multiple `NULL` values in unique indexes, so nullable unique identities do not replace service-level idempotency.
- Quantity/status business invariants remain app-level (the migration SQL does not add quantity `CHECK` constraints). Composite shop FKs help preserve ownership, but authenticated server-side shop scoping remains required for links keyed by globally unique child IDs.
- Backup and temporary rehearsal copies are intentionally retained. No commit, push, deploy, Shopify write, scope change, reset, or cleanup occurred.

## 7. Shopify scope findings

Existing snapshot GraphQL query and scope analysis were documented in `STOCKHUB_SPRINT_3_5_PREFLIGHT.md`: `read_locations` satisfies Location reads; `write_inventory`/`write_products` provide corresponding read access under Shopify scope semantics. **No `read_markets_home` scope addition is required or proposed.** No live API request was made, so actual token authorization remains not verified.

## 8. Browser acceptance checklist

The embedded browser gate remains owner-run after the database/config approval and a safe runtime are available. `npm run dev`/`docker-start` must not be used until migration approval due to their migration side effect.

- [ ] Open StockHub in authenticated Shopify Admin for `demo-app-d0c6tdk6.myshopify.com`; confirm correct shop identity and no cross-shop data.
- [ ] Verify Locations load and each Receipt is bound to exactly one Location; create two Receipts on one Shipment at different Locations.
- [ ] Create Shipment; test duplicate reference handling, unknown expected quantity, closed-state block, and reasoned reopen history.
- [ ] Test Expected Goods without creating Received quantity or Shopify operations before explicit plan confirmation.
- [ ] Test Received Goods with valid/invalid rows, preserving source values, row numbers, and error reasons; verify malformed structure blocks the file.
- [ ] Test leading-zero SKU, duplicate rows, ambiguous Shopify SKU, blocked/unmatched rows, and upload protection after inspection begins.
- [ ] Inspect 70 received as 65 Accepted + 5 Damaged; proposed Shopify delta must equal `+65`, never `+70`.
- [ ] Keep unknown SKU On Hold; verify no inventory target/delta. Verify Mark All Accepted is intentional and editable before confirmation.
- [ ] Verify wrong-item details, receipt/location snapshot and timestamp, and explicit pending/not-enabled sync status.
- [ ] Double-submit confirmation; verify one confirmation and one stable pending operation per eligible line; confirmed source data stays immutable.
- [ ] Close Shipment with unresolved exceptions; confirm issues remain visible. Do not run S4 execution or legacy Merge/Resume.
- [ ] Capture authenticated embedded screenshots at 1280px and 390px for Shipment list/detail, CSV preview, inspection, and final confirmation; verify error/loading/empty states and no horizontal overflow.
- [ ] Record runtime URL/version and authorization outcomes without including tokens in logs/screenshots.

No checklist item authorizes Shopify mutations, legacy Merge/Resume, a scope/config change, or deployment.

## 9. GO / NO-GO and owner approval

**GO to owner approval for scheduling the real migration. NO-GO to applying it now without that approval.** Isolated restore and migration rehearsals passed, but the current `dev.sqlite` was deliberately not migrated.

Owner action required before any real DB migration:

1. Review this report and explicitly authorize applying these exact three migrations to `/home/giahoang/dev/plugin_shopify/stockhub/prisma/dev.sqlite`.
2. Choose a maintenance window and ensure the application process is quiesced/no writer can change the DB. The current Node process was observed holding the database open; it was not stopped or restarted.
3. Confirm the fresh backup above is retained and accepted as the recovery point; do not substitute the stale 2026-10-22 backup.
4. Separately authorize/provide a safe authenticated embedded-browser runtime if browser acceptance is required before proceeding. Current app URL/config and credentials were not changed to arrange one.

Until then: preserve the current database/configuration, do not invoke migration-bearing startup scripts, do not start Sprint 4, and do not apply any migration to the source DB.
