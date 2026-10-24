# Actual-component visual harness

This fixture mounts the production `OverviewDashboard` and `ProductsCatalog` React components
under their route's actual `<s-page inlineSize="large">` wrapper. It imports `app/styles/stockhub.css` and loads
a local snapshot of the same Polaris web-components CDN script used by AppProvider.
It does **not** authenticate with Shopify, fetch merchant data, or test the live Admin iframe.

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
```

`capture.mjs` writes PNGs and JSON measurements to `screenshots/` and asserts the key
Overview and Products layout contracts. Products checks include collapsed row density,
SKU identity, pagination URLs, honest inventory values, and Details expand/collapse.
The `receipt-actions` check inspects Polaris custom-element registration, host and
shadow-button geometry, ancestor visibility/clipping, and the React Router form's
cancel-versus-confirm submission behavior at desktop and mobile widths. The host
uses `display: contents`, so inspect the shadow button's rectangle rather than the
zero-sized custom-element host rectangle.
Inspect the PNGs visually as well; geometry checks alone cannot
judge hierarchy or readability. `polaris.js` was fetched from
`https://cdn.shopify.com/shopifycloud/polaris.js` for offline/reliable local rendering.
