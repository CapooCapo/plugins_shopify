-- Tenant-scoped canonical Size Guide data and retryable Shopify projection state.
CREATE TABLE "SizeGuide" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "columnsJson" JSONB NOT NULL,
    "rowsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SizeGuide_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SizeGuide_shop_id_key" UNIQUE ("shop", "id"),
    CONSTRAINT "SizeGuide_unit_check" CHECK ("unit" IN ('cm', 'in', 'mm'))
);

CREATE INDEX "SizeGuide_shop_updatedAt_idx" ON "SizeGuide"("shop", "updatedAt" DESC);

CREATE TABLE "SizeGuideProduct" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncedGuideUpdatedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SizeGuideProduct_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SizeGuideProduct_shop_id_key" UNIQUE ("shop", "id"),
    CONSTRAINT "SizeGuideProduct_shop_productId_key" UNIQUE ("shop", "productId"),
    CONSTRAINT "SizeGuideProduct_productId_check" CHECK ("productId" LIKE 'gid://shopify/Product/%'),
    CONSTRAINT "SizeGuideProduct_syncStatus_check" CHECK ("syncStatus" IN ('PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'REMOVE_WAITING_SYNC', 'REMOVE_PENDING', 'REMOVE_FAILED')),
    CONSTRAINT "SizeGuideProduct_guide_fkey" FOREIGN KEY ("shop", "guideId")
      REFERENCES "SizeGuide"("shop", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "SizeGuideProduct_shop_guideId_idx" ON "SizeGuideProduct"("shop", "guideId");
CREATE INDEX "SizeGuideProduct_shop_syncStatus_idx" ON "SizeGuideProduct"("shop", "syncStatus");
