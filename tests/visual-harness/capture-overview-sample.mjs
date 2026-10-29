/* eslint-env node */
import assert from "node:assert/strict";

function assertSampleView(metrics, range, width) {
  const layout = JSON.parse(metrics.metrics);
  const overview = layout.overview;
  assert.equal(metrics.ready, "true");
  assert.equal(metrics.errors, undefined);
  assert.equal(overview.samplePreview, true);
  assert.equal(overview.range, range);
  assert.equal(overview.salesPoints, range);
  assert.equal(overview.chartLineCount, 1);
  assert.equal(overview.chartAreaCount, 1);
  assert.equal(overview.chartAxisTicks.length, 4);
  assert.match(overview.chartAxisTicks[0], /\$/);
  assert.match(overview.chartMeasureLabel, /USD sample currency/);
  assert.match(overview.sampleBadge, /SAMPLE · USD/);
  assert.equal(overview.salesNotices.length, 0);
  assert.equal(overview.salesRankingCount, 5);
  assert.equal(overview.attentionRows.length, 3);
  assert.ok(overview.attentionRows.every((row) => /\d[\d,]* sold/.test(row)), "sample attention uses matching variant sales IDs");
  assert.ok(overview.salesCards.every(({ value }) => value && value !== "Unavailable"));
  assert.match(overview.salesCards[0].value, /USD/);
  assert.ok(Number(overview.salesCards[1].value) > 0);
  assert.ok(Number(overview.salesCards[2].value) > 0);
  assert.ok(Number(overview.salesCards[3].value) > 0);
  assert.equal(overview.historyLink.href, "/app/imports/history");
  assert.match(overview.historyLink.label, /View live history/);
  assert.ok(layout.documentWidth <= width && layout.bodyWidth <= width);
  return overview;
}

export async function validateOverviewSample({ width, metrics, command, evaluate, waitFor, scrollToTop, writeFile, outputFile, captureRankingRegion }) {
  const overview = assertSampleView(metrics, 30, width);
  assert.match(metrics.body, /synthetic fixtures/);
  assert.match(overview.inventoryNotes.join(" "), /Unknown and untracked/);
  assert.ok(overview.salesTrend.y + overview.salesTrend.height <= overview.inventoryPanel.y, "analytics precede Inventory Attention");
  if (width >= 1280) assert.ok(overview.salesTrend.width > 500);

  await writeFile(outputFile(`overview-sample-30-${width}.json`), JSON.stringify(metrics, null, 2));
  await scrollToTop();
  const sample30Shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(outputFile(`overview-sample-30-${width}.png`), Buffer.from(sample30Shot.data, "base64"));
  await evaluate(`document.querySelector('.stockhub-overview-trend')?.scrollIntoView({block:'start', behavior:'instant'})`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const panelShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(outputFile(`overview-sample-30-panel-${width}.png`), Buffer.from(panelShot.data, "base64"));
  await captureRankingRegion("overview-sample-30-ranking", 30, width);

  await evaluate(`document.querySelector('.stockhub-overview-range a[href*="range=7"]')?.click()`);
  await waitFor(`document.querySelector('.stockhub-overview-range a[aria-current="page"]')?.textContent?.trim()==='7 days'`, "7-day sample range selector state");
  await waitFor(`window.__memorySearch.includes('sample=1')`, "sample mode preserved during range change");
  await evaluate(`window.__refreshVisualMetrics?.()`);
  const result = await evaluate(`({ready:document.body.dataset.visualReady,metrics:document.getElementById('visual-metrics')?.textContent,errors:document.querySelector('vite-error-overlay')?.shadowRoot?.innerText,search:window.__memorySearch})`);
  metrics = result.result.value;
  assert.match(metrics.search, /sample=1/);
  assertSampleView(metrics, 7, width);
  await writeFile(outputFile(`overview-sample-7-${width}.json`), JSON.stringify(metrics, null, 2));
  await scrollToTop();
  const sample7Shot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(outputFile(`overview-sample-7-${width}.png`), Buffer.from(sample7Shot.data, "base64"));
  await captureRankingRegion("overview-sample-7-ranking", 7, width);
  return metrics;
}
