-- Persist a single owner while an UNKNOWN catalog execution is reconciled or safely resumed.
ALTER TABLE "CatalogExecutionOperation"
    ADD COLUMN "claimToken" TEXT,
    ADD COLUMN "claimExpiresAt" TIMESTAMP(3);

ALTER TABLE "CatalogExecutionOperation"
    DROP CONSTRAINT "CatalogExecutionOperation_status_check";
ALTER TABLE "CatalogExecutionOperation"
    ADD CONSTRAINT "CatalogExecutionOperation_status_check"
    CHECK ("status" IN ('READY', 'RUNNING', 'RECONCILING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SKIPPED', 'CONFLICT'));

ALTER TABLE "CatalogExecutionAttempt"
    ADD COLUMN "claimToken" TEXT;
