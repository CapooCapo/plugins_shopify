/* eslint-env node */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { runCatalogFlow } from "./capture-catalog.mjs";
import { runProductInteractions } from "./capture-products.mjs";
import { runReceiptDetailInteractions } from "./capture-receipt-detail.mjs";
import { runReceiptActionInteractions } from "./capture-receipt-actions.mjs";
import { validateOverviewLive } from "./capture-overview-live.mjs";
import { validateOverviewSample } from "./capture-overview-sample.mjs";
import { validatePageAssertions } from "./capture-page-assertions.mjs";

const pageName = process.argv[2] ?? "overview";
assert.ok(["overview", "overview-sample", "products", "products-sku", "new-import", "receipt-actions", "receipt-detail", "catalog"].includes(pageName), "visual page must be overview, overview-sample, products, products-sku, new-import, receipt-actions, receipt-detail, or catalog");
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
async function captureRankingRegion(name, range, width) {
  await evaluate(`document.querySelector('.stockhub-overview-best-sellers')?.scrollIntoView({block:'start', behavior:'instant'})`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await evaluate(`document.querySelector('.stockhub-ranking-switch button[aria-pressed="false"]')?.click()`);
  await waitFor(`document.querySelector('.stockhub-ranking-switch button[aria-pressed="true"]')?.textContent.trim()==='Variants'`, "variant ranking switch");
  const review = await evaluate(`(() => {
    const panel=document.querySelector('.stockhub-overview-best-sellers');
    const rect=panel?.getBoundingClientRect();
    return {
      viewport:{width:innerWidth,height:innerHeight}, documentWidth:document.documentElement.scrollWidth,
      bodyWidth:document.body.scrollWidth, search:window.__memorySearch,
      range:new URLSearchParams(window.__memorySearch).get('range'), sample:new URLSearchParams(window.__memorySearch).get('sample'),
      panel:rect?{x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)}:null,
      rows:[...document.querySelectorAll('.stockhub-overview-best-sellers ol > li')].map(row=>row.innerText.trim())
    };
  })()`);
  const data = review.result.value;
  assert.equal(data.range, String(range), `${range}-day ranking view matches selected range`);
  assert.equal(data.sample, "1", "ranking view remains in sample mode");
  assert.equal(data.viewport.width, width);
  assert.ok(data.documentWidth <= width && data.bodyWidth <= width, "ranking region has no page-level horizontal overflow");
  assert.equal(data.rows.length, 5, "variant ranking is interactive and renders five rows");
  assert.ok(data.panel.x >= 0 && data.panel.x + data.panel.width <= width, "ranking panel fits within viewport width");
  await writeFile(outputFile(`${name}-${width}.json`), JSON.stringify(data, null, 2));
  const shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(outputFile(`${name}-${width}.png`), Buffer.from(shot.data, "base64"));
  await evaluate(`document.querySelector('.stockhub-ranking-switch button[aria-pressed="false"]')?.click()`);
  await waitFor(`document.querySelector('.stockhub-ranking-switch button[aria-pressed="true"]')?.textContent.trim()==='Products'`, "product ranking switch");
}
const failures = [];
for (const width of [1280, 390]) {
  await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
  const view = pageName === "products-sku" ? "products&mode=sku" : pageName === "receipt-detail" ? "receipt-detail&fixture=ready" : pageName === "overview" ? "overview&scenario=ready&range=30" : pageName === "overview-sample" ? "overview&range=30&sample=1" : pageName;
  const resetCatalog = pageName === "catalog" ? "&resetCatalog=1" : "";
  await command("Page.navigate", { url: `http://127.0.0.1:4179/?page=${view}${resetCatalog}` });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  if (pageName === "overview" || pageName === "overview-sample") await waitFor(`document.body.dataset.visualReady==='true'`, "Overview fixture initial measurement");
  const result = await command("Runtime.evaluate", {
    expression: `({ ready: document.body.dataset.visualReady, metrics: document.getElementById('visual-metrics')?.textContent, body: document.body.innerText, errors: document.querySelector('vite-error-overlay')?.shadowRoot?.innerText })`,
    returnByValue: true,
  });
  let metrics = result.result.value;
  let catalogInteraction = null;
  if (pageName === "catalog") {
    const outcome = await runCatalogFlow({ pageName, width, metrics, command, evaluate, waitFor, scrollToTop, writeFile, outputFile, fixturePath, englishFixturePath });
    metrics = outcome.metrics;
    catalogInteraction = outcome.catalogInteraction;
  }

  await writeFile(outputFile(`${pageName}-${width}.json`), JSON.stringify(metrics, null, 2));
  await scrollToTop();
  const shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(outputFile(`${pageName}-${width}.png`), Buffer.from(shot.data, "base64"));

  let interaction = null;
  if (pageName.startsWith("products")) interaction = await runProductInteractions({ pageName, width, command, writeFile, outputFile });
  if (pageName === "receipt-detail") await runReceiptDetailInteractions({ metrics, width, command, waitFor, scrollToTop, writeFile, outputFile });
  if (pageName === "receipt-actions") interaction = await runReceiptActionInteractions({ metrics, pageName, width, command, waitFor, writeFile, outputFile });
  if (pageName === "catalog") await writeFile(outputFile(`catalog-${width}-interaction.json`), JSON.stringify(catalogInteraction, null, 2));

  try {
    assert.equal(metrics.ready, "true", "React route presentation must finish rendering");
    assert.equal(metrics.errors, undefined, "Vite must not report a rendering error");
    const layout = JSON.parse(metrics.metrics);
    assert.equal(layout.viewport.width, width);
    assert.ok(layout.documentWidth <= width, "page must not overflow horizontally");
    if (pageName === "overview") await validateOverviewLive({ width, metrics, layout, command, evaluate, waitFor, scrollToTop, writeFile, outputFile });
    if (pageName === "overview-sample") metrics = await validateOverviewSample({ width, metrics, layout, command, evaluate, waitFor, scrollToTop, writeFile, outputFile, captureRankingRegion });
    validatePageAssertions({ pageName, width, layout, metrics, interaction });
  } catch (error) {
    failures.push(`${width}px: ${error.message}`);
  }
}
socket.close();
if (failures.length) throw new Error(failures.join("\n"));
