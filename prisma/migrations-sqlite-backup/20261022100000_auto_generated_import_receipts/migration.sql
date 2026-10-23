-- Preserve existing receipt references as historical receipt codes.
ALTER TABLE "ImportBatch" RENAME COLUMN "receiptKey" TO "receiptCode";
ALTER TABLE "ImportBatch" ADD COLUMN "submissionId" TEXT;

DROP INDEX "ImportBatch_shop_receiptKey_key";
CREATE UNIQUE INDEX "ImportBatch_shop_receiptCode_key" ON "ImportBatch"("shop", "receiptCode");
CREATE UNIQUE INDEX "ImportBatch_shop_submissionId_key" ON "ImportBatch"("shop", "submissionId");

-- Monotonic receipt numbering is scoped to an authenticated shop and UTC day.
CREATE TABLE "ImportReceiptCounter" (
    "shop" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "lastSequence" INTEGER NOT NULL,
    PRIMARY KEY ("shop", "dateKey")
);

-- If historical references already use the generated format, continue above
-- their largest suffix rather than colliding with an existing receipt.
INSERT INTO "ImportReceiptCounter" ("shop", "dateKey", "lastSequence")
SELECT
    "shop",
    substr("receiptCode", 5, 8),
    MAX(CAST(substr("receiptCode", 14, 6) AS INTEGER))
FROM "ImportBatch"
WHERE length("receiptCode") = 19
  AND substr("receiptCode", 1, 4) = 'IMP-'
  AND substr("receiptCode", 13, 1) = '-'
  AND substr("receiptCode", 5, 8) NOT GLOB '*[^0-9]*'
  AND substr("receiptCode", 14, 6) NOT GLOB '*[^0-9]*'
GROUP BY "shop", substr("receiptCode", 5, 8)
HAVING MAX(CAST(substr("receiptCode", 14, 6) AS INTEGER)) > 0;
