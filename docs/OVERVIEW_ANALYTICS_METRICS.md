# Overview analytics metric contract

This document defines the read-only sales and inventory metrics shown on StockHub Overview. These are Shopify-derived operational summaries, not accounting or settlement reports.

## Authorization and data handling

- Every analytics load asks the authenticated Shopify Admin SDK for its **current granted scopes** (`scopes.query()`); the persisted `Session.scope` value is not used as authorization authority.
- Order analytics are queried only when the live grant includes `read_orders` **and** `read_products`, because top-product and top-variant rankings read the linked Product/Variant identity and title fields. The dashboard uses only the last 7 or 30 days, so it does not request `read_all_orders`.
- Inventory analytics are queried only when the live grant includes `read_products` and `read_inventory`. Shopify 2026-10 documents `Location` as readable with `read_inventory` **or** `read_locations`, so this InventoryLevel-scoped query does not require the additional `read_locations` grant.
- If scope verification fails, neither the Orders nor inventory-analytics query is sent. If a required scope is missing, the relevant panel explains the minimum missing grant instead of showing fabricated zeros.
- Queries select no customer name, contact, address, note, or other customer PII. Raw orders and line items are held only while aggregating the response; the application does not persist them.
- Successful aggregate outputs may be held in a process-local memory cache for up to 60 seconds. Cache keys include authenticated shop, range, current shop-local date, timezone, and currency so a short-lived cache cannot straddle the start of a new local day. Partial or unavailable results are not cached. Nothing is written to the application database.

## Date window

- The selected range is 7 or 30 **shop-local calendar days including today**, using Shopify `shop.ianaTimezone`.
- Shopify order search uses a half-open UTC interval: `created_at >= startUtc` and `created_at < endExclusiveUtc`. Each boundary is the start of the corresponding shop-local calendar date, so daylight-saving transitions can produce 23- or 25-hour days without shifting the calendar buckets.
- Daily trend buckets use the order's `createdAt` converted back to the same shop timezone.
- Orders are limited to their created date; an order edited later remains assigned to its original day.

## Orders, units and merchandise value

- **Orders** counts unique, non-cancelled, non-test orders created in the selected window. Orders are counted regardless of payment/financial status; this count is order volume, not paid-order or cash-settlement volume.
- Orders with `cancelledAt` set are excluded even if they were created during the selected window. Shopify's `Order.test` flag is required: `test: true` is excluded, and a missing/invalid test flag is excluded and makes the result partial rather than being treated as a real sale.
- **Units sold** is the sum of each line's Shopify `currentQuantity`. Shopify defines this as current quantity after returned/refunded/removed units are excluded. Cancelled and test orders do not contribute.
- **Net merchandise sales** sums `LineItem.priceAfterAllDiscountsBeforeTaxesSet.shopMoney.amount`. Shopify defines this as the line total after discounts and excluding refunded/removed quantities, and before tax. It is not gross sales, net revenue, a payment-settlement total, or an amount including tax/shipping. Orders are not filtered by financial status, so merchants should interpret this as current merchandise value represented by eligible order lines, not cash received.
- Amounts are aggregated only in the shop currency (`shop.currencyCode`). If any returned line has a different shop-money currency, revenue is reported unavailable for the whole selected period; order and unit counts remain visible, with a partial-data explanation. No FX conversion or mixed-currency summing occurs.
- Orders are de-duplicated by Shopify order ID, and line items by order/line-item ID. A missing ID is excluded from totals and makes the result partial because reliable de-duplication is impossible.
- Top products and variants are ranked by positive net `currentQuantity`, descending, with stable title/ID tie-breaks. Fully refunded or removed products/variants with zero current quantity are not ranked. A line with no product/variant identity still contributes to aggregate orders, units and revenue, but not a product/variant ranking.

## Inventory health

- The dashboard reads `available` quantities on inventory levels for product variants. An inventory level is included only when both `InventoryLevel.isActive` and its `Location.isActive` are true.
- Quantities from active stocked locations are summed per variant. Variants that have no active level, a missing `available` value, an untracked item, or an incomplete location connection are **unknown/untracked**, never assumed to have zero stock.
- **Low stock** is a unique, nonempty SKU whose combined known available quantity across all variants sharing that SKU is greater than zero and less than or equal to **5**.
- **Out of stock** is a unique, nonempty SKU whose combined known available quantity across all variants sharing that SKU is **0 or below**.
- If any variant sharing a SKU is unknown, untracked, or incompletely read, the SKU is left unclassified rather than being classified from only the known variants. Variants without an SKU can appear in variant-level detail but do not contribute to the SKU counts.
- Unknown and untracked counts are variant counts, not SKU counts. In partial responses, low/out-of-stock totals are presented as “at least” because unreturned variants may change them.

## Empty, partial and unavailable states

- A successful read with no eligible orders is a verified zero for orders and units; the chart explains that there were no non-cancelled, non-test orders in the selected period.
- Missing scopes produce `permission_required`; a failed live-scope query produces `unverified` and prevents analytics API calls.
- A first-page Shopify error produces `unavailable`. If one or more pages were read before a later API error or safety cap, the available aggregates are `partial`, with an explanation; partial results are never cached as successful data.
- Mixed shop currencies make revenue unavailable without discarding order/unit values. Incomplete inventory levels are excluded from low/out-of-stock classification and counted as unknown.

## Shopify API references

- [Order and line-item fields (Admin GraphQL 2026-10)](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Order)
- [LineItem discounted pre-tax value and quantity fields](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/LineItem)
- [Order pagination query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/orders)
- [InventoryLevel and active state](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/InventoryLevel)
- [Location active state and accepted scopes](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Location)
- [Shop timezone and currency](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Shop)
- [GraphQL cursor pagination](https://shopify.dev/docs/api/usage/pagination-graphql)
