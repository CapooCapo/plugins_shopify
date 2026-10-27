/* eslint-env node */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const pageName = process.argv[2] ?? "overview";
assert.ok(["overview", "products", "products-sku", "new-import", "receipt-actions", "catalog"].includes(pageName), "visual page must be overview, products, products-sku, new-import, receipt-actions, or catalog");
const fixturePath = resolve(fileURLToPath(new URL("./fixtures/catalog-vietnamese.csv", import.meta.url)));
const englishFixturePath = resolve(fileURLToPath(new URL("./fixtures/catalog-english.csv", import.meta.url)));

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
async function evaluate(expression, options = {}) {
  return command("Runtime.evaluate", { expression, returnByValue: true, ...options });
}
async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await evaluate(expression);
    if (result.result.value) return result.result.value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function scrollToTop() {
  await evaluate("window.scrollTo({ top: 0, left: 0, behavior: 'instant' })");
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const failures = [];
for (const width of [1280, 390]) {
  await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
  const view = pageName === "products-sku" ? "products&mode=sku" : pageName;
  const resetCatalog = pageName === "catalog" ? "&resetCatalog=1" : "";
  await command("Page.navigate", { url: `http://127.0.0.1:4179/?page=${view}${resetCatalog}` });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  let result = await command("Runtime.evaluate", {
    expression: `({ ready: document.body.dataset.visualReady, metrics: document.getElementById('visual-metrics')?.textContent, body: document.body.innerText, errors: document.querySelector('vite-error-overlay')?.shadowRoot?.innerText })`,
    returnByValue: true,
  });
  let metrics = result.result.value;
  let catalogInteraction = null;
  if (pageName === "catalog") {
    const emptyLayout = JSON.parse(metrics.metrics);
    assert.ok(metrics.ready === "true" && emptyLayout.catalog.fileInput, "initial empty Catalog Import page is ready");
    assert.match(metrics.body, /No catalog drafts yet/);
    assert.ok(emptyLayout.documentWidth <= width, "empty Catalog Import page must not overflow horizontally");
    await writeFile(new URL(`./screenshots/catalog-empty-${width}.json`, import.meta.url), JSON.stringify(metrics, null, 2));
    await scrollToTop();
    const emptyShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(new URL(`./screenshots/catalog-empty-${width}.png`, import.meta.url), Buffer.from(emptyShot.data, "base64"));

    await command("DOM.enable");
    const upload = async (path) => {
      const document = await command("DOM.getDocument", { depth: -1 });
      const fileNode = await command("DOM.querySelector", { nodeId: document.root.nodeId, selector: "#catalog-file" });
      assert.ok(fileNode.nodeId, "actual catalog route must expose its upload input");
      await command("DOM.setFileInputFiles", { nodeId: fileNode.nodeId, files: [path] });
      await evaluate(`document.querySelector('#catalog-file')?.closest('form')?.querySelector('button[type="submit"]')?.click()`);
      await waitFor(`!!document.querySelector('select[name="column-0"]')`, "catalog column mapping");
    };

    await upload(englishFixturePath);
    const englishSuggestions = await evaluate(`[...document.querySelectorAll('select[name^="column-"]')].map(el=>el.value)`);
    assert.deepEqual(englishSuggestions.result.value, ["productName", "sku", "price", "description", "size", "color", "vendor", ""],
      "canonical English headers should be suggested and Quantity ignored");
    await evaluate(`window.__refreshVisualMetrics?.()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const englishMapping = await evaluate(`({body:document.body.innerText,metrics:document.getElementById('visual-metrics')?.textContent,values:[...document.querySelectorAll('select[name^="column-"]')].map(el=>el.value)})`);
    const englishData = englishMapping.result.value;
    await writeFile(new URL(`./screenshots/catalog-english-mapping-${width}.json`, import.meta.url), JSON.stringify(englishData, null, 2));
    await scrollToTop();
    const englishShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(new URL(`./screenshots/catalog-english-mapping-${width}.png`, import.meta.url), Buffer.from(englishShot.data, "base64"));
    await writeFile(new URL(`./screenshots/catalog-english-${width}-interaction.json`, import.meta.url), JSON.stringify({ suggested: englishSuggestions.result.value,
      labels: ["Product Name", "SKU", "Price", "Description", "Size", "Color", "Vendor"], quantityIgnored: englishSuggestions.result.value[7] === "" }, null, 2));

    await evaluate(`document.querySelector('a[href="/app/imports/catalog"]')?.click()`);
    await waitFor(`!!document.getElementById('catalog-file')`, "Catalog Import list after English fixture");
    await upload(fixturePath);

    const setMapping = async (index, value) => evaluate(`(() => { const el=document.querySelector('[name="column-${index}"]'); if(!el) throw Error('missing source mapping ${index}'); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    const submitInvalidMapping = async (expected, label) => {
      await evaluate(`document.querySelector('button[value="preview-mapping"]')?.click()`);
      await waitFor(`document.querySelector('[role="alert"]')?.innerText.includes(${JSON.stringify(expected)})`, label);
      const error = await evaluate(`document.querySelector('[role="alert"]')?.innerText`);
      assert.ok(error.result.value.includes(expected), `visible mapping error should explain: ${expected}`);
      return error.result.value;
    };
    await setMapping(0, "productName");
    await setMapping(1, "productName");
    const duplicateMappingError = await submitInvalidMapping("mapped more than once", "duplicate catalog mapping rejection");
    await setMapping(1, "sku");
    await setMapping(0, "");
    const missingMappingError = await submitInvalidMapping("Map a source column to Product Name", "missing required catalog mapping rejection");
    await setMapping(0, "productName");
    await writeFile(new URL(`./screenshots/catalog-mapping-validation-${width}.json`, import.meta.url), JSON.stringify({ duplicateMappingError, missingMappingError }, null, 2));

    // Keep the automatically suggested Vietnamese mappings, ignore Quantity,
    // and explicitly move Vendor mapping from the detected column to an override.
    await evaluate(`(() => { const set=(i,v)=>{const el=document.querySelector('[name="column-'+i+'"]'); if(!el) throw Error('missing source mapping '+i); el.value=v; el.dispatchEvent(new Event('change',{bubbles:true}));}; set(6,''); set(7,''); set(8,'vendor'); })()`);
    await evaluate(`document.querySelector('button[value="preview-mapping"]')?.click()`);
    await waitFor(`!!document.querySelector('form input[name="intent"][value="save-mapping"]')`, "normalized catalog preview");
    await evaluate(`window.__refreshVisualMetrics?.()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const preview = await evaluate(`({body:document.body.innerText,metrics:document.getElementById('visual-metrics')?.textContent})`);
    const previewData = preview.result.value;
    assert.match(previewData.body, /Preview normalized data|Confirm mapping and create draft/);
    assert.match(previewData.body, /Áo khoác mùa đông/);
    assert.match(previewData.body, /Price must be a non-negative decimal/);
    assert.match(previewData.body, /Quantity/);
    const previewLayout = JSON.parse(previewData.metrics);
    assert.ok(previewLayout.catalog.pageWidth <= width, "normalized preview must not create page-level horizontal overflow");
    if (width === 390) {
      const mobileCards = await evaluate(`(() => ({ visible:getComputedStyle(document.querySelector('.stockhub-catalog-preview-cards')).display!=='none', count:document.querySelectorAll('.stockhub-catalog-preview-card').length, tableHidden:getComputedStyle(document.querySelector('.stockhub-catalog-preview-table-wrap')).display==='none', details:document.querySelectorAll('.stockhub-catalog-preview-card details').length }))()`);
      assert.ok(mobileCards.result.value.visible && mobileCards.result.value.count > 0 && mobileCards.result.value.tableHidden,
        "mobile normalized preview uses readable cards instead of a compressed wide table");
      assert.equal(mobileCards.result.value.details, mobileCards.result.value.count, "each mobile preview card retains source/provenance disclosure");
    } else {
      assert.ok(previewLayout.catalog.tableRegions.length >= 1, "desktop normalized preview has a table overflow region");
      assert.ok(previewLayout.catalog.tableRegions.every((region) => region.tabIndex === 0 && region.label && region.width <= width && region.right <= width),
        "desktop table scrollers must be labeled, keyboard focusable, and remain inside the viewport");
      const focusedRegion = await evaluate(`(() => { const region=document.querySelector('.stockhub-catalog-preview-table-wrap'); region?.focus(); return !!region && document.activeElement===region && region.tabIndex===0; })()`);
      assert.equal(focusedRegion.result.value, true, "desktop table region can receive keyboard focus");
    }
    await writeFile(new URL(`./screenshots/catalog-preview-${width}.json`, import.meta.url), JSON.stringify(previewData, null, 2));
    await scrollToTop();
    const previewShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(new URL(`./screenshots/catalog-preview-${width}.png`, import.meta.url), Buffer.from(previewShot.data, "base64"));

    await evaluate(`document.querySelector('form input[name="intent"][value="save-mapping"]')?.closest('form')?.querySelector('button[type="submit"]')?.click()`);
    await waitFor(`document.querySelectorAll('.stockhub-catalog-row-card').length===3`, "created catalog draft");
    await waitFor(`document.querySelectorAll('.stockhub-catalog-group-card').length===3`, "persisted grouping proposals");
    const groupingLayout = await evaluate(`({cards:document.querySelectorAll('.stockhub-catalog-group-card').length, reasons:[...document.querySelectorAll('.stockhub-catalog-group-card header p')].map(el=>el.textContent), mobileCards:document.querySelectorAll('.stockhub-catalog-group-variant-cards article').length, mobileDisplay:getComputedStyle(document.querySelector('.stockhub-catalog-group-variant-cards')).display, pageWidth:document.documentElement.scrollWidth, viewport:innerWidth})`);
    assert.equal(groupingLayout.result.value.cards, 3);
    assert.ok(groupingLayout.result.value.pageWidth <= width, "Product Groups must not create page-level horizontal overflow");
    if (width === 390) {
      assert.equal(groupingLayout.result.value.mobileDisplay, "grid", "group variants use mobile card layout");
      assert.ok(groupingLayout.result.value.mobileCards >= 3);
    }
    await writeFile(new URL(`./screenshots/catalog-groups-${width}.json`, import.meta.url), JSON.stringify(groupingLayout.result.value, null, 2));
    await scrollToTop();
    const groupingShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(new URL(`./screenshots/catalog-groups-${width}.png`, import.meta.url), Buffer.from(groupingShot.data, "base64"));
    const qualitySummary = await evaluate(`({counts:[...document.querySelectorAll('.stockhub-catalog-quality-counts > div')].map(el=>el.innerText.trim()), rows:[...document.querySelectorAll('.stockhub-catalog-row-card > p strong')].map(el=>el.textContent), pageWidth:document.documentElement.scrollWidth, viewport:innerWidth})`);
    assert.equal(qualitySummary.result.value.counts.length, 3, "Ready, Warning, Error counts are visible");
    assert.ok(qualitySummary.result.value.counts.some((value) => /Warning rows/.test(value)), "warning count is visibly labeled");
    assert.ok(qualitySummary.result.value.counts.some((value) => /Error rows/.test(value)), "error count is visibly labeled");
    assert.ok(qualitySummary.result.value.pageWidth <= width, "quality summary and filters fit the viewport");
    await writeFile(new URL(`./screenshots/catalog-quality-${width}.json`, import.meta.url), JSON.stringify(qualitySummary.result.value, null, 2));
    await scrollToTop();
    const qualityShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(new URL(`./screenshots/catalog-quality-${width}.png`, import.meta.url), Buffer.from(qualityShot.data, "base64"));
    await evaluate(`(() => { const search=document.querySelector('.stockhub-catalog-quality-filters input[type="search"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,'VN-DRESS-02'); search.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    assert.equal((await evaluate(`document.querySelectorAll('.stockhub-catalog-row-card').length`)).result.value, 1, "quality search filters rows by SKU");
    await evaluate(`(() => { const search=document.querySelector('.stockhub-catalog-quality-filters input[type="search"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,''); search.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await evaluate(`(() => { const select=document.querySelector('.stockhub-catalog-quality-filters select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'WARNING'); select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    const warningFilterState = await evaluate(`({count:document.querySelectorAll('.stockhub-catalog-row-card').length, selected:document.querySelector('.stockhub-catalog-quality-filters select')?.value, labels:[...document.querySelectorAll('.stockhub-catalog-row-card > p strong')].map(el=>el.textContent)})`);
    assert.equal(warningFilterState.result.value.count, 1, `warning filter shows only warning rows: ${JSON.stringify(warningFilterState.result.value)}`);
    await evaluate(`(() => { const select=document.querySelector('.stockhub-catalog-quality-filters select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'ALL'); select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    const warningBeforeImageToggle = await evaluate(`document.querySelectorAll('.stockhub-catalog-quality-counts > div')[1]?.innerText`);
    await evaluate(`document.querySelector('.stockhub-catalog-quality-options input')?.click()`);
    await waitFor(`window.__memorySearch.includes('warnMissingImage=1') && document.querySelector('.stockhub-catalog-quality-options input')?.checked`, "optional image warning enabled");
    const warningWithImages = await evaluate(`document.querySelectorAll('.stockhub-catalog-quality-counts > div')[1]?.innerText`);
    assert.ok(Number(warningWithImages.result.value.match(/\d+/)?.[0]) > Number(warningBeforeImageToggle.result.value.match(/\d+/)?.[0]), "image warning toggle adds warnings without converting them to errors");
    await evaluate(`document.querySelector('.stockhub-catalog-quality-options input')?.click()`);
    await waitFor(`!window.__memorySearch.includes('warnMissingImage=1') && !document.querySelector('.stockhub-catalog-quality-options input')?.checked`, "optional image warning disabled");
    const acceptedGroup = await evaluate(`(() => { const card=[...document.querySelectorAll('.stockhub-catalog-group-card')].find(item=>item.innerText.includes('VN-BAG-03')); const button=[...card?.querySelectorAll('button')||[]].find(item=>item.textContent?.includes('Accept Group')); if(!button||button.disabled) return false; button.click(); return true; })()`);
    assert.equal(acceptedGroup.result.value, true, "a valid singleton product group can be explicitly accepted");
    await waitFor(`[...document.querySelectorAll('.stockhub-catalog-group-card')].some(card=>card.innerText.includes('VN-BAG-03')&&card.innerText.includes('Accepted'))`, "explicitly accepted product group");
    const compared = await evaluate(`(() => { const button=[...document.querySelectorAll('.stockhub-catalog-compare form button')].find(item=>item.textContent?.includes('Compare confirmed groups')); if(!button) return false; button.click(); return true; })()`);
    assert.equal(compared.result.value, true, "catalog fixture exposes a read-only comparison action");
    await waitFor(`document.querySelectorAll('.stockhub-catalog-compare-card').length===3`, "read-only Shopify comparison fixture");
    const compareLayout = await evaluate(`({cards:[...document.querySelectorAll('.stockhub-catalog-compare-card')].map(card=>card.innerText), pageWidth:document.documentElement.scrollWidth, viewport:innerWidth, mutationCalls:window.__shopifyMutationCalls, regions:[...document.querySelectorAll('.stockhub-catalog-compare-table-wrap')].map(region=>({tabIndex:region.tabIndex,label:region.getAttribute('aria-label')}))})`);
    assert.ok(compareLayout.result.value.pageWidth <= width, "change review fits the viewport at desktop/mobile sizes");
    assert.equal(compareLayout.result.value.mutationCalls, 0, "fixture comparison sends no Shopify write mutations");
    assert.ok(compareLayout.result.value.cards.some((card) => /CREATE/.test(card)) && compareLayout.result.value.cards.some((card) => /SKIP/.test(card)), "comparison keeps candidate disposition separate from unconfirmed group blocking");
    await writeFile(new URL(`./screenshots/catalog-compare-${width}.json`, import.meta.url), JSON.stringify(compareLayout.result.value, null, 2));
    await evaluate(`document.querySelectorAll('.stockhub-catalog-compare-card')[1]?.scrollIntoView({block:'center'})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const compareShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(new URL(`./screenshots/catalog-compare-${width}.png`, import.meta.url), Buffer.from(compareShot.data, "base64"));
    const initialStatuses = await evaluate(`[...document.querySelectorAll('.stockhub-catalog-row-card > p strong')].map(el=>el.textContent)`);
    assert.match(initialStatuses.result.value[0], /WARNING/, "unconfirmed zero price remains a warning until merchant confirms it");
    assert.match(initialStatuses.result.value[1], /ERROR/, "negative price remains a visible error");

    const confirmZero = await evaluate(`(() => { const card=document.querySelector('.stockhub-catalog-row-card'); const form=card?.querySelector('form'); const check=form?.querySelector('[name="priceZeroConfirmed"]'); if(!check) throw Error('zero-price confirmation control missing'); check.checked=true; check.dispatchEvent(new Event('change',{bubbles:true})); form.querySelector('button[type="submit"]')?.click(); return true; })()`);
    assert.equal(confirmZero.result.value, true);
    await waitFor(`/READY/.test(document.querySelector('.stockhub-catalog-row-card > p strong')?.textContent||'')`, "confirmed zero-price row");

    await evaluate(`(() => { const form=document.querySelector('form input[name="intent"][value="add"]')?.closest('form'); if(!form) throw Error('Add row form missing'); form.querySelector('[name="productName"]').value='Manual Catalog Test'; form.querySelector('[name="sku"]').value='MANUAL-001'; form.querySelector('button[type="submit"]')?.click(); })()`);
    await waitFor(`document.querySelectorAll('.stockhub-catalog-row-card').length===4`, "added manual catalog row");
    await evaluate(`(() => { const card=[...document.querySelectorAll('.stockhub-catalog-row-card')].at(-1); const form=card?.querySelector('form'); form.querySelector('[name="productName"]').value='Edited Manual Catalog Test'; form.querySelector('[name="price"]').value='-5.25'; form.querySelector('button[type="submit"]')?.click(); })()`);
    await waitFor(`document.querySelectorAll('.stockhub-catalog-row-card').length===4 && document.querySelectorAll('.stockhub-catalog-row-card')[3].innerText.includes('attempted value')`, "edited invalid manual row");
    await evaluate(`(() => { const card=[...document.querySelectorAll('.stockhub-catalog-row-card')].at(-1); card.querySelector('form input[name="intent"][value="delete"]')?.closest('form')?.querySelector('button[type="submit"]')?.click(); })()`);
    await waitFor(`document.querySelectorAll('.stockhub-catalog-row-card').length===3`, "deleted manual catalog row");
    await evaluate(`window.__refreshVisualMetrics?.()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const currentPath = await evaluate(`window.__memoryPath`);
    const batchId = String(currentPath.result.value).split("/").at(-1);
    assert.match(batchId, /^visual-catalog-\d+$/, "mock Catalog Import must retain its per-run batch identity");
    await command("Page.navigate", { url: `http://127.0.0.1:4179/?page=catalog&batchId=${encodeURIComponent(batchId)}` });
    await waitFor(`document.querySelectorAll('.stockhub-catalog-row-card').length===3`, "mock catalog draft after browser reload");
    const reloadState = await evaluate(`({path:window.__memoryPath,rows:[...document.querySelectorAll('.stockhub-catalog-row-card > p strong')].map(el=>el.textContent),zeroConfirmed:document.querySelector('.stockhub-catalog-row-card [name="priceZeroConfirmed"]')?.checked})`);
    assert.equal(reloadState.result.value.path, `/app/imports/catalog/${batchId}`);
    assert.match(reloadState.result.value.rows[0], /READY/);
    assert.match(reloadState.result.value.rows[1], /ERROR/);
    assert.equal(reloadState.result.value.zeroConfirmed, true, "confirmed zero price survives mock-only page reload");
    await evaluate(`window.__refreshVisualMetrics?.()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const completed = await evaluate(`({body:document.body.innerText,metrics:document.getElementById('visual-metrics')?.textContent,labels:[...document.querySelectorAll('.stockhub-catalog-field input')].every(el=>!!el.closest('label')),mockOnly:!window.__shopifyMutationCalls})`);
    const completedData = completed.result.value;
    metrics = { ready: "true", metrics: completedData.metrics, body: completedData.body, errors: undefined };
    const finalLayout = JSON.parse(completedData.metrics);
    assert.equal(finalLayout.catalog.rowCardCount, 3);
    assert.equal(finalLayout.catalog.route, `/app/imports/catalog/${batchId}`);
    assert.ok(finalLayout.catalog.pageWidth <= width, "catalog CRUD view must not create page-level horizontal overflow");
    assert.ok(finalLayout.catalog.fieldRects.every((field) => field.x >= 0 && field.right <= width), "CRUD fields must wrap within the viewport");
    assert.ok(completedData.labels, "CRUD inputs must retain associated labels");
    assert.ok(completedData.mockOnly, "catalog harness must not issue Shopify mutations");
    catalogInteraction = { uploadedFixture: "catalog-vietnamese.csv", mapped: "Vietnamese aliases plus Vendor override and Quantity ignore", previewed: true, confirmed: true,
      duplicateMappingRejected: /mapped more than once/.test(duplicateMappingError), missingRequiredMappingRejected: /Map a source column to Product Name/.test(missingMappingError),
      confirmedZeroPrice: true, negativePriceVisible: true, manualAddEditDelete: true, shopifyMutationCalls: 0 };
    catalogInteraction.groupSuggestionsVisible = true;
    catalogInteraction.explicitGroupAcceptance = true;
    catalogInteraction.groupCount = 3;
    catalogInteraction.mobileVariantCards = width === 390;
    catalogInteraction.mockReloadRestored = true;
    await writeFile(new URL(`./screenshots/catalog-${width}-interaction.json`, import.meta.url), JSON.stringify(catalogInteraction, null, 2));
  }
  await writeFile(new URL(`./screenshots/${pageName}-${width}.json`, import.meta.url), JSON.stringify(metrics, null, 2));
  await scrollToTop();
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
  if (pageName === "catalog") {
    await writeFile(new URL(`./screenshots/catalog-${width}-interaction.json`, import.meta.url), JSON.stringify(catalogInteraction, null, 2));
  }
  console.log(width, JSON.stringify(metrics));
  try {
  assert.equal(metrics.ready, "true", "React route presentation must finish rendering");
  assert.equal(metrics.errors, undefined, "Vite must not report a rendering error");
  const layout = JSON.parse(metrics.metrics);
  assert.equal(layout.viewport.width, width);
  assert.ok(layout.documentWidth <= width, "page must not overflow horizontally");
  if (pageName === "overview") {
  assert.match(metrics.body, /Needs attention\n3\nFailed, uncertain or partial imports/);
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
