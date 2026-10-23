# StockHub Sprint 3.5 — Migration Execution Report

**Date:** 2026-10-23 (Asia/Ho_Chi_Minh)  
**Result:** **MIGRATION PASS** for the three owner-authorized Sprints 1–3 migrations on `prisma/dev.sqlite`.  
**Scope limits honored:** No reset, `db push`, Shopify mutation, scope/config change, Shopify CLI restart, commit, push, Shopify app deployment, or Sprint 4 work.

## 1. Maintenance window and datasource

- Identified the running app as `shopify app dev` (PID 14764), with its `cloudflared` and React Router children (PIDs 14840, 15008, 15020). `lsof` showed React Router PID 15020 holding `prisma/dev.sqlite` open.
- Sent SIGINT to the identified Shopify CLI parent. The CLI and its child process group exited. A subsequent `lsof` check showed no process holding the source DB or its WAL/SHM sidecars. Unrelated processes were not stopped.
- Did not run `npm run dev`, `setup`, `docker-start`, or restart the Shopify CLI.
- `prisma/schema.prisma` specifies SQLite datasource `file:dev.sqlite`, resolving to `/home/giahoang/dev/plugin_shopify/stockhub/prisma/dev.sqlite`. Prisma CLI independently printed this exact datasource for both status and deploy. No `DATABASE_URL` override is referenced by this schema.
- Source journal mode was `delete`; no WAL, SHM, or journal sidecar was present at the post-stop checks.

## 2. Baseline and fresh backup

The source matched the previously rehearsed backup on table names, safe row hashes, and row counts except for non-token fields of the `Session` row. The hash excludes `accessToken` and `refreshToken`; the specific cause of the Session difference was not established. The legacy operational tables and migration ledger were unchanged. Because of that difference, the old backup was not used as the migration point; a new backup and rehearsal were completed before proceeding.

- Source baseline before migration: `Session=1`, `ImportBatch=3`, `ImportLine=30`, `ImportReceiptCounter=2`, `_prisma_migrations=3`.
- Fresh consistent backup: `/home/giahoang/dev/plugin_shopify/stockhub-safety-backups/dev.sqlite.sprint3-5-execution-20261023T083533Z.sqlite`.
- Created using Python SQLite `Connection.backup()` from a read-only source connection. Backup file mode `0600`; containing directory mode `0700`; backup was not placed in the repository, uploaded, or committed.
- Source and backup both passed `integrity_check=ok` and had zero FK violations. All tables/counts and hashes matched, including Session non-token fields and migration history.
- Restore rehearsal to `/tmp/stockhub-s3-5-execution-restore-koacz6ih/restore.sqlite`: PASS. Integrity, FK check, table list, counts, and hashes matched the fresh backup.
- Isolated migration rehearsal copy: `/tmp/stockhub-s3-5-execution-migrate-6gn706uh/migration-copy.sqlite`. Prisma reported the temporary datasource path and exactly the three approved migrations pending. `migrate deploy` succeeded there; no startup scripts or Shopify CLI were invoked.

## 3. Source database migration execution

Immediately before deployment, source and fresh backup again matched on all table names, row counts, and hashes; source integrity and FK checks were clean. `prisma migrate status` reported exactly these three pending migrations and no others:

1. `20261023090000_add_shipments_receipts`
2. `20261023130000_receiving_csv_imports`
3. `20261023180000_receipt_inspection_foundation`

Ran only:

```text
./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
```

Prisma reported all three migrations applied successfully to `file:dev.sqlite`. No retry, reset, history repair, or restore-over-source was performed.

## 4. Post-migration verification

- Migration ledger: exactly six completed migrations — the three prior migrations plus the three authorized S1–S3 migrations; no additional migration was applied.
- Expected ten new tables exist: `Shipment`, `ShipmentExpectation`, `ReceivingReceipt`, `ShipmentEvent`, `ReceivingImportAttempt`, `ReceivingImportRow`, `ReceivingImportProposalGroup`, `ReceiptInspectionLine`, `ReceiptInspectionException`, `ReceiptInventoryOperation`.
- SQLite `integrity_check=ok`; `foreign_key_check` returned zero violations.
- Legacy counts remain `Session=1`, `ImportBatch=3`, `ImportLine=30`, `ImportReceiptCounter=2`; their row hashes match the fresh backup (Session hashes exclude token columns).
- Schema inspection found 40 indexes total in the migrated DB and FKs on the expected 10 new relational tables.
- `prisma migrate status`: “Database schema is up to date.”
- `prisma validate`: passed.
- Focused isolated regression suite: **13 passed, 0 failed** across shipments migration, S2 receiving import, S3 inspection, and S3 concurrency tests. Test sources were checked and use isolated temporary SQLite databases; they do not target `dev.sqlite`.

## 5. Browser / Shopify acceptance

**NOT VERIFIED.** No browser QA or live Shopify API request was run as part of this migration execution. The embedded-app browser checklist remains in [STOCKHUB_SPRINT_3_5_PREFLIGHT.md](STOCKHUB_SPRINT_3_5_PREFLIGHT.md). Do not treat migration success as browser acceptance. No Shopify mutations or scope changes were made; `read_markets_home` was not added. The Shopify CLI was stopped and not restarted.

## 6. Risks and owner follow-up

- The local dev app is currently stopped because it was gracefully quiesced for the migration. Any later restart of `shopify app dev` is outside this run; note its existing `dev` command can invoke `prisma migrate deploy` and Shopify CLI development may update local URLs/configuration.
- The fresh backup is retained as the pre-migration recovery point. Do not overwrite it. If recovery is needed, preserve the post-migration DB and any sidecars, stop writers, restore the backup to a separate path first, verify it, and use an explicitly approved recovery procedure; no rollback was needed or performed.
- Browser acceptance, live token authorization, and Shopify-side behavior remain unverified. No Sprint 4 inventory execution or legacy batch Merge/Resume was performed.

## 7. Git / artifact status

- Only this report was created by this execution. The repository already contained many untracked files; they were preserved and not cleaned.
- No commit, push, or deploy was performed. This report is untracked.
