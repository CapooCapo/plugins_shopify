-- Additive, tenant-scoped P2 catalog execution history. This migration is not
-- applied by the application code; verify only against a disposable PG16 DB.
CREATE UNIQUE INDEX "CatalogImportLine_shop_batchId_id_key"
    ON "CatalogImportLine"("shop", "batchId", "id");

CREATE UNIQUE INDEX "CatalogImportReview_shop_batchId_id_key"
    ON "CatalogImportReview"("shop", "batchId", "id");
CREATE UNIQUE INDEX "CatalogImportReview_shop_batchId_groupId_id_key"
    ON "CatalogImportReview"("shop", "batchId", "groupId", "id");

CREATE TABLE "CatalogExecutionOperation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "draftVersion" INTEGER NOT NULL,
    "reviewVersion" INTEGER NOT NULL,
    "snapshotFingerprint" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "productId" TEXT,
    "planJson" JSONB NOT NULL,
    "result" JSONB,
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "CatalogExecutionOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CatalogExecutionOperation_plan_check" CHECK ("plan" IN ('CREATE', 'UPDATE', 'SKIP', 'CONFLICT')),
    CONSTRAINT "CatalogExecutionOperation_status_check" CHECK ("status" IN ('READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SKIPPED', 'CONFLICT')),
    CONSTRAINT "CatalogExecutionOperation_group_fkey" FOREIGN KEY ("shop", "batchId", "groupId") REFERENCES "CatalogImportGroup"("shop", "batchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CatalogExecutionOperation_review_fkey" FOREIGN KEY ("shop", "batchId", "groupId", "reviewId") REFERENCES "CatalogImportReview"("shop", "batchId", "groupId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CatalogExecutionOperation_shop_id_key"
    ON "CatalogExecutionOperation"("shop", "id");
CREATE UNIQUE INDEX "CatalogExecutionOperation_shop_batchId_id_key"
    ON "CatalogExecutionOperation"("shop", "batchId", "id");
CREATE UNIQUE INDEX "CatalogExecutionOperation_shop_reviewId_key"
    ON "CatalogExecutionOperation"("shop", "reviewId");
CREATE UNIQUE INDEX "CatalogExecutionOperation_shop_idempotencyKey_key"
    ON "CatalogExecutionOperation"("shop", "idempotencyKey");
CREATE INDEX "CatalogExecutionOperation_shop_batchId_groupId_createdAt_idx"
    ON "CatalogExecutionOperation"("shop", "batchId", "groupId", "createdAt");
CREATE INDEX "CatalogExecutionOperation_shop_status_updatedAt_idx"
    ON "CatalogExecutionOperation"("shop", "status", "updatedAt");

CREATE TABLE "CatalogExecutionItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "productId" TEXT,
    "variantId" TEXT,
    "approvedFields" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatalogExecutionItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CatalogExecutionItem_plan_check" CHECK ("plan" IN ('CREATE', 'UPDATE', 'SKIP', 'CONFLICT')),
    CONSTRAINT "CatalogExecutionItem_status_check" CHECK ("status" IN ('READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SKIPPED', 'CONFLICT')),
    CONSTRAINT "CatalogExecutionItem_operation_fkey" FOREIGN KEY ("shop", "batchId", "operationId") REFERENCES "CatalogExecutionOperation"("shop", "batchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CatalogExecutionItem_line_fkey" FOREIGN KEY ("shop", "batchId", "lineId") REFERENCES "CatalogImportLine"("shop", "batchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CatalogExecutionItem_shop_operationId_id_key"
    ON "CatalogExecutionItem"("shop", "operationId", "id");
CREATE UNIQUE INDEX "CatalogExecutionItem_shop_operationId_lineId_key"
    ON "CatalogExecutionItem"("shop", "operationId", "lineId");
CREATE UNIQUE INDEX "CatalogExecutionItem_shop_idempotencyKey_key"
    ON "CatalogExecutionItem"("shop", "idempotencyKey");
CREATE INDEX "CatalogExecutionItem_shop_batchId_status_idx"
    ON "CatalogExecutionItem"("shop", "batchId", "status");

CREATE TABLE "CatalogExecutionAttempt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "itemId" TEXT,
    "mutation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARED',
    "requestHash" TEXT NOT NULL,
    "errorCode" TEXT,
    "detail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "CatalogExecutionAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CatalogExecutionAttempt_mutation_check" CHECK ("mutation" IN ('productCreate', 'productUpdate', 'productVariantsBulkUpdate', 'productVariantsBulkCreate')),
    CONSTRAINT "CatalogExecutionAttempt_status_check" CHECK ("status" IN ('PREPARED', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'RECONCILED')),
    CONSTRAINT "CatalogExecutionAttempt_operation_fkey" FOREIGN KEY ("shop", "operationId") REFERENCES "CatalogExecutionOperation"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CatalogExecutionAttempt_item_fkey" FOREIGN KEY ("shop", "operationId", "itemId") REFERENCES "CatalogExecutionItem"("shop", "operationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CatalogExecutionAttempt_shop_id_key"
    ON "CatalogExecutionAttempt"("shop", "id");
CREATE INDEX "CatalogExecutionAttempt_shop_operationId_startedAt_idx"
    ON "CatalogExecutionAttempt"("shop", "operationId", "startedAt");
CREATE INDEX "CatalogExecutionAttempt_shop_status_startedAt_idx"
    ON "CatalogExecutionAttempt"("shop", "status", "startedAt");
