/* eslint-env node */
import assert from "node:assert/strict";

export async function validateOverviewLive({ width, metrics, layout, command, evaluate, waitFor, scrollToTop, writeFile, outputFile }) {
  const overview = layout.overview;
  assert.match(metrics.body, /Sales Performance/);
  assert.match(metrics.body, /Net merchandise sales/);
  assert.match(metrics.body, /LOCAL FIXTURE · NOT LIVE SHOPIFY ADMIN DATA/);
  assert.equal(overview.scenario, "ready");
  assert.equal(overview.range, 30);
  assert.equal(overview.salesCards.length, 4);
  assert.ok(overview.salesCards.every(({ value }) => value && value !== "Unavailable"));
  assert.equal(overview.salesPoints, 30, "one line-chart point is rendered for every shop-local day");
  assert.equal(overview.chartLineCount, 1);
  assert.equal(overview.chartAreaCount, 1);
  assert.equal(overview.chartAxisTicks.length, 4, "currency axis has four visible numeric ticks");
  assert.match(overview.chartMeasureLabel, /USD store currency · no FX conversion/);
  assert.deepEqual(overview.salesNotices, []);
  assert.equal(overview.salesRankingCount, 5);
  assert.equal(overview.attentionRows.length, 3);
  assert.ok(overview.attentionRows.every((row) => /\d[\d,]* sold/.test(row)), "matching sample variants display their ready sales velocity");
  assert.ok(overview.salesCards.every((card) => card.height >= 80 && card.height <= 160));
  if (width >= 1280) assert.equal(new Set(overview.salesCards.map((card) => card.y)).size, 1);
  else assert.equal(new Set(overview.salesCards.map((card) => card.y)).size, 2);

  await writeFile(outputFile(`overview-ready-local-fixture-${width}.json`), JSON.stringify(metrics, null, 2));
  await scrollToTop();
  const readyShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(outputFile(`overview-ready-local-fixture-${width}.png`), Buffer.from(readyShot.data, "base64"));

  await evaluate(`document.querySelector('.stockhub-overview-range a[href*="range=7"]')?.click()`);
  await waitFor(`document.querySelector('.stockhub-overview-range a[aria-current="page"]')?.textContent?.trim()==='7 days'`, "7-day analytics selector state");
  const rangeInteraction = await evaluate(`({search:window.__memorySearch,active:[...document.querySelectorAll('.stockhub-overview-range a')].filter(link=>link.getAttribute('aria-current')==='page').map(link=>link.textContent.trim())})`);
  assert.match(rangeInteraction.result.value.search, /range=7/);
  assert.deepEqual(rangeInteraction.result.value.active, ["7 days"]);
  await writeFile(outputFile(`overview-range-selector-local-fixture-${width}.json`), JSON.stringify(rangeInteraction.result.value, null, 2));

  await command("Page.navigate", { url: `http://127.0.0.1:4179/?page=overview&scenario=scope-missing&range=30` });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await waitFor(`document.body.dataset.visualReady==='true'`, "Overview missing-scope fixture measurement");
  let result = await command("Runtime.evaluate", {
    expression: `({ready:document.body.dataset.visualReady,metrics:document.getElementById('visual-metrics')?.textContent,body:document.body.innerText,errors:document.querySelector('vite-error-overlay')?.shadowRoot?.innerText})`,
    returnByValue: true,
  });
  metrics = result.result.value;
  assert.equal(metrics.ready, "true");
  assert.equal(metrics.errors, undefined);
  assert.match(metrics.body, /Sales analytics require the read_orders permission/);
  assert.match(metrics.body, /no order data was requested/i);
  const missingLayout = JSON.parse(metrics.metrics);
  assert.ok(missingLayout.documentWidth <= width);
  assert.equal(missingLayout.overview.salesCards[0].value, "Unavailable", "missing sales scope is not fabricated as zero");
  assert.equal(missingLayout.overview.salesCards[3].value, "2", "known inventory remains available when sales scope is missing");
  assert.equal(missingLayout.overview.salesNotices.length, 1);
  await writeFile(outputFile(`overview-scope-missing-local-fixture-${width}.json`), JSON.stringify(metrics, null, 2));
  await scrollToTop();
  const missingShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(outputFile(`overview-scope-missing-local-fixture-${width}.png`), Buffer.from(missingShot.data, "base64"));

  await command("Page.navigate", { url: "http://127.0.0.1:4179/?page=overview&scenario=empty&range=30" });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await waitFor(`document.body.dataset.visualReady==='true'`, "Overview live-empty fixture measurement");
  result = await command("Runtime.evaluate", {
    expression: `({ready:document.body.dataset.visualReady,metrics:document.getElementById('visual-metrics')?.textContent,body:document.body.innerText,errors:document.querySelector('vite-error-overlay')?.shadowRoot?.innerText})`,
    returnByValue: true,
  });
  metrics = result.result.value;
  const emptyLayout = JSON.parse(metrics.metrics);
  assert.equal(metrics.ready, "true");
  assert.equal(metrics.errors, undefined);
  assert.equal(emptyLayout.overview.samplePreview, false);
  assert.equal(emptyLayout.overview.salesCards[0].value, "USD 0.00");
  assert.deepEqual(emptyLayout.overview.salesNotices, []);
  assert.deepEqual(emptyLayout.overview.salesEmptyStates, ["No non-cancelled, non-test orders were created in this date range."]);
  assert.match(metrics.body, /No items have net units sold in this date range/);
  assert.equal(emptyLayout.overview.salesRankingCount, 0);
  assert.ok(emptyLayout.documentWidth <= width && emptyLayout.bodyWidth <= width);
  await writeFile(outputFile(`overview-live-empty-local-fixture-${width}.json`), JSON.stringify(metrics, null, 2));
  await scrollToTop();
  const emptyShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(outputFile(`overview-live-empty-local-fixture-${width}.png`), Buffer.from(emptyShot.data, "base64"));
}
