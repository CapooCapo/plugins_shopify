# Catalog Draft Quality Contract

Catalog quality is derived from the current draft rows and active groups at read time. It is not persisted and is not a Shopify execution decision. Group confirmation remains an independent merchant review state; accepting a group does not override a quality issue.

## Severity and counts

- `ERROR`: missing Product Name or SKU, malformed source row, invalid/negative price, duplicate batch SKU, product-level conflict, or invalid variant option configuration.
- `WARNING`: missing price, unconfirmed intentional-zero candidate, and optionally missing image URL (`?warnMissingImage=1`). Missing price remains ineligible for future product creation; an update may preserve an existing Shopify price.
- `READY`: no errors or warnings.
- Ready/Warning/Error counts count rows by their highest severity. Group state inherits the highest severity of its member rows and its group-level validation issues.
- `totalIssues` counts structured actionable occurrences. A duplicate SKU is one issue per affected row and is not counted a second time from the legacy group validator. Group summaries reference those same row issues rather than duplicating them globally.

Price uses decimal-safe text validation (up to 14 integer digits and 6 fractional digits); missing is never converted to zero. Zero is Warning until explicitly confirmed.

Current catalog option inputs are Size and Color. The validator enforces Shopify's maximum of three option dimensions and 2,048 variants per product; the four-option dimension check is forward-compatible because the current draft contract only exposes two dimensions. Sources: [Shopify variant limit changelog](https://shopify.dev/changelog/posts/the-product-variant-limit-is-now-2048-for-all-merchants) and [Shopify variant merchandising docs](https://shopify.dev/docs/storefronts/themes/product-merchandising/variants).

No schema changes or migrations are required for this derived quality slice.
