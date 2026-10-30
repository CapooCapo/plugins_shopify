# Inventory Alerts

Inventory Alerts is the active, read-only variant inventory view at `/app/inventory-alerts`. The retired `/app/restock` route redirects there and displays a migration notice. This feature reports stock status only; it does not create purchase quantities, supplier actions, or inventory changes.

## Rows and locations

Each row represents a Shopify variant, not a SKU group. Product ID, variant ID, and inventory-item ID are distinct identities; duplicate SKUs remain separate variant rows. Available quantity is summed across eligible active locations: both the inventory level and its location must be active. The displayed scope is **All eligible active locations**.

Status thresholds apply only to tracked variants with complete inventory data:

- **Out of stock:** available quantity is 0 or less.
- **Low stock:** available quantity is 1–4.
- **In stock:** available quantity is 5 or more.
- **Untracked:** Shopify confirms the inventory item is not tracked.
- **Unknown:** tracking, identity, or a usable active-location quantity is unavailable. No active levels remain unknown, not zero.
- **Partial data:** tracked inventory-location data is incomplete; observed values are not treated as complete totals.

Unknown, untracked, and partial rows are not exported as alerts. A live export is blocked when catalog pagination is incomplete or any row has incomplete identity/location data, except an affirmatively untracked row.

## Filters, pages, and CSV

Search matches product and Shopify IDs, SKU, product type, and option values. Status, product type, color, and size filters compose. Pagination applies after filtering; CSV export uses all matching pages, not just the visible page, and includes only out-of-stock and low-stock variants. The CSV includes location scope, read timestamp, and a `data_source` field (`LIVE` or `SAMPLE`).

## Sample preview and live access

Choose **Preview sample data** to view isolated demo rows (`?sample=1`). It reads the local fixture rather than Shopify inventory and does not alter store data. Downloaded demo CSVs are marked `SAMPLE` and use a sample-prefixed filename.

Live inventory requires the current grant to include `read_products`, `read_inventory`, and `read_locations`. If a scope is missing, the page reports the missing permission and sends no inventory query. In particular, `read_locations` is required because the inventory read uses location identity and active status.

## Implementation references

- [Inventory Alerts route](../app/routes/app.inventory-alerts.tsx)
- [Retired Restock redirect](../app/routes/app.restock.tsx)
- [Inventory reader and grant check](../app/utils/inventory-alerts.server.ts)
- [Statuses, filtering, and export rules](../app/utils/inventory-alerts.shared.ts)
- [Isolated sample fixture](../app/utils/inventory-alerts-fixtures.ts)
