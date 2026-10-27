-- CreateTable
CREATE TABLE "CatalogImportBatch" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "submissionId" TEXT,
    "fileName" TEXT NOT NULL,
    "fileChecksum" TEXT NOT NULL,
    "originalCsv" TEXT NOT NULL,
    "sourceHeaders" JSONB NOT NULL,
    "mapping" JSONB,
    "status" TEXT NOT NULL DEFAULT 'MAPPING',
    "draftVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogImportLine" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "sourceRowNumber" INTEGER,
    "sourceValues" JSONB NOT NULL,
    "productName" TEXT,
    "sku" TEXT,
    "price" DECIMAL(20,6),
    "priceZeroConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "productGroupCode" TEXT,
    "size" TEXT,
    "color" TEXT,
    "vendor" TEXT,
    "productType" TEXT,
    "imageUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ERROR',
    "errors" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogImportLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogImportBatch_shop_createdAt_idx" ON "CatalogImportBatch"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "CatalogImportBatch_shop_status_updatedAt_idx" ON "CatalogImportBatch"("shop", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogImportBatch_shop_id_key" ON "CatalogImportBatch"("shop", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogImportBatch_shop_submissionId_key" ON "CatalogImportBatch"("shop", "submissionId");

-- CreateIndex
CREATE INDEX "CatalogImportLine_shop_batchId_status_rowNumber_idx" ON "CatalogImportLine"("shop", "batchId", "status", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogImportLine_shop_id_key" ON "CatalogImportLine"("shop", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogImportLine_batchId_rowNumber_key" ON "CatalogImportLine"("batchId", "rowNumber");

-- AddForeignKey
ALTER TABLE "CatalogImportLine" ADD CONSTRAINT "CatalogImportLine_shop_batchId_fkey" FOREIGN KEY ("shop", "batchId") REFERENCES "CatalogImportBatch"("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE;

