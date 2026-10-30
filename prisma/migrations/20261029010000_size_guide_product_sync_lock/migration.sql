-- Cross-instance publish/cleanup fencing. Rows survive assignment deletion so
-- a stale Shopify mutation can be reconciled before a product is reassigned.
CREATE TABLE "SizeGuideProductSyncLock" (
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "cleanupGeneration" BIGINT NOT NULL DEFAULT 0,
    "cleanupPending" BOOLEAN NOT NULL DEFAULT FALSE,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SizeGuideProductSyncLock_pkey" PRIMARY KEY ("shop", "productId"),
    CONSTRAINT "SizeGuideProductSyncLock_productId_check" CHECK ("productId" LIKE 'gid://shopify/Product/%'),
    CONSTRAINT "SizeGuideProductSyncLock_state_check" CHECK ("state" IN ('PUBLISHING', 'CLEANUP'))
);

CREATE INDEX "SizeGuideProductSyncLock_shop_leaseUntil_idx"
  ON "SizeGuideProductSyncLock"("shop", "leaseUntil");
