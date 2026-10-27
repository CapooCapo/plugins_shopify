# Catalog Product Grouping Contract (PR-03)

This feature proposes product/variant groups inside a Catalog Import Draft only. It does not create Shopify Products or Variants, modify inventory, or call the inventory Merge service.

## Suggestions and normalization

- Normalize grouping values with Unicode NFKC, trim leading/trailing whitespace, collapse internal whitespace, and lowercase.
- Preserve accents and punctuation; `"Áo  Dài"` becomes `"áo dài"`, not an unaccented/transliterated key.
- A nonblank Product Group Code is the primary suggestion key. Without one, normalized Product Name is used. These key spaces remain distinct.
- A blank Product Name is isolated as an invalid proposal rather than grouped with other blank names.
- SKU is never used to infer Product Group Code, Size, or Color.
- Every proposal is persisted unconfirmed. Merchant acceptance is explicit.
- Grouping is scoped to `(shop, batchId)`; the database membership foreign key repeats both scope columns.

## Variant and conflict validation

- One row is a valid single-variant proposal without Size or Color.
- Multiple rows require distinct options. Available dimensions are Size, Color, or Size × Color. Once a dimension is used in the proposal, every member needs a value for that dimension.
- Duplicate SKU comparison uses normalized SKU within one batch. Duplicate option combinations use normalized option values within a proposed group.
- Product Name, Vendor, Product Type, Description, and Image URL are product-level fields. Nonblank disagreements require selecting a value from a source row; no source value is silently preferred when a conflict exists.
- Duplicate SKU, repeated option combinations, missing option values, invalid rows, or changed grouping keys block acceptance and identify affected rows.
- A row edit, group merge, group split, or field resolution advances the batch draft version and clears affected group confirmations. Original CSV, row identifiers, source row numbers, and source values remain unchanged.

## Persistence proposal — review only

`CatalogImportGroup` stores stable IDs, grouping source/key/reason, selected product fields with source-row IDs, validation, confirmation timestamp, and active/superseded state. `CatalogImportLine.groupId` is nullable for older drafts and unassigned rows. A composite `(shop,batchId,groupId)` foreign key prevents cross-shop or cross-batch membership.

The additive SQL proposal is `prisma/migrations/20261028000000_catalog_grouping/migration.sql`. It is intentionally unapplied. The line-to-group FK uses `NO ACTION`: removing an individual group with members is blocked, while deleting a batch can cascade-delete its lines and groups together. The route never deletes groups; it marks them superseded and moves members first. Do not run migrations or database schema changes until the schema and SQL receive explicit review approval.
