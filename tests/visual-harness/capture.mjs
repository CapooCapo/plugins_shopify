/* eslint-env node */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const pageName = process.argv[2] ?? "overview";
assert.ok(["overview", "products", "products-sku", "new-import", "receipt-actions", "receipt-detail", "catalog"].includes(pageName), "visual page must be overview, products, products-sku, new-import, receipt-actions, receipt-detail, or catalog");
const screenshotDirectory = process.env.VISUAL_OUTPUT_DIR
  ? resolve(process.env.VISUAL_OUTPUT_DIR)
  : resolve(fileURLToPath(new URL("./screenshots/", import.meta.url)));
await mkdir(screenshotDirectory, { recursive: true });
const outputFile = (name) => resolve(screenshotDirectory, name);
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
const view = pageName === "products-sku" ? "products&mode=sku" : pageName === "receipt-detail" ? "receipt-detail&fixture=ready" : pageName === "overview" ? "overview&scenario=ready&range=30" : pageName;
  const resetCatalog = pageName === "catalog" ? "&resetCatalog=1" : "";
  await command("Page.navigate", { url: `http://127.0.0.1:4179/?page=${view}${resetCatalog}` });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  if (pageName === "overview") await waitFor(`document.body.dataset.visualReady==='true'`, "Overview fixture initial measurement");
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
    await writeFile(outputFile(`catalog-empty-${width}.json`), JSON.stringify(metrics, null, 2));
    await scrollToTop();
    const emptyShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`catalog-empty-${width}.png`), Buffer.from(emptyShot.data, "base64"));

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
    await writeFile(outputFile(`catalog-english-mapping-${width}.json`), JSON.stringify(englishData, null, 2));
    await scrollToTop();
    const englishShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`catalog-english-mapping-${width}.png`), Buffer.from(englishShot.data, "base64"));
    await writeFile(outputFile(`catalog-english-${width}-interaction.json`), JSON.stringify({ suggested: englishSuggestions.result.value,
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
    await writeFile(outputFile(`catalog-mapping-validation-${width}.json`), JSON.stringify({ duplicateMappingError, missingMappingError }, null, 2));

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
    await writeFile(outputFile(`catalog-preview-${width}.json`), JSON.stringify(previewData, null, 2));
    await scrollToTop();
    const previewShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`catalog-preview-${width}.png`), Buffer.from(previewShot.data, "base64"));

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
    await writeFile(outputFile(`catalog-groups-${width}.json`), JSON.stringify(groupingLayout.result.value, null, 2));
    await scrollToTop();
    const groupingShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`catalog-groups-${width}.png`), Buffer.from(groupingShot.data, "base64"));
    const qualitySummary = await evaluate(`({counts:[...document.querySelectorAll('.stockhub-catalog-quality-counts > div')].map(el=>el.innerText.trim()), rows:[...document.querySelectorAll('.stockhub-catalog-row-card > p strong')].map(el=>el.textContent), pageWidth:document.documentElement.scrollWidth, viewport:innerWidth})`);
    assert.equal(qualitySummary.result.value.counts.length, 3, "Ready, Warning, Error counts are visible");
    assert.ok(qualitySummary.result.value.counts.some((value) => /Warning rows/.test(value)), "warning count is visibly labeled");
    assert.ok(qualitySummary.result.value.counts.some((value) => /Error rows/.test(value)), "error count is visibly labeled");
    assert.ok(qualitySummary.result.value.pageWidth <= width, "quality summary and filters fit the viewport");
    await writeFile(outputFile(`catalog-quality-${width}.json`), JSON.stringify(qualitySummary.result.value, null, 2));
    await scrollToTop();
    const qualityShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`catalog-quality-${width}.png`), Buffer.from(qualityShot.data, "base64"));
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
    await writeFile(outputFile(`catalog-compare-${width}.json`), JSON.stringify(compareLayout.result.value, null, 2));
    await evaluate(`document.querySelectorAll('.stockhub-catalog-compare-card')[1]?.scrollIntoView({block:'center'})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const compareShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`catalog-compare-${width}.png`), Buffer.from(compareShot.data, "base64"));
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
    await writeFile(outputFile(`catalog-${width}-interaction.json`), JSON.stringify(catalogInteraction, null, 2));
  }
  await writeFile(outputFile(`${pageName}-${width}.json`), JSON.stringify(metrics, null, 2));
  await scrollToTop();
  const shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(outputFile(`${pageName}-${width}.png`), Buffer.from(shot.data, "base64"));
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
    await writeFile(outputFile(`${pageName}-${width}-interaction.json`), JSON.stringify(interaction, null, 2));
  }
  if (pageName === "receipt-detail") {
    const initial = JSON.parse(metrics.metrics).receiptDetail;
    assert.ok(initial, "the production receipt detail route fixture is mounted");
    assert.equal(initial.qualityCards.length, 3, "the real receipt route exposes Ready, Missing, and Error validation filters");
    assert.equal(initial.table.rows.length, 12, "the desktop and mobile structures render all fixture receipt rows");
    assert.equal(initial.issueGroups.length, 3, "repeated validation causes are grouped while distinct causes remain separate");
    assert.ok(initial.issueGroups.some((group) => group.label === "The SKU value is blank in this CSV row." && group.count === "2"),
      "equivalent blank-SKU CSV errors group as two affected rows");
    assert.ok(initial.issueGroups.some((group) => group.label === "Quantity must be a positive integer." && group.count === "2"),
      "a different CSV_INVALID_ROW cause remains its own two-row group");
    assert.equal(initial.mergeButtonCount, 1, "eligible PREVIEWED rows expose a Merge action");
    assert.equal(initial.mergeDialogCount, 0, "eligible PREVIEWED rows still require an explicit second confirmation");
    assert.match(initial.previewNote, /Preview only[\s\S]*No Shopify changes have been made/);
    assert.equal(initial.shopifyMutationCalls, 0, "the local fixture does not make Shopify mutations");

    if (width === 1280) {
      assert.notEqual(initial.table.display, "none", "desktop uses the semantic table structure");
      assert.ok(initial.table.width > 900, "desktop table uses the embedded-app content width");
      assert.ok(initial.table.scrollWidth <= initial.table.width + 2, "desktop table does not require horizontal scrolling");
      assert.ok(initial.table.productColumnWidth >= 260, "desktop Product / Variant column remains readable");
      assert.ok(initial.table.skuColumnWidth >= 130, "desktop SKU column remains readable");
      assert.ok(initial.table.headings.length >= 5 && initial.table.headings.every((heading) => heading.whiteSpace === "nowrap" && heading.scrollWidth <= heading.clientWidth + 2),
        "desktop column headings remain on one line without clipping");
    } else {
      assert.equal(initial.table.display, "none", "mobile hides the desktop table rather than compressing it");
      assert.equal(initial.mobile.display, "grid", "mobile renders the dedicated row-card structure");
      assert.ok(initial.mobile.cards.every((card) => card.x >= 0 && card.right <= width), "mobile row cards stay within the viewport");
      assert.ok(initial.mobile.cards.every((card) => card.actionHeights.length > 0 && card.actionHeights.every((height) => height >= 44)),
        "mobile row action targets are at least 44px high");
      assert.ok(initial.qualityCards.every((card) => card.rect.height >= 78), "mobile validation filter cards retain touch-friendly height");
    }

    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-receipt-lines')?.scrollIntoView({behavior:'instant',block:'start'})` });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rowsShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`receipt-detail-rows-${width}.png`), Buffer.from(rowsShot.data, "base64"));
    await scrollToTop();

    const runScript = async (expression) => {
      const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return result.result.value;
    };
    await runScript(`(() => [...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Ready to Merge'))?.click())()`);
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('5 rows')`, "Ready validation filter");
    const readyFilter = await runScript(`({results:document.querySelector('.stockhub-line-results')?.textContent.trim(),pressed:[...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Ready to Merge'))?.getAttribute('aria-pressed')})`);
    assert.equal(readyFilter.pressed, "true", "clicking Ready to Merge marks that quality filter selected");
    assert.match(readyFilter.results, /^5 rows/);
    await runScript(`(() => [...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Missing Information'))?.click())()`);
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('1 row')`, "Missing Information validation filter");
    const missingFilter = await runScript(`({results:document.querySelector('.stockhub-line-results')?.textContent.trim(),pressed:[...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Missing Information'))?.getAttribute('aria-pressed')})`);
    assert.equal(missingFilter.pressed, "true");
    assert.match(missingFilter.results, /^1 row/);
    await runScript(`(() => [...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.trim().startsWith('6') && button.innerText.includes('Error'))?.click())()`);
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('6 rows')`, "Error validation filter");
    const errorFilter = await runScript(`({results:document.querySelector('.stockhub-line-results')?.textContent.trim(),pressed:[...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Error'))?.getAttribute('aria-pressed')})`);
    assert.equal(errorFilter.pressed, "true");
    assert.match(errorFilter.results, /^6 rows/);
    await runScript(`(() => [...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Error'))?.click())()`);

    const searchAndType = await runScript(`(() => {
      const search=document.querySelector('s-text-field[label="Search line items"]');
      search.value='SKU-READY-DRAFT-02';
      search.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
      search.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      const type=document.querySelector('s-select[label="Operation type"]');
      type.value='CREATE_DRAFT';
      type.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      return {search:search.value,type:type.value};
    })()`);
    assert.deepEqual(searchAndType, { search: "SKU-READY-DRAFT-02", type: "CREATE_DRAFT" });
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('1 row')`, "search and operation-type filters");
    const beforeIssueAction = await runScript(`document.querySelector('.stockhub-line-results')?.textContent.trim()`);
    assert.match(beforeIssueAction, /^1 row/);
    const groupAction = await runScript(`(() => {
      const group=[...document.querySelectorAll('.stockhub-validation-issue-list > li')].find(item=>item.innerText.includes('The SKU value is blank in this CSV row.'));
      group?.querySelector('button')?.click();
      return group?.querySelector('button')?.textContent.trim() ?? null;
    })()`);
    assert.equal(groupAction, "Show 2 affected rows");
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('2 rows')`, "complete selected validation issue group");
    const groupFilter = await runScript(`({
      results:document.querySelector('.stockhub-line-results')?.textContent.trim(),
      search:document.querySelector('s-text-field[label="Search line items"]')?.value,
      type:document.querySelector('s-select[label="Operation type"]')?.value,
      status:document.querySelector('s-select[label="Quality status"]')?.value,
      skus:[...document.querySelectorAll('.stockhub-lines-table tbody tr')].map(row=>row.querySelector('[data-label="SKU"]')?.textContent.trim())
    })`);
    assert.match(groupFilter.results, /^2 rows/);
    assert.equal(groupFilter.search, "", "Show affected rows clears the prior search");
    assert.equal(groupFilter.type, "ALL", "Show affected rows clears the incompatible operation filter");
    assert.equal(groupFilter.status, "ERROR", "Show affected rows applies the error filter");
    assert.deepEqual(groupFilter.skus, ["SKU-CSV-MISSING-04", "SKU-CSV-MISSING-05"], "the visible rows exactly match the advertised group");

    const sortBefore = groupFilter.skus;
    await runScript(`([...document.querySelectorAll('.stockhub-line-toolbar__filters s-button')].find(button=>button.innerText.includes('Sort by row')))?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const sortAfter = await runScript(`([...document.querySelectorAll('.stockhub-lines-table tbody tr')].map(row=>row.querySelector('[data-label="SKU"]')?.textContent.trim()))`);
    assert.deepEqual(sortAfter, [...sortBefore].reverse(), "Sort by row reverses the selected group order");

    await runScript(`(() => {
      const search=document.querySelector('s-text-field[label="Search line items"]');
      search.value=''; search.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      const status=document.querySelector('s-select[label="Quality status"]');
      status.value='ALL'; status.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      const type=document.querySelector('s-select[label="Operation type"]');
      type.value='ALL'; type.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    })()`);
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('12 rows')`, "all receipt rows after clearing filters");

    const revalidateBefore = await runScript(`document.querySelector('.stockhub-line-toolbar__actions s-button[type="submit"]')?.hasAttribute('disabled') ?? null`);
    assert.equal(revalidateBefore, true, "revalidation is disabled until a row is selected");
    if (width > 760) {
      await runScript(`document.querySelector('.stockhub-lines-table button[aria-label="Open details for row 1"]')?.click()`);
    } else {
      await runScript(`document.querySelector('.stockhub-mobile-lines button[aria-label="Open details for row 1"]')?.click()`);
    }
    await waitFor(`!!document.querySelector('.stockhub-row-inspector[role="dialog"]')`, "row detail drawer");
    const drawerState = await runScript(`({title:document.querySelector('#stockhub-row-inspector-heading')?.textContent.trim(),revalidateDisabled:document.querySelector('.stockhub-line-toolbar__actions s-button[type="submit"]')?.hasAttribute('disabled') ?? null})`);
    assert.match(drawerState.title, /Row 1 · SKU-READY-ADJUST-01/);
    assert.equal(drawerState.revalidateDisabled, false, "selecting a row enables its guarded revalidation action");
    await runScript(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await waitFor(`!document.querySelector('.stockhub-row-inspector[role="dialog"]')`, "drawer Escape close");

    const addButton = await runScript(`(() => {
      const button=[...document.querySelectorAll('.stockhub-line-toolbar__actions s-button')].find(item=>item.innerText.includes('Add draft row'));
      button?.click(); return !!button;
    })()`);
    assert.equal(addButton, true, "editable Previewed receipts expose Add draft row");
    await waitFor(`document.querySelector('#stockhub-row-inspector-heading')?.textContent.includes('Add draft row')`, "Add draft row drawer");
    await runScript(`document.querySelector('.stockhub-row-inspector button[aria-label="Close product details"]')?.click()`);
    await waitFor(`!document.querySelector('.stockhub-row-inspector[role="dialog"]')`, "close Add draft row drawer");

    await runScript(`([...document.querySelectorAll('.stockhub-merge-action s-button')].find(button=>button.innerText.includes('Merge eligible lines')))?.click()`);
    await waitFor(`!!document.querySelector('.stockhub-merge-confirmation[role="dialog"]')`, "explicit Merge confirmation dialog");
    const mergeFields = await runScript(`Object.fromEntries([...document.querySelectorAll('.stockhub-merge-confirmation input[type="hidden"]')].map(input=>[input.name,input.value]))`);
    assert.deepEqual(mergeFields, {
      intent: "merge",
      batchId: "fixture-receipt-001",
      confirmed: "yes",
      confirmedCount: "5",
      partialConfirmed: "yes",
    }, "eligible preview preserves explicit current-count and partial-confirmation fields");
    const interaction = { readyFilter, missingFilter, errorFilter, beforeIssueAction, groupFilter, sortAfter, drawerState, revalidateBefore, addButton, mergeFields };
    await writeFile(outputFile(`receipt-detail-interaction-${width}.json`), JSON.stringify(interaction, null, 2));

    await command("Page.navigate", { url: "http://127.0.0.1:4179/?page=receipt-detail&fixture=zero" });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const zeroResult = await command("Runtime.evaluate", {
      expression: `({ready:document.body.dataset.visualReady,metrics:document.getElementById('visual-metrics')?.textContent,body:document.body.innerText})`,
      returnByValue: true,
    });
    const zeroState = zeroResult.result.value;
    assert.equal(zeroState.ready, "true", "zero-ready Previewed fixture has rendered");
    const zeroLayout = JSON.parse(zeroState.metrics).receiptDetail;
    assert.equal(zeroLayout.qualityCards.find((card) => card.text.includes("Ready to Merge"))?.rect.height > 0, true);
    assert.equal(zeroLayout.mergeButtonCount, 0, "zero-ready Previewed receipt renders no Merge/Resume action");
    assert.equal(zeroLayout.mergeDialogCount, 0, "zero-ready Previewed receipt cannot show a confirmation dialog");
    assert.match(zeroState.body, /No rows are ready to merge/);
    assert.doesNotMatch(zeroState.body, /Resume eligible lines|Confirm resume/);
    assert.match(zeroState.body, /Verify Shopify State/, "read-only receipt verification remains available");
    assert.equal(zeroLayout.shopifyMutationCalls, 0);
    const zeroShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`receipt-detail-zero-${width}.png`), Buffer.from(zeroShot.data, "base64"));
    await writeFile(outputFile(`receipt-detail-zero-${width}.json`), JSON.stringify(zeroState, null, 2));
  }
  if (pageName === "receipt-actions") {
    const initialLayout = JSON.parse(metrics.metrics);
    assert.equal(initialLayout.receiptActions.summary.cardCount, 4, "operation outcomes use four concise summary cards");
    assert.match(initialLayout.receiptActions.summary.zeroEligibleTerminal, /All 15 import lines completed/);
    assert.equal(initialLayout.receiptActions.summary.mergeActionCount, 0, "zero eligible rows render no sticky Merge/Resume action");
    assert.equal(initialLayout.receiptActions.summary.warningCount, 0, "zero eligible terminal state has no irrelevant warning banner");
    assert.match(metrics.body, /Verify Shopify State/, "read-only Shopify state verification remains available");
    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-receipt-card > button[aria-hidden="true"]')?.click()` });
    await waitFor(`!!document.querySelector('.stockhub-merge-action > button')`, "eligible preview state");
    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-merge-action > button')?.click()` });
    await waitFor(`!!document.querySelector('.stockhub-merge-confirmation[role="dialog"]')`, "explicit Merge confirmation");
    const rejected = await command("Runtime.evaluate", {
      expression: `(async () => {
        document.querySelector('.stockhub-merge-confirmation button[type="button"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 150));
        return document.querySelector('.receipt-action-result')?.textContent ?? null;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(rejected.result.value, null, "canceling the confirmation must not submit the Merge form");

    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-merge-action > button')?.click()` });
    await waitFor(`!!document.querySelector('.stockhub-merge-confirmation button[type="submit"]')`, "confirmed Merge form");
    const accepted = await command("Runtime.evaluate", {
      expression: `(async () => {
        document.querySelector('.stockhub-merge-confirmation button[type="submit"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        return document.querySelector('.receipt-action-result')?.textContent ?? null;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    interaction = { canceledSubmission: rejected.result.value, confirmedSubmission: accepted.result.value };
    assert.equal(interaction.confirmedSubmission, JSON.stringify({ intent: "merge", batchId: "fixture-batch-001", confirmed: "yes", confirmedCount: "15" }), "explicit confirmation must submit the existing React Router Form fields");
    await writeFile(outputFile(`${pageName}-${width}-interaction.json`), JSON.stringify(interaction, null, 2));
  }
  if (pageName === "catalog") {
    await writeFile(outputFile(`catalog-${width}-interaction.json`), JSON.stringify(catalogInteraction, null, 2));
  }
  console.log(width, JSON.stringify(metrics));
  try {
  assert.equal(metrics.ready, "true", "React route presentation must finish rendering");
  assert.equal(metrics.errors, undefined, "Vite must not report a rendering error");
  const layout = JSON.parse(metrics.metrics);
  assert.equal(layout.viewport.width, width);
  assert.ok(layout.documentWidth <= width, "page must not overflow horizontally");
  if (pageName === "overview") {
    const overview = layout.overview;
    assert.match(metrics.body, /Business analytics/);
    assert.match(metrics.body, /Net merchandise sales/);
    assert.match(metrics.body, /LOCAL FIXTURE · NOT LIVE SHOPIFY ADMIN DATA/);
    assert.equal(overview.scenario, "ready");
    assert.equal(overview.range, 30);
    assert.deepEqual(overview.rangeControls.map(({ label, current }) => [label, current]), [["7 days", null], ["30 days", "page"]],
      "the selected shop-local range is shown with an accessible pressed state");
    assert.equal(overview.salesCards.length, 4, "ready fixture renders four sales/inventory KPI cards");
    assert.equal(overview.snapshotCards.length, 4, "existing product snapshot cards remain present");
    assert.ok(overview.salesCards.every(({ value }) => value && value !== "—"), "ready analytics show verified fixture metrics rather than placeholders");
    assert.equal(overview.salesBars, 30, "30-day fixture renders one bar per shop-local date");
    assert.equal(overview.salesRankingCount, 6, "top product and variant rankings render from ready data");
    assert.equal(overview.lowStockRows, 2, "inventory fixture shows both low-stock SKUs");
    assert.equal(overview.outOfStockRows, 1, "inventory fixture shows a separate out-of-stock restock row");
    assert.deepEqual(overview.inventoryCounts, ["Low stock2 SKUs", "Out of stock1 SKUs"], "ready inventory shows low- and out-of-stock aggregates");
    assert.deepEqual(overview.salesNotices, [], "ready datasets do not show permission or error warnings");
    assert.match(overview.shopCurrency, /America\/New_York.*USD/);
    assert.match(metrics.body, /Execution attention/);
    assert.match(metrics.body, /Previewed draft validation issues stay on their receipts and are not failed Shopify mutations/);
    assert.match(metrics.body, /Outcome uncertain/);
    assert.equal(layout.primaryActionCount, 1);
    assert.equal(layout.quickActionLinkCount, 3);
    assert.equal(layout.polarisPageDefined, true);
    assert.equal(layout.polarisButtonDefined, true);
    assert.equal(overview.fixtureLabel, "LOCAL FIXTURE · NOT LIVE SHOPIFY ADMIN DATA");
    assert.ok(overview.salesCards.every((card) => card.height >= 100 && card.height <= 160), "sales KPI cards have readable, bounded height");
    assert.ok(overview.snapshotCards.every((card) => card.height >= 100 && card.height <= 160), "store snapshot cards have readable, bounded height");
    if (width === 1280) {
      assert.equal(new Set(overview.salesCards.map((card) => card.y)).size, 1, "desktop analytics KPIs share one row");
      assert.equal(new Set(overview.snapshotCards.map((card) => card.y)).size, 1, "desktop store snapshot KPIs share one row");
      assert.ok(overview.salesTrend.width > 500 && overview.salesTrend.width <= width, "desktop trend chart has useful width without overflowing");
    } else {
      assert.equal(new Set(overview.salesCards.map((card) => card.y)).size, 2, "mobile analytics KPIs form a compact two-row layout");
      assert.equal(new Set(overview.snapshotCards.map((card) => card.y)).size, 2, "mobile store snapshot KPIs form a two-row layout");
      assert.ok(overview.salesTrend.width <= width, "mobile trend chart fits the viewport");
    }

    await writeFile(outputFile(`overview-ready-local-fixture-${width}.json`), JSON.stringify(metrics, null, 2));
    await scrollToTop();
    const readyShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`overview-ready-local-fixture-${width}.png`), Buffer.from(readyShot.data, "base64"));

    await evaluate(`document.querySelector('.stockhub-overview-range a[href*="range=7"]')?.click()`);
    await waitFor(`document.querySelector('.stockhub-overview-range a[aria-current="page"]')?.textContent?.trim()==='7 days'`, "7-day analytics selector state");
    await evaluate(`window.__refreshVisualMetrics?.()`);
    const rangeInteraction = await evaluate(`({search:window.__memorySearch, active:[...document.querySelectorAll('.stockhub-overview-range a')].filter(link=>link.getAttribute('aria-current')==='page').map(link=>link.textContent.trim()), hrefs:[...document.querySelectorAll('.stockhub-overview-range a')].map(link=>link.getAttribute('href'))})`);
    assert.match(rangeInteraction.result.value.search, /range=7/);
    assert.deepEqual(rangeInteraction.result.value.active, ["7 days"], "clicking the date selector changes the active range");
    await writeFile(outputFile(`overview-range-selector-local-fixture-${width}.json`), JSON.stringify(rangeInteraction.result.value, null, 2));

    await command("Page.navigate", { url: `http://127.0.0.1:4179/?page=overview&scenario=scope-missing&range=30` });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await waitFor(`document.body.dataset.visualReady==='true'`, "Overview missing-scope fixture measurement");
    result = await command("Runtime.evaluate", {
      expression: `({ ready: document.body.dataset.visualReady, metrics: document.getElementById('visual-metrics')?.textContent, body: document.body.innerText, errors: document.querySelector('vite-error-overlay')?.shadowRoot?.innerText })`,
      returnByValue: true,
    });
    metrics = result.result.value;
    assert.equal(metrics.ready, "true", "missing-scope fixture renders successfully");
    assert.equal(metrics.errors, undefined, "missing-scope fixture has no Vite runtime error");
    assert.match(metrics.body, /Sales analytics require the read_orders permission/);
    assert.match(metrics.body, /no order data was requested/i);
    const missingLayout = JSON.parse(metrics.metrics);
    assert.ok(missingLayout.documentWidth <= width, "missing-scope state must not overflow horizontally");
    assert.equal(missingLayout.overview.scenario, "scope-missing");
    assert.equal(missingLayout.overview.salesCards[0].value, "—", "missing sales permission must not fabricate revenue as zero");
    assert.equal(missingLayout.overview.salesCards[1].value, "—", "missing sales permission must not fabricate orders as zero");
    assert.equal(missingLayout.overview.salesCards[2].value, "—", "missing sales permission must not fabricate units as zero");
    assert.equal(missingLayout.overview.salesCards[3].value, "2", "verified inventory stays visible when only read_orders is missing");
    assert.equal(missingLayout.overview.lowStockRows, 2);
    assert.ok(missingLayout.overview.salesNotices.some((message) => /read_orders/.test(message)));
    assert.equal(missingLayout.overview.fixtureLabel, "LOCAL FIXTURE · NOT LIVE SHOPIFY ADMIN DATA");
    await writeFile(outputFile(`overview-scope-missing-local-fixture-${width}.json`), JSON.stringify(metrics, null, 2));
    await scrollToTop();
    const missingShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`overview-scope-missing-local-fixture-${width}.png`), Buffer.from(missingShot.data, "base64"));
  }
  if (pageName === "receipt-actions") {
    assert.equal(layout.receiptActions.summary.cardCount, 4, "four persisted operation metrics render as cards");
    assert.ok(layout.receiptActions.summary.width - layout.receiptActions.summary.scrollWidth <= 2,
      "receipt summary cards must fit their container at desktop and mobile widths");
    assert.deepEqual(layout.receiptActions.summary.labels,
      ["Import lines completed", "Draft products created", "New-product inventory activations", "Existing SKU inventory adjustments"]);
    assert.equal(layout.polarisButtonDefined, true, "Polaris s-button must be registered");
    assert.ok(layout.receiptActions.searchFieldRect, "line-item search field must be rendered");
    assert.equal(layout.receiptActions.host, null, "zero-eligible terminal state renders no merge button");
    assert.equal(layout.receiptActions.customElementDefined, true);
    assert.equal(layout.receiptActions.searchLabel, "Search line items", "line-item search control must be rendered");
    assert.match(metrics.body, /Import lines complete/, "terminal status must be exposed in the rendered page");
    assert.equal(interaction.confirmedSubmission, JSON.stringify({ intent: "merge", batchId: "fixture-batch-001", confirmed: "yes", confirmedCount: "15" }));
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
