CREATE TABLE "Shipment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "referenceType" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "referenceNormalized" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "issuerNormalized" TEXT NOT NULL,
  "notes" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "closedAt" DATETIME
);

CREATE UNIQUE INDEX "Shipment_shop_referenceType_issuerNormalized_referenceNormalized_key"
ON "Shipment"("shop", "referenceType", "issuerNormalized", "referenceNormalized");
CREATE UNIQUE INDEX "Shipment_shop_id_key" ON "Shipment"("shop", "id");
CREATE INDEX "Shipment_shop_status_createdAt_idx" ON "Shipment"("shop", "status", "createdAt");
CREATE INDEX "Shipment_shop_referenceNormalized_idx" ON "Shipment"("shop", "referenceNormalized");

CREATE TABLE "ShipmentExpectation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shipmentId" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "expectedQty" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipmentExpectation_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ShipmentExpectation_shipmentId_sku_key" ON "ShipmentExpectation"("shipmentId", "sku");
CREATE INDEX "ShipmentExpectation_shipmentId_idx" ON "ShipmentExpectation"("shipmentId");

CREATE TABLE "ReceivingReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "shipmentId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "locationName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ReceivingReceipt_shop_shipmentId_fkey" FOREIGN KEY ("shop", "shipmentId") REFERENCES "Shipment" ("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReceivingReceipt_shop_requestId_key" ON "ReceivingReceipt"("shop", "requestId");
CREATE INDEX "ReceivingReceipt_shop_shipmentId_createdAt_idx" ON "ReceivingReceipt"("shop", "shipmentId", "createdAt");
CREATE INDEX "ReceivingReceipt_shop_locationId_idx" ON "ReceivingReceipt"("shop", "locationId");

CREATE TABLE "ShipmentEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "shipmentId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "reason" TEXT,
  "metadata" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipmentEvent_shop_shipmentId_fkey" FOREIGN KEY ("shop", "shipmentId") REFERENCES "Shipment" ("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ShipmentEvent_shop_shipmentId_createdAt_idx" ON "ShipmentEvent"("shop", "shipmentId", "createdAt");
