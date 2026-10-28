-- Keep a stable logical review identity while allowing one retained operation
-- for each saved review version. Execution history must not follow a review ID
-- change to a replacement snapshot.
DROP INDEX IF EXISTS "CatalogExecutionOperation_shop_reviewId_key";
CREATE UNIQUE INDEX "CatalogExecutionOperation_shop_reviewId_reviewVersion_key"
    ON "CatalogExecutionOperation"("shop", "reviewId", "reviewVersion");

ALTER TABLE "CatalogExecutionOperation"
    DROP CONSTRAINT "CatalogExecutionOperation_review_fkey";
ALTER TABLE "CatalogExecutionOperation"
    ADD CONSTRAINT "CatalogExecutionOperation_review_fkey"
    FOREIGN KEY ("shop", "batchId", "groupId", "reviewId")
    REFERENCES "CatalogImportReview"("shop", "batchId", "groupId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The logical review ID now stays stable between versions, so each archived
-- version is identified by that logical ID plus its review version.
ALTER TABLE "CatalogImportReviewHistory"
    DROP CONSTRAINT "CatalogImportReviewHistory_pkey";
ALTER TABLE "CatalogImportReviewHistory"
    ADD CONSTRAINT "CatalogImportReviewHistory_pkey"
    PRIMARY KEY ("id", "reviewVersion");
