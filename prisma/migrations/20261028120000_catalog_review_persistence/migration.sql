-- Add durable, tenant-scoped review snapshots and merchant decisions.
CREATE TABLE "CatalogImportReview" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "draftVersion" INTEGER NOT NULL,
    "reviewVersion" INTEGER NOT NULL DEFAULT 0,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "snapshotFingerprint" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "shopifyProductId" TEXT,
    "matchedVariantIds" JSONB NOT NULL,
    "decisions" JSONB NOT NULL,
    "snapshotCapturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatalogImportReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CatalogImportReview_shop_batchId_groupId_draftVersion_key"
    ON "CatalogImportReview"("shop", "batchId", "groupId", "draftVersion");
CREATE INDEX "CatalogImportReview_shop_batchId_draftVersion_status_idx"
    ON "CatalogImportReview"("shop", "batchId", "draftVersion", "status");
CREATE INDEX "CatalogImportReview_shop_shopifyProductId_idx"
    ON "CatalogImportReview"("shop", "shopifyProductId");

ALTER TABLE "CatalogImportReview"
    ADD CONSTRAINT "CatalogImportReview_shop_batchId_groupId_fkey"
    FOREIGN KEY ("shop", "batchId", "groupId")
    REFERENCES "CatalogImportGroup"("shop", "batchId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
