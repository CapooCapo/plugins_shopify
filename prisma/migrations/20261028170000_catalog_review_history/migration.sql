-- Preserve prior merchant review snapshots when a Shopify re-comparison changes.
CREATE TABLE "CatalogImportReviewHistory" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "draftVersion" INTEGER NOT NULL,
    "reviewVersion" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "snapshotFingerprint" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "shopifyProductId" TEXT,
    "matchedVariantIds" JSONB NOT NULL,
    "decisions" JSONB NOT NULL,
    "snapshotCapturedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CatalogImportReviewHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogImportReviewHistory_shop_batchId_groupId_draftVersion_archivedAt_idx"
    ON "CatalogImportReviewHistory"("shop", "batchId", "groupId", "draftVersion", "archivedAt");
CREATE INDEX "CatalogImportReviewHistory_shop_snapshotFingerprint_idx"
    ON "CatalogImportReviewHistory"("shop", "snapshotFingerprint");

ALTER TABLE "CatalogImportReviewHistory"
    ADD CONSTRAINT "CatalogImportReviewHistory_shop_batchId_groupId_fkey"
    FOREIGN KEY ("shop", "batchId", "groupId")
    REFERENCES "CatalogImportGroup"("shop", "batchId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
