# Actual-component visual harness

The fixture mounts production Overview, Products, and import React surfaces under
`<s-page inlineSize="large">`, imports `app/styles/stockhub.css`, and loads the
local Polaris web-components snapshot. It does not authenticate with Shopify,
fetch merchant data, or test the live Admin iframe.

## Overview V2

`capture-overview-v2.mjs` mounts deterministic local fixtures and captures the
production light dashboard at 390, 768, 1280, and 1440 pixels. It records full-page
PNG/JSON pairs and checks the approved section order, no horizontal overflow,
KPI row behavior, the Product/Variant switch, preservation of sample mode across
range changes, the three-row Inventory Attention limit, gift-card exclusion,
import lifecycle labels, and distinct inventory-receipt versus catalog-draft
links. Run it with `node tests/visual-harness/capture-overview-v2.mjs` after
starting the Vite fixture server and Chrome DevTools below.

The existing `overview-1280.png` and `overview-390.png` files are the before
redesign baseline. The V2 runner writes `overview-v2-<width>.png` and matching
viewport metrics. Set `VISUAL_OUTPUT_DIR=/tmp/stockhub-visual-check` to keep new
artifacts outside the repository.

## Starting the fixture

From the repository root, run these in separate terminals:

```sh
./node_modules/.bin/vite --config tests/visual-harness/vite.config.ts
google-chrome-stable --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-port=9223 --user-data-dir=/tmp/stockhub-chrome-visual about:blank
```

The legacy `capture.mjs` retains Products, receipt-action, receipt-detail, and
Catalog interaction scenarios. Products checks include row density, SKU identity,
pagination URLs, inventory values, and Details expand/collapse. Receipt scenarios
exercise local fixture actions only; they do not submit Shopify writes. Catalog
checks cover mapping validation, preview, quality filters, grouping, and mobile
cards. Inspect screenshots visually as well as reviewing geometry metrics.
