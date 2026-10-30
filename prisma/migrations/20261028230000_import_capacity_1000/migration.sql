ALTER TABLE "ImportBatch"
    ADD COLUMN "originalCsv" TEXT,
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "activeMergeApprovalId" TEXT;

CREATE TABLE "ImportMergeApproval" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "snapshotJson" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "receiptRevision" INTEGER NOT NULL,
    "chunkNumber" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImportMergeApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImportMergeApproval_shop_id_key"
    ON "ImportMergeApproval"("shop", "id");
CREATE INDEX "ImportMergeApproval_shop_batchId_createdAt_idx"
    ON "ImportMergeApproval"("shop", "batchId", "createdAt");
CREATE INDEX "ImportMergeApproval_shop_status_updatedAt_idx"
    ON "ImportMergeApproval"("shop", "status", "updatedAt");
CREATE INDEX "CatalogImportBatch_shop_fileChecksum_idx"
    ON "CatalogImportBatch"("shop", "fileChecksum");

ALTER TABLE "ImportMergeApproval"
    ADD CONSTRAINT "ImportMergeApproval_shop_batchId_fkey"
    FOREIGN KEY ("shop", "batchId")
    REFERENCES "ImportBatch"("shop", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
