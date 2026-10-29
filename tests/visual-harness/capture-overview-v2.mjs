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
assert.ok(page, `Chrome must expose a DevTools page on port ${debugPort}`);
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
async function activateRanking(label, expectedRows, context) {
  const labelLiteral = JSON.stringify(label);
  await evaluate(`(() => [...document.querySelectorAll('.stockhub-ranking-switch button')]
    .find((button) => button.textContent.trim() === ${labelLiteral})?.click())()`);
  await waitFor(`document.querySelector('.stockhub-ranking-switch button[aria-pressed="true"]')?.textContent.trim() === ${labelLiteral}`, `${context}: ${label} selected`);
  const state = await evaluate(`({
    selected:document.querySelector('.stockhub-ranking-switch button[aria-pressed="true"]')?.textContent.trim(),
    pressed:[...document.querySelectorAll('.stockhub-ranking-switch button')].map((button)=>button.getAttribute('aria-pressed')),
    rows:document.querySelectorAll('.stockhub-overview-best-sellers ol > li').length,
    rowTexts:[...document.querySelectorAll('.stockhub-overview-best-sellers ol > li')].map((item)=>item.innerText.trim()),
    listLabel:document.querySelector('.stockhub-overview-best-sellers ol')?.getAttribute('aria-label')??'',
    notice:document.querySelector('.stockhub-overview-best-sellers .stockhub-analytics-notice')?.textContent?.trim()??'',
    message:document.querySelector('.stockhub-overview-best-sellers .stockhub-overview-message')?.textContent?.trim()??''
  })`);
  assert.equal(state.selected, label, `${context} exposes ${label} as selected`);
  assert.deepEqual(state.pressed, label === "Products" ? ["true", "false"] : ["false", "true"], `${context} updates aria-pressed for ${label}`);
  assert.equal(state.rows, expectedRows, `${context} renders the truthful ${label.toLowerCase()} row count`);
  if (expectedRows > 0) assert.match(state.listLabel, new RegExp(`^Top ${label.toLowerCase()} by net units sold$`));
  else assert.equal(state.listLabel, "", `${context} does not render an empty ranking list`);
  return state;
}

await command("Page.enable");
await command("Runtime.enable");
for (const width of [390, 768, 1001, 1280, 1440]) {
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
    const analysisGrid = document.querySelector('.stockhub-overview-analysis-grid');
    const children = [...root.children].map((element) => element.matches('header.stockhub-overview-header') ? 'header'
      : element.classList.contains('stockhub-overview-metrics') ? 'kpis'
      : element.classList.contains('stockhub-overview-analysis-grid') ? 'analysis-grid'
      : element.classList.contains('stockhub-overview-attention') ? 'inventory-attention'
      : element.classList.contains('stockhub-overview-recent') ? 'recent-imports' : element.tagName.toLowerCase());
    const analysisChildren = [...analysisGrid.children].map((element) => element.classList.contains('stockhub-overview-trend') ? 'sales-performance'
      : element.classList.contains('stockhub-overview-best-sellers') ? 'best-sellers' : element.tagName.toLowerCase());
    return {
      viewport:{width:window.innerWidth,height:window.innerHeight}, documentWidth:document.documentElement.scrollWidth,
      bodyWidth:document.body.scrollWidth, page:rect(root), children,
      externalResources:performance.getEntriesByType('resource').map((entry)=>entry.name).filter((url)=>new URL(url,location.href).origin!==location.origin),
      cards:cards.map((element) => ({...rect(element),label:element.querySelector('.stockhub-metric-label')?.textContent?.trim()})),
      kpiRow:rect(document.querySelector('.stockhub-overview-metrics')),
      analysisGrid:rect(analysisGrid), analysisChildren,
      analysisColumns:getComputedStyle(analysisGrid).gridTemplateColumns,
      sales:rect(document.querySelector('.stockhub-overview-trend')),
      bestSellers:rect(document.querySelector('.stockhub-overview-best-sellers')),
      rankingGroup:(()=>{const group=document.querySelector('.stockhub-ranking-switch');return {role:group?.getAttribute('role'),label:group?.getAttribute('aria-label')};})(),
      rankingSwitch:[...document.querySelectorAll('.stockhub-ranking-switch button')].map((button)=>({
        label:button.textContent.trim(), pressed:button.getAttribute('aria-pressed'), type:button.type,
        nativeButton:button.tagName === 'BUTTON' && button.tabIndex >= 0,
        visible:button.getBoundingClientRect().width > 0 && getComputedStyle(button).visibility !== 'hidden'})),
      rankingRows:document.querySelectorAll('.stockhub-overview-best-sellers ol > li').length,
      chart:{plot:rect(document.querySelector('.stockhub-chart-plot')),
        ticks:[...document.querySelectorAll('.stockhub-chart-y-axis span')].map((item)=>item.textContent.trim()),
        lineCount:document.querySelectorAll('.stockhub-chart-line').length,
        areaCount:document.querySelectorAll('.stockhub-chart-area').length,
        points:document.querySelectorAll('.stockhub-chart-point').length,
        measure:document.querySelector('.stockhub-chart-measure-label')?.textContent?.trim()},
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
      salesNotice:document.querySelector('.stockhub-overview-trend .stockhub-analytics-notice')?.textContent?.trim()??'',
      salesEmpty:document.querySelector('.stockhub-overview-trend .stockhub-analytics-empty')?.textContent?.trim()??'',
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
  assert.deepEqual(metrics.children, ["header", "kpis", "analysis-grid", "inventory-attention", "recent-imports"], "approved page section hierarchy is intact");
  assert.deepEqual(metrics.analysisChildren, ["sales-performance", "best-sellers"], "Sales Performance and Best Sellers share the primary analysis row");
  assert.equal(metrics.cards.length, 4, "four performance KPIs are rendered");
  assert.ok(metrics.cards.every((card) => card.x >= 0 && card.right <= width), `KPI cards fit ${width}px`);
  assert.ok(metrics.analysisGrid.x >= 0 && metrics.analysisGrid.right <= width, `shared analysis row fits ${width}px`);
  assert.ok(metrics.sales.x >= 0 && metrics.sales.right <= width && metrics.bestSellers.x >= 0 && metrics.bestSellers.right <= width, `analysis panels fit ${width}px`);
  assert.ok(metrics.analysisGrid.y >= metrics.kpiRow.bottom, "shared analysis row follows the KPI cards");
  assert.ok(metrics.analysisGrid.bottom <= metrics.attention.y, "Inventory Attention follows the shared analysis row");
  assert.ok(metrics.attention.bottom <= metrics.recent.y, "Recent Imports follows Inventory Attention");
  assert.ok(metrics.attention.x >= 0 && metrics.attention.right <= width && metrics.recent.right <= width, `lower sections fit ${width}px`);
  assert.deepEqual(metrics.rankingGroup, { role: "group", label: "Best seller ranking type" }, "ranking controls have an accessible group name");
  assert.deepEqual(metrics.rankingSwitch.map((button) => button.label), ["Products", "Variants"], "Product and Variant switch remains present");
  assert.ok(metrics.rankingSwitch.every((button) => button.visible), "ranking switch controls remain visible");
  assert.ok(metrics.rankingSwitch.every((button) => button.nativeButton && button.type === "button"), "ranking controls are focusable native buttons");
  assert.deepEqual(metrics.rankingSwitch.map((button) => button.pressed), ["true", "false"], "Products is initially selected accessibly");
  assert.equal(metrics.rankingRows, 5, "selected ranking shows the top five entries");
  if (width > 1000) {
    assert.ok(Math.abs(metrics.sales.y - metrics.bestSellers.y) <= 2, "desktop Sales Performance and Best Sellers share a row");
    assert.ok(metrics.sales.x < metrics.bestSellers.x, "desktop Sales Performance precedes Best Sellers horizontally");
    const chartShare = metrics.sales.width / (metrics.sales.width + metrics.bestSellers.width);
    assert.ok(chartShare >= 0.65 && chartShare <= 0.70, `desktop chart receives 65–70% of the row (actual ${(chartShare * 100).toFixed(2)}%)`);
  } else {
    assert.ok(Math.abs(metrics.sales.x - metrics.bestSellers.x) <= 2, "narrow analysis panels use one column");
    assert.ok(metrics.sales.bottom <= metrics.bestSellers.y, "narrow analysis panels stack vertically");
  }
  assert.deepEqual(metrics.externalResources, [], "sample preview makes no external resource requests");
  assert.equal(metrics.attentionRows, 3, "Inventory Attention displays the top three rows");
  assert.ok(metrics.attentionText.every((row) => /\d[\d,]* sold/.test(row)), "sample attention rows show matched variant sales velocity");
  assert.equal(metrics.chart.ticks.length, 4, "Sales Performance shows a four-tick numeric axis");
  assert.match(metrics.chart.ticks[0], /\$/);
  assert.match(metrics.chart.measure, /USD sample currency/);
  assert.equal(metrics.chart.lineCount, 1, "Sales Performance renders its line");
  assert.equal(metrics.chart.areaCount, 1, "Sales Performance renders its area fill");
  assert.equal(metrics.chart.points, 30, "the 30-day line shows every sample day");
  if (width > 1000) assert.ok(metrics.chart.plot.height >= 280 && metrics.chart.plot.height <= 320, `desktop chart plot measures 280–320px (actual ${metrics.chart.plot.height}px)`);
  else assert.ok(metrics.chart.plot.height >= 200 && metrics.chart.plot.height <= 240, `narrow chart plot is approximately 220px (actual ${metrics.chart.plot.height}px)`);
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

  await writeFile(resolve(target, `overview-v2-${width}.json`), JSON.stringify(metrics, null, 2));

  const dimensions = await command("Page.getLayoutMetrics");
  const content = dimensions.cssContentSize;
  const shot = await command("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.ceil(content.width), height: Math.ceil(content.height), scale: 1 },
  });
  await writeFile(resolve(target, `overview-v2-${width}.png`), Buffer.from(shot.data, "base64"));

  await evaluate(`document.querySelector('.stockhub-ranking-switch button:nth-child(2)')?.focus()`);
  assert.equal(await evaluate(`document.activeElement?.textContent?.trim()`), "Variants", "Variant control can receive focus");
  await activateRanking("Variants", 5, `sample preview at ${width}px`);
  await evaluate(`document.querySelector('.stockhub-ranking-switch button:nth-child(1)')?.focus()`);
  assert.equal(await evaluate(`document.activeElement?.textContent?.trim()`), "Products", "Product control can receive focus");
  await activateRanking("Products", 5, `sample preview at ${width}px`);
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
const liveState = await evaluate(`({scenario:new URLSearchParams(window.__memorySearch).get('scenario'),measure:document.querySelector('.stockhub-chart-measure-label')?.textContent?.trim(),ticks:[...document.querySelectorAll('.stockhub-chart-y-axis span')].map((item)=>item.textContent.trim()),badge:document.querySelector('.stockhub-overview-sample-badge')?.textContent?.trim()??'',notice:document.querySelector('.stockhub-overview-sample-notice')?.textContent?.trim()??'',salesNotice:document.querySelector('.stockhub-overview-trend .stockhub-analytics-notice')?.textContent?.trim()??'',salesEmpty:document.querySelector('.stockhub-overview-trend .stockhub-analytics-empty')?.textContent?.trim()??'',plotCount:document.querySelectorAll('.stockhub-chart-plot').length,rankingRows:document.querySelectorAll('.stockhub-overview-best-sellers ol > li').length,rankingNotice:document.querySelector('.stockhub-overview-best-sellers .stockhub-analytics-notice')?.textContent?.trim()??'',rankingMessage:document.querySelector('.stockhub-overview-best-sellers .stockhub-overview-message')?.textContent?.trim()??''})`);
assert.equal(liveState.scenario, null, "the default local fixture represents ready sales analytics");
assert.match(liveState.measure, /CAD store currency · no FX conversion/, "live local fixture uses its native currency and makes no FX conversion claim");
assert.ok(liveState.ticks[0].includes("CA$"), "live chart axis is formatted in fixture store currency");
assert.equal(liveState.badge, "", "live fixture is not labeled as sample preview");
assert.equal(liveState.notice, "", "live fixture does not show synthetic-data notice");
assert.equal(liveState.salesNotice, "", "ready sales has no partial or blocked notice");
assert.equal(liveState.salesEmpty, "", "ready sales has no empty state");
assert.ok(liveState.plotCount > 0, "ready sales renders its trend");
assert.equal(liveState.rankingRows, 5, "ready sales renders the top five product rows");
assert.equal(liveState.rankingNotice, "", "ready rankings have no partial notice");
assert.equal(liveState.rankingMessage, "", "ready rankings have no empty or blocked message");
await writeFile(resolve(target, "overview-v2-live-import-links.json"), JSON.stringify({ imports: liveImports, ...liveState }, null, 2));

const exceptionalScenarios = [
  { scenario: "blocked", expectedRows: { Products: 0, Variants: 0 } },
  { scenario: "ready-empty", expectedRows: { Products: 0, Variants: 0 } },
  { scenario: "partial", expectedRows: { Products: 3, Variants: 4 } },
];
for (const { scenario, expectedRows } of exceptionalScenarios) {
  await command("Page.navigate", { url: `http://127.0.0.1:4179/?page=overview&range=30&scenario=${scenario}` });
  await waitFor(`document.body?.dataset.visualReady === 'true' && new URLSearchParams(window.__memorySearch ?? '').get('scenario') === '${scenario}'`, `${scenario} analytics fixture render`);
  const state = await evaluate(`({scenario:new URLSearchParams(window.__memorySearch).get('scenario'), notice:document.querySelector('.stockhub-overview-trend .stockhub-analytics-notice')?.textContent?.trim()??'', empty:document.querySelector('.stockhub-overview-trend .stockhub-analytics-empty')?.textContent?.trim()??'', plotCount:document.querySelectorAll('.stockhub-chart-plot').length, ranking:{notice:document.querySelector('.stockhub-overview-best-sellers .stockhub-analytics-notice')?.textContent?.trim()??'',message:document.querySelector('.stockhub-overview-best-sellers .stockhub-overview-message')?.textContent?.trim()??'',rows:document.querySelectorAll('.stockhub-overview-best-sellers ol > li').length,rowLabels:[...document.querySelectorAll('.stockhub-overview-best-sellers ol > li')].map((item)=>item.innerText.trim())}, attention:{rows:document.querySelectorAll('.stockhub-overview-attention-list > li').length,velocities:[...document.querySelectorAll('.stockhub-attention-velocity')].map((item)=>item.textContent.trim())}, group:(()=>{const group=document.querySelector('.stockhub-ranking-switch');return {role:group?.getAttribute('role'),label:group?.getAttribute('aria-label')};})(), controls:[...document.querySelectorAll('.stockhub-ranking-switch button')].map((button)=>({label:button.textContent.trim(),pressed:button.getAttribute('aria-pressed'),tag:button.tagName,type:button.type,tabIndex:button.tabIndex}))})`);
  assert.equal(state.scenario, scenario);
  assert.deepEqual(state.group, { role: "group", label: "Best seller ranking type" }, `${scenario} exposes a named ranking control group`);
  assert.deepEqual(state.controls.map((button) => button.label), ["Products", "Variants"], `${scenario} keeps both ranking choices available`);
  assert.ok(state.controls.every((button) => button.tag === "BUTTON" && button.type === "button" && button.tabIndex >= 0), `${scenario} uses focusable native buttons`);
  assert.deepEqual(state.controls.map((button) => button.pressed), ["true", "false"], `${scenario} starts with Products selected`);
  for (const label of ["Products", "Variants"]) {
    const focusResult = await evaluate(`(() => {const button=[...document.querySelectorAll('.stockhub-ranking-switch button')].find((item)=>item.textContent.trim()===${JSON.stringify(label)});button?.focus();return document.activeElement?.textContent?.trim()})()`);
    assert.equal(focusResult, label, `${scenario} ${label} button receives focus`);
  }
  assert.equal(state.ranking.rows, expectedRows.Products, `${scenario} initially renders only available product rows`);
  if (scenario === "blocked") {
    assert.match(state.notice, /read_orders permission/);
    assert.match(state.empty, /unavailable until Shopify access/);
    assert.equal(state.plotCount, 0, "blocked access does not render fabricated chart data");
    assert.match(state.ranking.message, /Sales analytics require the read_orders permission/);
    assert.equal(state.ranking.notice, "");
  } else if (scenario === "ready-empty") {
    assert.equal(state.notice, "", "ready-empty sales does not appear blocked");
    assert.match(state.empty, /No non-cancelled, non-test orders/);
    assert.equal(state.plotCount, 0, "ready-empty analytics shows an empty state, not a synthetic chart");
    assert.match(state.ranking.message, /No products have net units sold/);
    assert.equal(state.ranking.notice, "");
    assert.ok(state.attention.velocities.every((value) => value === "0 sold"),
      "ready-empty Inventory Attention never retains stale positive demand and shows zero sales for every rendered row");
  } else {
    assert.match(state.notice, /Only part of the order history was retrieved/);
    assert.equal(state.empty, "", "partial sales data is retained rather than replaced with an empty state");
    assert.ok(state.plotCount > 0, "partial sales retains its available trend data");
    assert.match(state.ranking.notice, /Only part of the order history was retrieved/);
    assert.equal(state.ranking.message, "", "partial ranking data is not described as empty");
    assert.ok(state.ranking.rowLabels.some((row) => /Field Canvas Tote|Trail Insulated Bottle/.test(row)), "partial state retains real ranking row content");
  }
  const activations = [];
  for (const label of ["Variants", "Products"]) {
    const ranking = await activateRanking(label, expectedRows[label], scenario);
    activations.push(ranking);
    if (scenario === "blocked") {
      assert.match(ranking.message, /Sales analytics require the read_orders permission/);
      assert.equal(ranking.notice, "", `${scenario} continues to show its blocked explanation`);
    } else if (scenario === "ready-empty") {
      assert.match(ranking.message, new RegExp(`^No ${label.toLowerCase()} have net units sold`), `${scenario} explains the selected empty ranking`);
      assert.equal(ranking.notice, "", `${scenario} does not show a blocked or partial ranking notice`);
    } else {
      assert.match(ranking.notice, /Only part of the order history was retrieved/, `${scenario} retains the partial ranking notice`);
      assert.equal(ranking.message, "", `${scenario} does not describe available ranking rows as empty`);
      assert.equal(ranking.rowTexts.length, expectedRows[label], `${scenario} retains the selected available row data`);
    }
  }
  await writeFile(resolve(target, `overview-v2-${scenario}.json`), JSON.stringify({ ...state, activations }, null, 2));
}
socket.close();
console.log("Overview V2 screenshots and viewport metrics captured at 390, 768, 1280, and 1440px; ready, blocked, ready-empty, and partial sales states checked. Ranking activation uses DOM button clicks; native button semantics, group naming, and focusability are asserted, but trusted keyboard input is not simulated.");
