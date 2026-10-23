-- Additive Sprint 2 receiving imports; legacy ImportBatch/ImportLine remain untouched.
CREATE UNIQUE INDEX "ReceivingReceipt_shop_id_key" ON "ReceivingReceipt"("shop", "id");
CREATE TABLE "ReceivingImportAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "receiptId" TEXT,
    "mode" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileChecksum" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "mappingJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceivingImportAttempt_shop_shipmentId_fkey" FOREIGN KEY ("shop", "shipmentId") REFERENCES "Shipment" ("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReceivingImportAttempt_shop_receiptId_fkey" FOREIGN KEY ("shop", "receiptId") REFERENCES "ReceivingReceipt" ("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ReceivingImportRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawValuesJson" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER,
    "productGroup" TEXT,
    "validationJson" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    "decision" TEXT,
    "matchedProductId" TEXT,
    "matchedVariantId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceivingImportRow_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ReceivingImportAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReceivingImportProposalGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "decision" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceivingImportProposalGroup_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ReceivingImportAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "ReceivingImportRow" ADD COLUMN "decisionReason" TEXT;
ALTER TABLE "ReceivingImportRow" ADD COLUMN "proposalJson" TEXT;
ALTER TABLE "ReceivingImportRow" ADD COLUMN "proposalGroupId" TEXT REFERENCES "ReceivingImportProposalGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ReceivingImportAttempt_shop_shipmentId_createdAt_idx" ON "ReceivingImportAttempt"("shop", "shipmentId", "createdAt");
CREATE INDEX "ReceivingImportAttempt_shop_fileChecksum_mode_idx" ON "ReceivingImportAttempt"("shop", "fileChecksum", "mode");
CREATE UNIQUE INDEX "ReceivingImportAttempt_shop_dedupeKey_key" ON "ReceivingImportAttempt"("shop", "dedupeKey");
CREATE UNIQUE INDEX "ReceivingImportRow_attemptId_rowNumber_key" ON "ReceivingImportRow"("attemptId", "rowNumber");
CREATE INDEX "ReceivingImportRow_attemptId_outcome_idx" ON "ReceivingImportRow"("attemptId", "outcome");
CREATE INDEX "ReceivingImportRow_sku_idx" ON "ReceivingImportRow"("sku");
CREATE UNIQUE INDEX "ReceivingImportProposalGroup_attemptId_groupKey_key" ON "ReceivingImportProposalGroup"("attemptId", "groupKey");
CREATE INDEX "ReceivingImportProposalGroup_attemptId_status_idx" ON "ReceivingImportProposalGroup"("attemptId", "status");
