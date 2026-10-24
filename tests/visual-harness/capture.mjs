import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const pageName = process.argv[2] ?? "overview";
assert.ok(["overview", "products", "products-sku", "new-import", "receipt-actions"].includes(pageName), "visual page must be overview, products, products-sku, new-import, or receipt-actions");

const pages = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = pages.find((item) => item.type === "page");
if (!page) throw new Error("No Chrome DevTools page available");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.error) item.reject(new Error(JSON.stringify(message.error)));
  else item.resolve(message.result);
});
function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const failures = [];
for (const width of [1280, 390]) {
  await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
  const view = pageName === "products-sku" ? "products&mode=sku" : pageName;
  await command("Page.navigate", { url: `http://127.0.0.1:4179/?page=${view}` });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const result = await command("Runtime.evaluate", {
    expression: `({ ready: document.body.dataset.visualReady, metrics: document.getElementById('visual-metrics')?.textContent, body: document.body.innerText, errors: document.querySelector('vite-error-overlay')?.shadowRoot?.innerText })`,
    returnByValue: true,
  });
  const metrics = result.result.value;
  await writeFile(new URL(`./screenshots/${pageName}-${width}.json`, import.meta.url), JSON.stringify(metrics, null, 2));
  const shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(new URL(`./screenshots/${pageName}-${width}.png`, import.meta.url), Buffer.from(shot.data, "base64"));
  let interaction = null;
  if (pageName.startsWith("products")) {
    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-product-row button[aria-expanded="false"]')?.click()` });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expanded = await command("Runtime.evaluate", {
      expression: `({ count: document.querySelectorAll('.stockhub-product-detail-row').length,
        text: document.querySelector('.stockhub-product-detail-row')?.textContent,
        ariaExpanded: document.querySelector('.stockhub-product-row button')?.getAttribute('aria-expanded') })`,
      returnByValue: true,
    });
    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-product-row button[aria-expanded="true"]')?.click()` });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const collapsed = await command("Runtime.evaluate", {
      expression: `({ count: document.querySelectorAll('.stockhub-product-detail-row').length,
        ariaExpanded: document.querySelector('.stockhub-product-row button')?.getAttribute('aria-expanded') })`,
      returnByValue: true,
    });
    interaction = { expanded: expanded.result.value, collapsed: collapsed.result.value };
    await writeFile(new URL(`./screenshots/${pageName}-${width}-interaction.json`, import.meta.url), JSON.stringify(interaction, null, 2));
  }
  if (pageName === "receipt-actions") {
    const rejected = await command("Runtime.evaluate", {
      expression: `(async () => {
        window.confirm = () => false;
        document.querySelector('.stockhub-merge-action s-button')?.shadowRoot?.querySelector('button')?.click();
        await new Promise((resolve) => setTimeout(resolve, 150));
        return document.querySelector('.receipt-action-result')?.textContent ?? null;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(rejected.result.value, null, "canceling the confirmation must not submit the Merge form");

    const accepted = await command("Runtime.evaluate", {
      expression: `(async () => {
        window.confirm = () => true;
        document.querySelector('.stockhub-merge-action s-button')?.shadowRoot?.querySelector('button')?.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        return document.querySelector('.receipt-action-result')?.textContent ?? null;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    interaction = { canceledSubmission: rejected.result.value, confirmedSubmission: accepted.result.value };
    assert.equal(interaction.confirmedSubmission, JSON.stringify({ intent: "merge", batchId: "fixture-batch-001", confirmed: "yes" }), "explicit confirmation must submit the original React Router Form fields");
    await writeFile(new URL(`./screenshots/${pageName}-${width}-interaction.json`, import.meta.url), JSON.stringify(interaction, null, 2));
  }
  console.log(width, JSON.stringify(metrics));
  try {
  assert.equal(metrics.ready, "true", "React route presentation must finish rendering");
  assert.equal(metrics.errors, undefined, "Vite must not report a rendering error");
  const layout = JSON.parse(metrics.metrics);
  assert.equal(layout.viewport.width, width);
  assert.ok(layout.documentWidth <= width, "page must not overflow horizontally");
  if (pageName === "overview") {
  assert.match(metrics.body, /Needs attention\n3\nFailed or uncertain imports/);
  assert.match(metrics.body, /Outcome uncertain/);
  assert.equal(layout.primaryActionCount, 1);
  assert.equal(layout.quickActionLinkCount, 3);
  assert.equal(layout.polarisPageDefined, true);
  assert.equal(layout.polarisButtonDefined, true);
  assert.equal(layout.cards.length, 3);
  assert.ok(layout.cards.every((card) => card.height >= 110 && card.height <= 140), "KPI height contract");
  if (width === 1280) {
    assert.ok(layout.cards.every((card) => card.y === layout.cards[0].y), "KPI cards must share a desktop row");
    assert.ok(layout.content.width >= 1200, "desktop content should use the embedded width");
    assert.ok(layout.recentImports.y < 900, "recent imports should begin within first viewport");
  } else {
    assert.ok(layout.cards[0].y < layout.cards[1].y && layout.cards[1].y < layout.cards[2].y,
      "KPI cards must stack on mobile");
  }
  }
  if (pageName === "receipt-actions") {
    assert.equal(layout.receiptActions.summary.caption, "Import progress summary");
    assert.equal(layout.receiptActions.summary.rowCount, 7, "all persisted receipt summary metrics must render as table rows");
    assert.ok(layout.receiptActions.summary.width - layout.receiptActions.summary.scrollWidth <= 2,
      "receipt summary table must fit its container at desktop and mobile widths");
    assert.ok(layout.receiptActions.summary.tones.includes("stockhub-receipt-summary-count--success"));
    assert.ok(layout.receiptActions.summary.tones.includes("stockhub-receipt-summary-count--neutral"));
    assert.ok(!layout.receiptActions.summary.tones.some((tone) => tone.endsWith("--warning") || tone.endsWith("--error")),
      "zero problem counts must not look like warnings or errors");
    assert.equal(layout.polarisButtonDefined, true, "Polaris s-button must be registered");
    assert.ok(layout.receiptActions.searchFieldRect, "line-item search field must be rendered");
    assert.ok(layout.receiptActions.searchFieldRect.bottom < layout.receiptActions.shadowButton.rect.y,
      "primary Merge action must appear below Search line items");
    assert.equal(layout.receiptActions.variant, "primary", "Merge action must use the primary Polaris variant");
    assert.equal(layout.receiptActions.customElementDefined, true);
    assert.equal(layout.receiptActions.searchLabel, "Search line items", "line-item search control must be rendered");
    assert.equal(layout.receiptActions.host.display, "contents", "Polaris button hosts intentionally use display: contents");
    assert.equal(layout.receiptActions.host.clientRectCount, 0, "the custom-element host itself has no layout box");
    assert.ok(layout.receiptActions.shadowButton.rect.width > 0 && layout.receiptActions.shadowButton.rect.height > 0, "the internal Polaris button must have visible geometry");
    assert.equal(layout.receiptActions.shadowButton.visibility, "visible");
    assert.equal(layout.receiptActions.shadowButton.opacity, "1");
    assert.ok(layout.receiptActions.shadowButton.rect.x >= 0 && layout.receiptActions.shadowButton.rect.y >= 0,
      "the internal Polaris button must not be positioned above or left of the viewport");
    assert.ok(layout.receiptActions.shadowButton.rect.right <= width && layout.receiptActions.shadowButton.rect.bottom <= 900,
      "the internal Polaris button must fit inside the viewport");
    assert.ok(layout.receiptActions.ancestors.every((ancestor) => ancestor.display !== "none"
      && ancestor.visibility === "visible" && ancestor.opacity !== "0"
      && ![ancestor.overflowX, ancestor.overflowY].some((overflow) => ["hidden", "clip"].includes(overflow))),
    "no ancestor may hide or clip the Merge action");
    assert.match(metrics.body, /Merge eligible lines/, "the Merge label must be exposed in the rendered page");
    assert.equal(interaction.confirmedSubmission, JSON.stringify({ intent: "merge", batchId: "fixture-batch-001", confirmed: "yes" }));
  }
  if (pageName.startsWith("products")) {
    const catalog = layout.products;
    assert.deepEqual(catalog.columns,
      ["Product", "SKU / variants", "Status", "Price", "Total inventory", "Actions"]);
    assert.equal(catalog.rows.length, pageName === "products-sku" ? 1 : 8);
    assert.equal(catalog.expandedDetailRows, 0, "variant details should be collapsed initially");
    assert.equal(interaction.expanded.count, 1, "Details button must reveal one row");
    assert.equal(interaction.expanded.ariaExpanded, "true");
    assert.match(interaction.expanded.text, /SKU:/);
    assert.equal(interaction.collapsed.count, 0, "Hide details must collapse it again");
    assert.equal(interaction.collapsed.ariaExpanded, "false");
    assert.ok(catalog.rows.every((row) => row.actionLinks === 1), "Shopify action must stay in the product row");
    assert.ok(catalog.rows.every((row) => row.fullTitle), "truncated titles must retain full text");
    assert.equal(catalog.paginationHrefs.length, 2);
    if (pageName === "products-sku") {
      assert.equal(catalog.skuCells[0], "MATCH-204", "SKU search must display matched variant");
      assert.ok(catalog.paginationHrefs.every((href) => href.includes("q=MATCH-204") && href.includes("searchBy=sku")));
    } else {
      assert.equal(catalog.inventoryCells[0], "Unavailable", "unknown inventory must not be zero");
      assert.equal(catalog.inventoryCells[4], "0", "actual zero inventory must remain zero");
    }
    if (width === 1280) {
      assert.ok(catalog.content.width >= 1200, "catalog should use embedded desktop width");
      assert.ok(catalog.filterForm.height <= 120, "desktop filters should be compact");
      assert.ok(catalog.rows.every((row) => row.height <= 72), "collapsed desktop rows should be dense");
    } else {
      assert.ok(catalog.rows.every((row) => row.actionTargetHeights.every((height) => height >= 36)),
        "mobile action targets should be at least 36px high");
      }
    }
    if (pageName === "new-import") {
      const imp = layout.newImport;
      assert.ok(imp.header, "new-import header exists");
      assert.ok(imp.stepper, "workflow stepper exists");
      assert.ok(imp.dropzone, "dropzone upload area exists");
      assert.equal(imp.fileInput, true, "file input exists");
      assert.equal(imp.locationSelect, true, "location select exists");
      assert.equal(imp.validateButton, true, "validate CTA button exists");
      assert.ok(imp.guidanceCard, "guidance card exists");
      if (width === 1280) {
        assert.ok(imp.form.y === imp.guidanceCard.y, "main form and guidance card must share desktop row");
        assert.ok(imp.form.width > imp.guidanceCard.width, "main form must be wider than guidance card (~65% / 35%)");
        assert.ok(layout.documentWidth <= width, "no horizontal overflow on desktop");
      } else {
        assert.ok(imp.form.y < imp.guidanceCard.y, "form and guidance card must stack vertically on mobile");
        assert.ok(layout.documentWidth <= width, "no horizontal overflow on mobile");
      }
    }
  } catch (error) {
    failures.push(`${width}px: ${error.message}`);
  }
}
socket.close();
if (failures.length) throw new Error(failures.join("\n"));
