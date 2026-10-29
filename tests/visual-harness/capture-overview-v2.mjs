/* eslint-env node */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { resolve } from "node:path";

const target = process.env.VISUAL_OUTPUT_DIR
  ? resolve(process.env.VISUAL_OUTPUT_DIR)
  : resolve("tests/visual-harness/screenshots");
const debugPort = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
await mkdir(target, { recursive: true });
function listPages() {
  return new Promise((resolvePages, reject) => httpGet(`http://127.0.0.1:${debugPort}/json/list`, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => {
      try { resolvePages(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (error) { reject(error); }
    });
  }).on("error", reject));
}
const [page] = (await listPages()).filter((item) => item.type === "page");
assert.ok(page, "Chrome must expose a DevTools page on port 9223");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, reject) => {
  socket.addEventListener("open", resolveOpen, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
function command(method, params = {}) {
  return new Promise((resolveCommand, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve: resolveCommand, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

await command("Page.enable");
await command("Runtime.enable");
for (const width of [390, 768, 1280, 1440]) {
  await command("Emulation.setDeviceMetricsOverride", {
    width, height: 960, deviceScaleFactor: 1, mobile: false,
  });
  await command("Page.navigate", { url: "http://127.0.0.1:4179/?page=overview&range=30&sample=1" });
  await waitFor("document.body?.dataset.visualReady === 'true'", "Overview fixture render");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
  const metrics = await evaluate(`(() => {
    const rect = (element) => {
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return {x:Math.round(value.x),y:Math.round(value.y),width:Math.round(value.width),height:Math.round(value.height),right:Math.round(value.right),bottom:Math.round(value.bottom)};
    };
    const root = document.querySelector('.stockhub-overview');
    const cards = [...document.querySelectorAll('.stockhub-overview-sales-metrics .stockhub-overview-metric')];
    const grid = document.querySelector('.stockhub-overview-analysis-grid');
    const children = [...root.children].map((element) => element.matches('header') ? 'header'
      : element.classList.contains('stockhub-overview-metrics') ? 'kpis'
      : element.classList.contains('stockhub-overview-analysis-grid') ? 'analytics'
      : element.classList.contains('stockhub-overview-attention') ? 'inventory-attention'
      : element.classList.contains('stockhub-overview-recent') ? 'recent-imports' : element.tagName.toLowerCase());
    return {
      viewport:{width:window.innerWidth,height:window.innerHeight}, documentWidth:document.documentElement.scrollWidth,
      bodyWidth:document.body.scrollWidth, page:rect(root), children,
      cards:cards.map((element) => ({...rect(element),label:element.querySelector('.stockhub-metric-label')?.textContent?.trim()})),
      analytics:rect(grid), sales:rect(document.querySelector('.stockhub-overview-trend')),
      chart:{plot:rect(document.querySelector('.stockhub-chart-plot')),
        ticks:[...document.querySelectorAll('.stockhub-chart-y-axis span')].map((item)=>item.textContent.trim()),
        lineCount:document.querySelectorAll('.stockhub-chart-line').length,
        areaCount:document.querySelectorAll('.stockhub-chart-area').length,
        points:document.querySelectorAll('.stockhub-chart-point').length,
        measure:document.querySelector('.stockhub-chart-measure-label')?.textContent?.trim()},
      bestSellers:rect(document.querySelector('.stockhub-overview-best-sellers')),
      attention:rect(document.querySelector('.stockhub-overview-attention')),
      recent:rect(document.querySelector('.stockhub-overview-recent')),
      attentionRows:document.querySelectorAll('.stockhub-overview-attention-list > li').length,
      attentionText:[...document.querySelectorAll('.stockhub-overview-attention-list > li')].map((item)=>item.innerText.trim()),
      sampleBadge:document.querySelector('.stockhub-overview-sample-badge')?.textContent?.trim(),
      historyLink:(()=>{const link=document.querySelector('.stockhub-overview-recent .stockhub-overview-section-heading a');return {href:link?.getAttribute('href'),label:link?.textContent?.trim()};})(),
      giftCardRows:[...document.querySelectorAll('.stockhub-overview-attention-list li')].filter((row) => /gift card/i.test(row.innerText)).length,
      importRows:document.querySelectorAll('.stockhub-overview-import-list > li').length,
      importStatuses:[...document.querySelectorAll('.stockhub-overview-import-list .stockhub-status')].map((item) => item.textContent.trim()),
      fixtureNotice:document.querySelector('.stockhub-overview-sample-notice')?.textContent?.trim(),
      bodyBackground:getComputedStyle(document.body).backgroundColor,
      panelBackground:getComputedStyle(document.querySelector('.stockhub-overview-trend')).backgroundColor,
      textContrast:(()=>{const rgb=(value)=>value.match(/[0-9.]+/g)?.slice(0,3).map(Number)??[];
        const luminance=(value)=>{const channels=rgb(value).map((channel)=>channel/255).map((channel)=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4);
          return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];};
        const values=[luminance(getComputedStyle(document.body).color),luminance(getComputedStyle(document.body).backgroundColor)].sort((a,b)=>b-a);
        return (values[0]+.05)/(values[1]+.05);})(),
      statusContrasts:[...document.querySelectorAll('.stockhub-overview-import-list .stockhub-status')].map((item)=>{
        const style=getComputedStyle(item);
        const rgb=(value)=>value.match(/[0-9.]+/g)?.slice(0,3).map(Number)??[];
        const luminance=(value)=>{const channels=rgb(value).map((channel)=>channel/255).map((channel)=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4);
          return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];};
        const values=[luminance(style.color),luminance(style.backgroundColor)].sort((a,b)=>b-a);
        return (values[0]+.05)/(values[1]+.05);
      }),
    };
  })()`);
  assert.equal(metrics.viewport.width, width);
  assert.ok(metrics.documentWidth <= width && metrics.bodyWidth <= width, `no horizontal overflow at ${width}px`);
  assert.deepEqual(metrics.children, ["header", "kpis", "analytics", "inventory-attention", "recent-imports"], "approved page section hierarchy is intact");
  assert.equal(metrics.cards.length, 4, "four performance KPIs are rendered");
  assert.ok(metrics.cards.every((card) => card.x >= 0 && card.right <= width), `KPI cards fit ${width}px`);
  assert.ok(metrics.analytics.x >= 0 && metrics.analytics.right <= width, `analytics panels fit ${width}px`);
  assert.ok(metrics.attention.x >= 0 && metrics.attention.right <= width && metrics.recent.right <= width, `lower sections fit ${width}px`);
  assert.equal(metrics.attentionRows, 3, "Inventory Attention displays the top three rows");
  assert.ok(metrics.attentionText.every((row) => /\d[\d,]* sold/.test(row)), "sample attention rows show matched variant sales velocity");
  assert.equal(metrics.chart.ticks.length, 4, "Sales Performance shows a four-tick numeric axis");
  assert.match(metrics.chart.ticks[0], /\$/);
  assert.match(metrics.chart.measure, /USD sample currency/);
  assert.equal(metrics.chart.lineCount, 1, "Sales Performance renders its line");
  assert.equal(metrics.chart.areaCount, 1, "Sales Performance renders its area fill");
  assert.equal(metrics.chart.points, 30, "the 30-day line shows every sample day");
  if (width >= 1280) assert.ok(metrics.chart.plot.height >= 300, "the sales chart expands into the desktop analytics row");
  if (width <= 480) assert.ok(metrics.chart.plot.height >= 150, "the mobile sales chart keeps a usable minimum height");
  assert.equal(metrics.sampleBadge, "SAMPLE · USD");
  assert.equal(metrics.historyLink.href, "/app/imports/history");
  assert.match(metrics.historyLink.label, /View live history/);
  assert.equal(metrics.importStatuses.length, 5);
  assert.equal(metrics.giftCardRows, 0, "gift cards never appear in physical restock attention");
  assert.equal(metrics.importRows, 5, "sample preview demonstrates five deterministic import lifecycle states");
  assert.match(metrics.fixtureNotice, /SAMPLE DATA.*synthetic fixtures/s);
  assert.equal(metrics.bodyBackground, "rgb(245, 247, 250)", "the Overview uses the approved light canvas");
  assert.equal(metrics.panelBackground, "rgb(255, 255, 255)", "analytics panels use white surfaces");
  assert.ok(metrics.textContrast >= 4.5, "body text meets WCAG AA contrast against the page background");
  assert.ok(metrics.statusContrasts.every((ratio) => ratio >= 4.5), "status labels meet WCAG AA contrast");
  if (width >= 1280) assert.equal(new Set(metrics.cards.map((card) => card.y)).size, 1, "desktop KPIs use one row");
  if (width <= 768) assert.equal(new Set(metrics.cards.map((card) => card.y)).size, 2, "narrow screens use two KPI columns");
  if (width >= 1280) assert.ok(metrics.sales.width > metrics.bestSellers.width, "sales performance receives the wider desktop column");
  await writeFile(resolve(target, `overview-v2-${width}.json`), JSON.stringify(metrics, null, 2));

  const dimensions = await command("Page.getLayoutMetrics");
  const content = dimensions.cssContentSize;
  const shot = await command("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.ceil(content.width), height: Math.ceil(content.height), scale: 1 },
  });
  await writeFile(resolve(target, `overview-v2-${width}.png`), Buffer.from(shot.data, "base64"));

  await evaluate(`document.querySelector('.stockhub-ranking-switch button[aria-pressed="false"]')?.click()`);
  await waitFor(`document.querySelector('.stockhub-ranking-switch button[aria-pressed="true"]')?.textContent.trim() === 'Variants'`, "variant ranking switch");
  const variantCount = await evaluate(`document.querySelectorAll('.stockhub-overview-best-sellers ol > li').length`);
  assert.equal(variantCount, 5, "variant ranking is interactive and shows five entries");
  await evaluate(`document.querySelector('.stockhub-overview-range a[href*="range=7"]')?.click()`);
  await waitFor(`document.querySelector('.stockhub-overview-range a[aria-current="page"]')?.textContent.trim() === '7 days'`, "seven-day range switch");
  const previewRange = await evaluate(`window.__memorySearch`);
  assert.match(previewRange, /range=7/);
  assert.match(previewRange, /sample=1/, "range changes preserve sample mode");
  await evaluate(`document.querySelector('.stockhub-overview-range a[href*="range=30"]')?.click()`);
  await waitFor(`document.querySelector('.stockhub-overview-range a[aria-current="page"]')?.textContent.trim() === '30 days'`, "restore 30-day range");
}

await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
await command("Page.navigate", { url: "http://127.0.0.1:4179/?page=overview&range=30" });
await waitFor("document.body?.dataset.visualReady === 'true'", "live fixture import routes");
const liveImports = await evaluate(`[...document.querySelectorAll('.stockhub-overview-import-list a')].map((link) => ({href:link.getAttribute('href'),text:link.innerText,status:link.parentElement.querySelector('.stockhub-status')?.textContent.trim()}))`);
assert.ok(liveImports.some((row) => row.href === "/app/imports/history/fixture-inventory-1"), "inventory receipts use the receipt detail destination");
assert.ok(liveImports.some((row) => row.href === "/app/imports/catalog/fixture-catalog-1"), "catalog drafts use the catalog detail destination");
assert.ok(liveImports.some((row) => row.href === "/app/imports/catalog/fixture-catalog-1" && row.status === "Catalog execution complete"),
  "a completed CatalogExecutionOperation remains visibly distinct from an inventory completion");
assert.ok(liveImports.some((row) => row.status === "Previewed"), "Previewed remains distinct from Completed");
await writeFile(resolve(target, "overview-v2-live-import-links.json"), JSON.stringify(liveImports, null, 2));
socket.close();
console.log("Overview V2 screenshots and viewport metrics captured at 390, 768, 1280, and 1440px.");
