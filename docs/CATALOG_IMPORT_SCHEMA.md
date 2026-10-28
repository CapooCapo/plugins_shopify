# Catalog import schema (PR-02)

The catalog CSV draft flow is intentionally separate from inventory imports. It does not use `ImportBatch`, `ImportLine`, inventory merge, or Shopify product/inventory APIs. The exact UTF-8 CSV text (including a possible BOM) is retained; source headers and positional values retain their source text, while the BOM is hidden only in the mapping UI label.

`CatalogImportBatch` stores the authenticated shop, submission ID, filename, SHA-256 checksum, exact decoded UTF-8 CSV text, positional source headers, confirmed mapping, workflow status, timestamps, and optimistic `draftVersion`. Original CSV is retained until the merchant deletes the draft. This PR has no background retention cleanup.

`CatalogImportLine` stores a stable row ID, shop and batch identity, display order, original source-row number (null for manual rows), positional raw source values, canonical normalized fields, validation errors/status, and decimal `price` (`DECIMAL(20,6)`). Accepted values are bounded to 14 integer and 6 fractional digits. Missing price stays null. Zero requires an explicit per-row confirmation. Quantity and Shopify product identifiers are deliberately absent.

The additive migration adds only these two tables, their shop-scoped uniqueness/indexes, and a composite `(shop, batchId) -> (shop, id)` cascade foreign key. It has been generated at `prisma/migrations/20261027000000_catalog_import/migration.sql` and **has not been applied**. Review and apply it only to an isolated local database after review; never apply it to production/staging as part of this PR.

CSV upload is limited to 1,000,000 UTF-8 bytes and 1,000 data rows. Draft deletion cascades to its lines; no cleanup job or auto-expiration is introduced.
