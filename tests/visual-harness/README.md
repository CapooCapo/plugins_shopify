# Actual-component visual harness

This fixture mounts the production `OverviewDashboard`, `ProductsCatalog`, and
`ImportBatchDetail` React components under their actual `<s-page inlineSize="large">` wrapper. It imports `app/styles/stockhub.css` and loads
a local snapshot of the same Polaris web-components CDN script used by AppProvider.
It does **not** authenticate with Shopify, fetch merchant data, or test the live Admin iframe.

The Overview case passes deterministic local sales/inventory fixtures into the production
component. Its ready state and missing-`read_orders` state are labeled **LOCAL FIXTURE ·
NOT LIVE SHOPIFY ADMIN DATA** in the captured page. The harness checks the 7/30-day range
selector, ready metrics, the honest missing-scope placeholders/message, preserved inventory
visibility, and horizontal overflow at both desktop and mobile widths. These captures are
component-layout evidence only, not Shopify integration or merchant acceptance evidence.

To capture at 1280×900 and mobile-emulated 390×900, run in separate terminals from the
repository root:

```sh
./node_modules/.bin/vite --config tests/visual-harness/vite.config.ts
google-chrome-stable --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-port=9223 --user-data-dir=/tmp/stockhub-chrome-visual about:blank
node tests/visual-harness/capture.mjs overview
node tests/visual-harness/capture.mjs products
node tests/visual-harness/capture.mjs products-sku
node tests/visual-harness/capture.mjs receipt-actions
node tests/visual-harness/capture.mjs receipt-detail
```

Set `VISUAL_OUTPUT_DIR=/tmp/stockhub-visual-check` before capture commands to write
artifacts outside the repository and avoid replacing existing screenshots. For Overview,
the harness writes ready-fixture and missing-scope-fixture PNG/JSON pairs plus a JSON range
selector interaction record for each viewport.

`capture.mjs` writes PNGs and JSON measurements to `screenshots/` and asserts the key
Overview and Products layout contracts. Products checks include collapsed row density,
SKU identity, pagination URLs, honest inventory values, and Details expand/collapse.
The `receipt-actions` check captures the zero-eligible terminal state at desktop and
mobile widths, verifies that no Merge/Resume bar or warning is rendered while
read-only Shopify verification remains available, then switches to an eligible
fixture to check cancel-versus-confirm form behavior. This is a local component
fixture, not authenticated Shopify Admin acceptance.
The `receipt-detail` check mounts the production receipt route with a deterministic
in-memory loader/action (no Shopify or database access), then exercises its quality
filters, grouped issue action, search/type filters, sorting, row drawer, Add/revalidate
availability, eligible merge confirmation fields, and zero-eligible guidance. It records
desktop semantic-table and mobile-card layout measurements at 1280×900 and 390×900.
The fixture action captures form fields locally and does not submit Shopify writes.
Inspect the PNGs visually as well; geometry checks alone cannot
judge hierarchy or readability. `polaris.js` was fetched from
`https://cdn.shopify.com/shopifycloud/polaris.js` for offline/reliable local rendering.
