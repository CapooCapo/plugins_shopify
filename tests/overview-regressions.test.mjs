/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const files = {
  route: source("app/routes/app._index.tsx"),
  dashboard: source("app/components/OverviewDashboard.tsx"),
  header: source("app/components/overview/OverviewHeader.tsx"),
  metrics: source("app/components/overview/OverviewMetrics.tsx"),
  sales: source("app/components/overview/SalesPerformance.tsx"),
  bestSellers: source("app/components/overview/BestSellers.tsx"),
  attention: source("app/components/overview/InventoryAttention.tsx"),
  recent: source("app/components/overview/RecentImports.tsx"),
  formats: source("app/components/overview/format.ts"),
  analytics: source("app/utils/overview-analytics-inventory.shared.ts"),
  fixtures: source("app/utils/overview-imports-demo.ts"),
  importReader: source("app/utils/overview-imports.server.ts"),
  storeReader: source("app/utils/overview-store.server.ts"),
  importStatus: source("app/utils/overview-import-status.ts"),
};
const loaded = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, value]) => [key, await value])));

test("Overview composition follows the approved section order and exposes only the four business KPIs", () => {
  const { dashboard, header, metrics, sales, bestSellers, attention, recent } = loaded;
  const order = ["OverviewHeader", "OverviewMetrics", "stockhub-overview-analysis-grid", "InventoryAttention", "RecentImports"];
  let offset = -1;
  for (const marker of order) {
    const next = dashboard.indexOf(marker, offset + 1);
    assert.ok(next > offset, `${marker} follows the preceding section`);
    offset = next;
  }
  assert.match(dashboard, /stockhub-overview-analysis-grid[\s\S]*<SalesPerformance[\s\S]*<BestSellers[\s\S]*<\/div>[\s\S]*<InventoryAttention/);
  assert.match(header, /StockHub[\s\S]*Overview[\s\S]*Store Overview/);
  assert.match(header, /7 days[\s\S]*30 days[\s\S]*Preview sample data[\s\S]*Refresh/);
  assert.match(metrics, /Net merchandise sales[\s\S]*Orders[\s\S]*Units sold[\s\S]*Low-stock SKUs/);
  assert.equal((metrics.match(/<Metric /g) ?? []).length, 4);
  assert.match(sales, /aria-pressed=\{measure === option\}/);
  assert.match(bestSellers, /useState/);
  assert.match(bestSellers, /stockhub-ranking-switch[\s\S]*role="group" aria-label="Best seller ranking type"/);
  assert.match(bestSellers, /<button type="button"/);
  assert.match(bestSellers, /onClick=\{\(\) => setRanking\("products"\)\}/);
  assert.match(bestSellers, /onClick=\{\(\) => setRanking\("variants"\)\}/);
  assert.match(bestSellers, /aria-pressed=\{ranking === "products"\}[\s\S]*Products/);
  assert.match(bestSellers, /aria-pressed=\{ranking === "variants"\}[\s\S]*Variants/);
  assert.match(bestSellers, /products\.slice\(0, 5\)/);
  assert.match(bestSellers, /variants\.slice\(0, 5\)/);
  assert.match(attention, /rankInventoryAttention/);
  assert.match(recent, /View live history/);
  assert.match(recent, /imports\?\.sample/);
  assert.doesNotMatch(`${dashboard}\n${attention}`, /Smart Restock/i);
  assert.doesNotMatch(dashboard, /Store snapshot|Execution attention|overview-shortcuts/);
});

test("route delegates tenant-scoped reads and sample preview bypasses both server readers", () => {
  const { route, importReader, storeReader } = loaded;
  assert.match(route, /authenticate\.admin\(request\)/);
  const sampleBranch = route.match(/if \(samplePreview\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  assert.ok(sampleBranch.includes("createSampleOverviewAnalytics"));
  assert.ok(sampleBranch.includes("createSampleOverviewImports"));
  assert.doesNotMatch(sampleBranch, /loadRecentOverviewImports|loadOverviewStoreData|admin\.graphql|prisma\./);
  assert.match(route, /loadRecentOverviewImports\(session\.shop\)/);
  assert.match(route, /loadOverviewStoreData\(admin\)/);
  assert.doesNotMatch(route, /where:\s*\{\s*shop\s*\}|admin\.graphql|prisma\./);
  assert.equal((importReader.match(/where:\s*\{\s*shop\s*\}/g) ?? []).length, 3,
    "receipt, catalog draft, and nested execution-operation reads each retain the authenticated tenant scope");
  assert.match(importReader, /take: 5/);
  assert.match(importReader, /\/app\/imports\/history\/\$\{encodeURIComponent\(batch\.id\)\}/);
  assert.match(importReader, /\/app\/imports\/catalog\/\$\{encodeURIComponent\(batch\.id\)\}/);
  assert.match(storeReader, /query StockHubOverview/);
  assert.match(storeReader, /shop \{ name myshopifyDomain ianaTimezone currencyCode \}/);
});

test("inventory attention preserves unknown, untracked, and non-physical distinctions", () => {
  const { analytics, attention } = loaded;
  assert.match(analytics, /variant\.product\.giftCard === true/);
  assert.match(analytics, /nonPhysicalCount/);
  assert.match(attention, /Unknown and untracked inventory is excluded, never treated as zero/);
  assert.match(attention, /gift-card variants are excluded from physical restock/);
  assert.match(attention, /analytics\.inventory\.status === "partial"/);
  assert.match(attention, /active, tracked locations only/);
});

test("sample preview is marked and catalog status cannot be mistaken for an inventory outcome", () => {
  const { header, sales, formats, fixtures, importStatus } = loaded;
  assert.match(header, /SAMPLE DATA/);
  assert.match(header, /synthetic fixtures/);
  assert.match(header, /stockhub-overview-sample-badge/);
  assert.match(header, /SAMPLE · USD/);
  assert.doesNotMatch(sales, /store currency · no FX conversion/,
    "live revenue is normalized to USD rather than displayed in the shop's native currency");
  assert.match(sales, /USD sample currency/);
  assert.match(sales, /stockhub-chart-y-axis/);
  assert.match(sales, /stockhub-chart-line/);
  assert.match(sales, /stockhub-chart-area/);
  assert.match(sales, /currencyCode \?\?/);
  assert.doesNotMatch(sales, /currencyCode \?\? "USD"/);
  assert.match(formats, /status === "PREVIEWED" \? "Previewed"/);
  assert.match(formats, /Catalog execution complete/);
  assert.match(formats, /Needs attention/);
  assert.match(formats, /Outcome uncertain/);
  assert.match(importStatus, /CATALOG_EXECUTION_COMPLETE/);
  assert.match(importStatus, /CATALOG_UNCERTAIN/);
  assert.match(importStatus, /CATALOG_ATTENTION/);
  assert.match(fixtures, /"PREVIEWED"/);
  assert.match(fixtures, /"DRAFT"/);
  assert.match(fixtures, /"MAPPING"/);
  assert.doesNotMatch(fixtures, /detailHref: "/,
    "illustrative receipt IDs do not link to nonexistent merchant detail routes");
});

test("light Overview styles preserve contrast, keyboard focus, responsiveness, and reduced motion", async () => {
  const css = await source("app/styles/stockhub/overview-dark.css");
  const analyticsCss = await source("app/styles/stockhub/overview-analytics.css");
  const responsiveCss = await source("app/styles/stockhub/responsive-layout.css");
  const stylesheet = await source("app/styles/stockhub.css");
  assert.match(css, /body\.stockhub-app-frame:has\(\.stockhub-overview\)/);
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /--stockhub-canvas:\s*#f5f7fa/);
  assert.match(css, /--stockhub-surface:\s*#ffffff/);
  assert.match(css, /\.stockhub-status--success[^}]*background:\s*#e8f5ee[^}]*color:\s*#1f6b45/);
  assert.match(css, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.stockhub-overview-analysis-grid \{[\s\S]*?grid-template-columns: minmax\(0, 2\.05fr\) minmax\(300px, 1fr\)/);
  assert.match(css, /@media \(max-width: 1000px\) \{[\s\S]*?\.stockhub-overview-analysis-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  const plotSelector = ".stockhub-overview .stockhub-chart-visual .stockhub-chart-plot";
  const selectorClassSpecificity = (plotSelector.match(/\.[\w-]+/g) ?? []).length;
  assert.equal(selectorClassSpecificity, 3);
  const desktopPlotStart = analyticsCss.indexOf(`${plotSelector} {`);
  const mobileMediaStart = analyticsCss.indexOf("@media (max-width: 1000px)", desktopPlotStart);
  const mobilePlotStart = analyticsCss.indexOf(`${plotSelector} {`, mobileMediaStart);
  assert.ok(desktopPlotStart >= 0 && desktopPlotStart < mobileMediaStart && mobileMediaStart < mobilePlotStart);
  const ruleBody = (cssText, ruleStart) => cssText.slice(cssText.indexOf("{", ruleStart) + 1, cssText.indexOf("}", ruleStart));
  assert.match(ruleBody(analyticsCss, desktopPlotStart), /flex:\s*0 0 300px;[\s\S]*height:\s*300px;[\s\S]*min-height:\s*300px/);
  assert.match(ruleBody(analyticsCss, mobilePlotStart), /flex:\s*0 0 220px;[\s\S]*height:\s*220px;[\s\S]*min-height:\s*220px/);
  assert.ok(analyticsCss.indexOf("}", mobilePlotStart) < analyticsCss.indexOf("\n}", mobileMediaStart));
  const importPosition = (path) => stylesheet.indexOf(`@import "${path}";`);
  assert.ok(importPosition("./stockhub/overview-analytics.css") < importPosition("./stockhub/responsive-layout.css"));
  assert.ok(importPosition("./stockhub/responsive-layout.css") < importPosition("./stockhub/overview-dark.css"));
  for (const laterCss of [responsiveCss, css]) {
    const laterPlotRules = [...laterCss.matchAll(/([^{}]*\.stockhub-chart-plot[^{}]*)\{([^{}]*)\}/g)];
    assert.ok(laterPlotRules.every(([, , declarations]) => !/\b(?:flex|height|min-height)\s*:/.test(declarations)));
  }
  assert.match(css, /:where\(a, button\):focus-visible\s*\{\s*outline:\s*3px solid #1e5ea8/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /@media \(max-width: 480px\)/);
});
