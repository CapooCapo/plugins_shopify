-- Append-only, shop-scoped activity timeline for import actions.
CREATE UNIQUE INDEX "ImportBatch_shop_id_key" ON "ImportBatch"("shop", "id");

CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "importBatchId" TEXT,
    "importLineId" TEXT,
    "receiptCode" TEXT,
    "attemptId" TEXT,
    "summary" TEXT NOT NULL,
    "metadataJson" TEXT,
    "sourceKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActivityLog_shop_importBatchId_fkey"
      FOREIGN KEY ("shop", "importBatchId") REFERENCES "ImportBatch" ("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ActivityLog_shop_sourceKey_key" ON "ActivityLog"("shop", "sourceKey");
CREATE INDEX "ActivityLog_shop_occurredAt_id_idx" ON "ActivityLog"("shop", "occurredAt", "id");
CREATE INDEX "ActivityLog_shop_eventType_occurredAt_id_idx" ON "ActivityLog"("shop", "eventType", "occurredAt", "id");
CREATE INDEX "ActivityLog_shop_outcome_occurredAt_id_idx" ON "ActivityLog"("shop", "outcome", "occurredAt", "id");
CREATE INDEX "ActivityLog_shop_importBatchId_occurredAt_idx" ON "ActivityLog"("shop", "importBatchId", "occurredAt");
