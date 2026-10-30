# Actual-component visual harness

The fixture mounts production Overview, Products, and import React surfaces under
`<s-page inlineSize="large">`, imports `app/styles/stockhub.css`, and loads the
local Polaris web-components snapshot. It does not authenticate with Shopify,
fetch merchant data, or test the live Admin iframe.

## Overview V2

`capture-overview-v2.mjs` mounts deterministic local fixtures and captures the
production light dashboard at 390, 768, 1001, 1280, and 1440 pixels. It records
full-page
PNG/JSON pairs and checks the approved hierarchy (KPIs → shared Sales Performance
and Best Sellers analysis row → Inventory Attention → Recent Imports), no
horizontal overflow, 65–70% chart / 30–35% ranking desktop proportions, stacked
panels at narrow widths, the named Product/Variant button group, native-button
focusability and both ranking selections, chart plot height (300px desktop /
220px mobile), preservation of sample mode across range changes, the three-row
Inventory Attention limit, gift-card exclusion, sample USD versus live local-
fixture CAD/no-FX wording, ready, blocked, ready-empty, and partial analytics
states (including retained partial rows), import lifecycle labels, and distinct
inventory-receipt versus catalog-draft links. Ranking activation uses DOM
`button.click()`; the harness does not simulate trusted keyboard input. Run it with
`node tests/visual-harness/capture-overview-v2.mjs` after
starting the Vite fixture server and Chrome DevTools below.

The existing `overview-1280.png` and `overview-390.png` files are the before
redesign baseline. The V2 runner writes `overview-v2-<width>.png` and matching
viewport metrics, plus JSON state evidence for the local ready, blocked,
ready-empty, and partial fixtures. Screenshots cover 390, 768, 1001, 1280, and
1440px. The 1001px boundary checks the shared desktop row against the 65–70%
chart-share requirement; widths at or below the 1000px stack breakpoint retain
the one-column assertion.
Set `VISUAL_OUTPUT_DIR=/tmp/stockhub-visual-check` to keep new artifacts outside
the repository.

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
