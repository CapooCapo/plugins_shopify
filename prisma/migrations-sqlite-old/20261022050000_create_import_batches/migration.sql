-- Add persistent, store-scoped CSV import receipts and line operation state.
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "receiptKey" TEXT NOT NULL,
    "fileChecksum" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEWED',
    "actor" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
);

CREATE TABLE "ImportLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "price" TEXT,
    "imageUrl" TEXT,
    "quantity" INTEGER,
    "operationType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEWED',
    "stage" TEXT NOT NULL DEFAULT 'PREPARED',
    "operationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "inventoryItemId" TEXT,
    "expectedQuantity" INTEGER,
    "matchedProductTitle" TEXT,
    "matchedVariantTitle" TEXT,
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "shopifyProductUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "ImportLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ImportBatch_shop_receiptKey_key" ON "ImportBatch"("shop", "receiptKey");
CREATE INDEX "ImportBatch_shop_createdAt_idx" ON "ImportBatch"("shop", "createdAt");
CREATE INDEX "ImportBatch_status_idx" ON "ImportBatch"("status");
CREATE UNIQUE INDEX "ImportLine_operationId_key" ON "ImportLine"("operationId");
CREATE UNIQUE INDEX "ImportLine_idempotencyKey_key" ON "ImportLine"("idempotencyKey");
CREATE UNIQUE INDEX "ImportLine_batchId_rowNumber_key" ON "ImportLine"("batchId", "rowNumber");
CREATE INDEX "ImportLine_batchId_status_idx" ON "ImportLine"("batchId", "status");
CREATE INDEX "ImportLine_sku_idx" ON "ImportLine"("sku");
