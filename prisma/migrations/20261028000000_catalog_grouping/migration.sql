-- REVIEW ONLY: additive PR-03 grouping proposal. Do not apply before approval.
CREATE TABLE "CatalogImportGroup" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "groupingKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "selections" JSONB NOT NULL,
    "validation" JSONB NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatalogImportGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CatalogImportGroup_shop_batchId_id_key"
    ON "CatalogImportGroup"("shop", "batchId", "id");
CREATE INDEX "CatalogImportGroup_shop_batchId_state_createdAt_idx"
    ON "CatalogImportGroup"("shop", "batchId", "state", "createdAt");

ALTER TABLE "CatalogImportGroup"
    ADD CONSTRAINT "CatalogImportGroup_shop_batchId_fkey"
    FOREIGN KEY ("shop", "batchId")
    REFERENCES "CatalogImportBatch"("shop", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CatalogImportLine" ADD COLUMN "groupId" TEXT;
CREATE INDEX "CatalogImportLine_shop_batchId_groupId_idx"
    ON "CatalogImportLine"("shop", "batchId", "groupId");
ALTER TABLE "CatalogImportLine"
    ADD CONSTRAINT "CatalogImportLine_shop_batchId_groupId_fkey"
    FOREIGN KEY ("shop", "batchId", "groupId")
    REFERENCES "CatalogImportGroup"("shop", "batchId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE;
