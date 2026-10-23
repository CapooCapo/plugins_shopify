-- Additive Sprint 3 inspection and confirmation foundation; legacy ImportBatch/ImportLine untouched.
ALTER TABLE "ReceivingReceipt" ADD COLUMN "confirmedAt" DATETIME;
ALTER TABLE "ReceivingReceipt" ADD COLUMN "confirmationId" TEXT;

CREATE TABLE "ReceiptInspectionLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "sourceRowId" TEXT NOT NULL,
    "sku" TEXT,
    "productName" TEXT,
    "receivedQty" INTEGER NOT NULL,
    "acceptedQty" INTEGER NOT NULL DEFAULT 0,
    "damagedQty" INTEGER NOT NULL DEFAULT 0,
    "onHoldQty" INTEGER NOT NULL DEFAULT 0,
    "matchOutcome" TEXT NOT NULL,
    "matchedProductId" TEXT,
    "matchedVariantId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReceiptInspectionLine_shop_receiptId_fkey" FOREIGN KEY ("shop", "receiptId") REFERENCES "ReceivingReceipt" ("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReceiptInspectionLine_sourceRowId_fkey" FOREIGN KEY ("sourceRowId") REFERENCES "ReceivingImportRow" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReceiptInspectionLine_sourceRowId_key" ON "ReceiptInspectionLine"("sourceRowId");
CREATE UNIQUE INDEX "ReceiptInspectionLine_shop_id_key" ON "ReceiptInspectionLine"("shop", "id");
CREATE INDEX "ReceiptInspectionLine_shop_receiptId_createdAt_idx" ON "ReceiptInspectionLine"("shop", "receiptId", "createdAt");
CREATE INDEX "ReceiptInspectionLine_receiptId_sku_idx" ON "ReceiptInspectionLine"("receiptId", "sku");

CREATE TABLE "ReceiptInspectionException" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "lineId" TEXT,
    "sourceRowId" TEXT,
    "requestId" TEXT,
    "type" TEXT NOT NULL,
    "quantity" INTEGER,
    "reason" TEXT NOT NULL,
    "disposition" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceiptInspectionException_shop_receiptId_fkey" FOREIGN KEY ("shop", "receiptId") REFERENCES "ReceivingReceipt" ("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReceiptInspectionException_shop_lineId_fkey" FOREIGN KEY ("shop", "lineId") REFERENCES "ReceiptInspectionLine" ("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReceiptInspectionException_sourceRowId_fkey" FOREIGN KEY ("sourceRowId") REFERENCES "ReceivingImportRow" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE "ReceiptInspectionException" ADD COLUMN "suspectedSku" TEXT;
CREATE UNIQUE INDEX "ReceiptInspectionException_shop_requestId_key" ON "ReceiptInspectionException"("shop", "requestId");
CREATE UNIQUE INDEX "ReceiptInspectionException_receiptId_lineId_type_key" ON "ReceiptInspectionException"("receiptId", "lineId", "type");
CREATE UNIQUE INDEX "ReceiptInspectionException_receiptId_sourceRowId_type_key" ON "ReceiptInspectionException"("receiptId", "sourceRowId", "type");
CREATE INDEX "ReceiptInspectionException_shop_receiptId_status_idx" ON "ReceiptInspectionException"("shop", "receiptId", "status");
CREATE INDEX "ReceiptInspectionException_sourceRowId_idx" ON "ReceiptInspectionException"("sourceRowId");

CREATE TABLE "ReceiptInventoryOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "targetVariantId" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "acceptedDelta" INTEGER NOT NULL,
    "snapshotAvailable" INTEGER,
    "snapshotTakenAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceiptInventoryOperation_shop_receiptId_fkey" FOREIGN KEY ("shop", "receiptId") REFERENCES "ReceivingReceipt" ("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReceiptInventoryOperation_shop_lineId_fkey" FOREIGN KEY ("shop", "lineId") REFERENCES "ReceiptInspectionLine" ("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReceiptInventoryOperation_shop_operationKey_key" ON "ReceiptInventoryOperation"("shop", "operationKey");
CREATE UNIQUE INDEX "ReceiptInventoryOperation_shop_lineId_key" ON "ReceiptInventoryOperation"("shop", "lineId");
CREATE INDEX "ReceiptInventoryOperation_shop_receiptId_status_idx" ON "ReceiptInventoryOperation"("shop", "receiptId", "status");
