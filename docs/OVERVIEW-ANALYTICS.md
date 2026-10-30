# Overview analytics currency and sample data

The Overview has two separate presentation paths:

- **Sample preview** uses deterministic synthetic sales and inventory fixtures. Its sales amounts are denominated in USD, and the fixture explicitly reports `USD`. USD is a fixed demo presentation for evaluating the dashboard, not a conversion or estimate of the merchant's sales.
- **Live analytics** keeps the currency reported by Shopify's `shopMoney` values and the store's currency code. The UI labels this as the store currency and discloses that no FX conversion is applied. Mixed or incomplete Shopify currency data continues to make revenue unavailable rather than being converted or relabeled.

The USD sample currency is not configurable and does not alter Shopify data, store settings, or the currency used by live analytics. Sample mode uses a synthetic store label and import fixture; aside from the Shopify admin authentication required by the route, it performs no live store, import-history, order, or inventory reads.
