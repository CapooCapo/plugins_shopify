-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "submissionId" TEXT,
    "receiptCode" TEXT NOT NULL,
    "fileChecksum" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEWED',
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "importBatchId" TEXT,
    "importLineId" TEXT,
    "receiptCode" TEXT,
    "attemptId" TEXT,
    "summary" TEXT NOT NULL,
    "metadataJson" TEXT,
    "sourceKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportReceiptCounter" (
    "shop" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "lastSequence" INTEGER NOT NULL,

    CONSTRAINT "ImportReceiptCounter_pkey" PRIMARY KEY ("shop","dateKey")
);

-- CreateTable
CREATE TABLE "ImportLine" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ImportLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "referenceNormalized" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "issuerNormalized" TEXT NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentExpectation" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "expectedQty" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentExpectation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivingReceipt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "confirmedAt" TIMESTAMP(3),
    "confirmationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceivingReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivingImportAttempt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "receiptId" TEXT,
    "mode" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileChecksum" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "mappingJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivingImportAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivingImportRow" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawValuesJson" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER,
    "productGroup" TEXT,
    "validationJson" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    "decision" TEXT,
    "decisionReason" TEXT,
    "proposalJson" TEXT,
    "proposalGroupId" TEXT,
    "matchedProductId" TEXT,
    "matchedVariantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivingImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptInspectionLine" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptInspectionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptInspectionException" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "lineId" TEXT,
    "sourceRowId" TEXT,
    "requestId" TEXT,
    "type" TEXT NOT NULL,
    "quantity" INTEGER,
    "suspectedSku" TEXT,
    "reason" TEXT NOT NULL,
    "disposition" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptInspectionException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptInventoryOperation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "targetVariantId" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "acceptedDelta" INTEGER NOT NULL,
    "snapshotAvailable" INTEGER,
    "snapshotTakenAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptInventoryOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivingImportProposalGroup" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "decision" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivingImportProposalGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_shop_createdAt_idx" ON "ImportBatch"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "ImportBatch_status_idx" ON "ImportBatch"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_shop_submissionId_key" ON "ImportBatch"("shop", "submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_shop_receiptCode_key" ON "ImportBatch"("shop", "receiptCode");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_shop_id_key" ON "ImportBatch"("shop", "id");

-- CreateIndex
CREATE INDEX "ActivityLog_shop_occurredAt_id_idx" ON "ActivityLog"("shop", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "ActivityLog_shop_eventType_occurredAt_id_idx" ON "ActivityLog"("shop", "eventType", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "ActivityLog_shop_outcome_occurredAt_id_idx" ON "ActivityLog"("shop", "outcome", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "ActivityLog_shop_importBatchId_occurredAt_idx" ON "ActivityLog"("shop", "importBatchId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityLog_shop_sourceKey_key" ON "ActivityLog"("shop", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "ImportLine_operationId_key" ON "ImportLine"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportLine_idempotencyKey_key" ON "ImportLine"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ImportLine_batchId_status_idx" ON "ImportLine"("batchId", "status");

-- CreateIndex
CREATE INDEX "ImportLine_sku_idx" ON "ImportLine"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "ImportLine_batchId_rowNumber_key" ON "ImportLine"("batchId", "rowNumber");

-- CreateIndex
CREATE INDEX "Shipment_shop_status_createdAt_idx" ON "Shipment"("shop", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Shipment_shop_referenceNormalized_idx" ON "Shipment"("shop", "referenceNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_shop_referenceType_issuerNormalized_referenceNorma_key" ON "Shipment"("shop", "referenceType", "issuerNormalized", "referenceNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_shop_id_key" ON "Shipment"("shop", "id");

-- CreateIndex
CREATE INDEX "ShipmentExpectation_shipmentId_idx" ON "ShipmentExpectation"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentExpectation_shipmentId_sku_key" ON "ShipmentExpectation"("shipmentId", "sku");

-- CreateIndex
CREATE INDEX "ReceivingReceipt_shop_shipmentId_createdAt_idx" ON "ReceivingReceipt"("shop", "shipmentId", "createdAt");

-- CreateIndex
CREATE INDEX "ReceivingReceipt_shop_locationId_idx" ON "ReceivingReceipt"("shop", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivingReceipt_shop_requestId_key" ON "ReceivingReceipt"("shop", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivingReceipt_shop_id_key" ON "ReceivingReceipt"("shop", "id");

-- CreateIndex
CREATE INDEX "ReceivingImportAttempt_shop_shipmentId_createdAt_idx" ON "ReceivingImportAttempt"("shop", "shipmentId", "createdAt");

-- CreateIndex
CREATE INDEX "ReceivingImportAttempt_shop_fileChecksum_mode_idx" ON "ReceivingImportAttempt"("shop", "fileChecksum", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivingImportAttempt_shop_dedupeKey_key" ON "ReceivingImportAttempt"("shop", "dedupeKey");

-- CreateIndex
CREATE INDEX "ReceivingImportRow_attemptId_outcome_idx" ON "ReceivingImportRow"("attemptId", "outcome");

-- CreateIndex
CREATE INDEX "ReceivingImportRow_sku_idx" ON "ReceivingImportRow"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivingImportRow_attemptId_rowNumber_key" ON "ReceivingImportRow"("attemptId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptInspectionLine_sourceRowId_key" ON "ReceiptInspectionLine"("sourceRowId");

-- CreateIndex
CREATE INDEX "ReceiptInspectionLine_shop_receiptId_createdAt_idx" ON "ReceiptInspectionLine"("shop", "receiptId", "createdAt");

-- CreateIndex
CREATE INDEX "ReceiptInspectionLine_receiptId_sku_idx" ON "ReceiptInspectionLine"("receiptId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptInspectionLine_shop_id_key" ON "ReceiptInspectionLine"("shop", "id");

-- CreateIndex
CREATE INDEX "ReceiptInspectionException_shop_receiptId_status_idx" ON "ReceiptInspectionException"("shop", "receiptId", "status");

-- CreateIndex
CREATE INDEX "ReceiptInspectionException_sourceRowId_idx" ON "ReceiptInspectionException"("sourceRowId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptInspectionException_shop_requestId_key" ON "ReceiptInspectionException"("shop", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptInspectionException_receiptId_lineId_type_key" ON "ReceiptInspectionException"("receiptId", "lineId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptInspectionException_receiptId_sourceRowId_type_key" ON "ReceiptInspectionException"("receiptId", "sourceRowId", "type");

-- CreateIndex
CREATE INDEX "ReceiptInventoryOperation_shop_receiptId_status_idx" ON "ReceiptInventoryOperation"("shop", "receiptId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptInventoryOperation_shop_operationKey_key" ON "ReceiptInventoryOperation"("shop", "operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptInventoryOperation_shop_lineId_key" ON "ReceiptInventoryOperation"("shop", "lineId");

-- CreateIndex
CREATE INDEX "ReceivingImportProposalGroup_attemptId_status_idx" ON "ReceivingImportProposalGroup"("attemptId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivingImportProposalGroup_attemptId_groupKey_key" ON "ReceivingImportProposalGroup"("attemptId", "groupKey");

-- CreateIndex
CREATE INDEX "ShipmentEvent_shop_shipmentId_createdAt_idx" ON "ShipmentEvent"("shop", "shipmentId", "createdAt");

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_shop_importBatchId_fkey" FOREIGN KEY ("shop", "importBatchId") REFERENCES "ImportBatch"("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportLine" ADD CONSTRAINT "ImportLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentExpectation" ADD CONSTRAINT "ShipmentExpectation_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingReceipt" ADD CONSTRAINT "ReceivingReceipt_shop_shipmentId_fkey" FOREIGN KEY ("shop", "shipmentId") REFERENCES "Shipment"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingImportAttempt" ADD CONSTRAINT "ReceivingImportAttempt_shop_shipmentId_fkey" FOREIGN KEY ("shop", "shipmentId") REFERENCES "Shipment"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingImportAttempt" ADD CONSTRAINT "ReceivingImportAttempt_shop_receiptId_fkey" FOREIGN KEY ("shop", "receiptId") REFERENCES "ReceivingReceipt"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingImportRow" ADD CONSTRAINT "ReceivingImportRow_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ReceivingImportAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingImportRow" ADD CONSTRAINT "ReceivingImportRow_proposalGroupId_fkey" FOREIGN KEY ("proposalGroupId") REFERENCES "ReceivingImportProposalGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptInspectionLine" ADD CONSTRAINT "ReceiptInspectionLine_shop_receiptId_fkey" FOREIGN KEY ("shop", "receiptId") REFERENCES "ReceivingReceipt"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptInspectionLine" ADD CONSTRAINT "ReceiptInspectionLine_sourceRowId_fkey" FOREIGN KEY ("sourceRowId") REFERENCES "ReceivingImportRow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptInspectionException" ADD CONSTRAINT "ReceiptInspectionException_shop_receiptId_fkey" FOREIGN KEY ("shop", "receiptId") REFERENCES "ReceivingReceipt"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptInspectionException" ADD CONSTRAINT "ReceiptInspectionException_shop_lineId_fkey" FOREIGN KEY ("shop", "lineId") REFERENCES "ReceiptInspectionLine"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptInspectionException" ADD CONSTRAINT "ReceiptInspectionException_sourceRowId_fkey" FOREIGN KEY ("sourceRowId") REFERENCES "ReceivingImportRow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptInventoryOperation" ADD CONSTRAINT "ReceiptInventoryOperation_shop_receiptId_fkey" FOREIGN KEY ("shop", "receiptId") REFERENCES "ReceivingReceipt"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptInventoryOperation" ADD CONSTRAINT "ReceiptInventoryOperation_shop_lineId_fkey" FOREIGN KEY ("shop", "lineId") REFERENCES "ReceiptInspectionLine"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingImportProposalGroup" ADD CONSTRAINT "ReceivingImportProposalGroup_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ReceivingImportAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_shop_shipmentId_fkey" FOREIGN KEY ("shop", "shipmentId") REFERENCES "Shipment"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
