import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { OverviewDashboard } from "../../app/components/OverviewDashboard";
import type { OverviewAnalytics } from "../../app/utils/overview-analytics.server";
import { ProductsCatalog } from "../../app/components/ProductsCatalog";
import { matchedSkuProduct, pageInfo, products } from "./products-fixture";
import "../../app/styles/stockhub.css";

const data = {
  shop: { name: "Example Outfitters", myshopifyDomain: "example-outfitters.myshopify.com" },
  all: { count: 27, precision: "EXACT" as const },
  active: { count: 15, precision: "EXACT" as const },
  draft: { count: 11, precision: "EXACT" as const },
};

const imports = {
  batchCount: 14,
  attentionBatchCount: 3,
  recent: [
    { id: "fixture-1", receiptCode: "IMP-00214", locationName: "Main warehouse", createdAt: new Date("2026-10-22T08:00:00Z"), status: "COMPLETED" },
    { id: "fixture-2", receiptCode: "IMP-00213", locationName: "East branch", createdAt: new Date("2026-10-21T07:00:00Z"), status: "UNCERTAIN" },
    { id: "fixture-3", receiptCode: "IMP-00212", locationName: "Main warehouse", createdAt: new Date("2026-10-20T07:00:00Z"), status: "FAILED" },
  ],
  attention: [
    { id: "fixture-2", receiptCode: "IMP-00213", locationName: "East branch", createdAt: new Date("2026-10-21T07:00:00Z"), updatedAt: new Date("2026-10-22T07:00:00Z"), status: "UNCERTAIN" },
    { id: "fixture-3", receiptCode: "IMP-00212", locationName: "Main warehouse", createdAt: new Date("2026-10-20T07:00:00Z"), updatedAt: new Date("2026-10-20T07:00:00Z"), status: "FAILED" },
  ],
};

const fixtureDaily = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 8, 29 + index)).toISOString().slice(0, 10);
  return { date, revenue: 120 + index * 8, orders: 2 + (index % 4), units: 3 + (index % 7) };
});

function overviewAnalytics(range: 7 | 30, missingSalesScope: boolean): OverviewAnalytics {
  const daily = fixtureDaily.slice(-range);
  const salesData = {
    status: "ready" as const,
    reason: undefined,
    currencyCode: "USD",
    totals: daily.reduce((totals, day) => ({
      revenue: totals.revenue + (day.revenue ?? 0),
      orders: totals.orders + day.orders,
      units: totals.units + day.units,
    }), { revenue: 0, orders: 0, units: 0 }),
    daily,
    topProducts: [
      { id: "gid://shopify/Product/101", title: "Everyday Linen Shirt", legacyResourceId: "101", units: 42, revenue: 1840 },
      { id: "gid://shopify/Product/102", title: "Canvas Tote", legacyResourceId: "102", units: 31, revenue: 620 },
      { id: "gid://shopify/Product/103", title: "Merino Cardigan", legacyResourceId: "103", units: 18, revenue: 2160 },
    ],
    topVariants: [
      { id: "gid://shopify/ProductVariant/1011", productId: "gid://shopify/Product/101", productTitle: "Everyday Linen Shirt", legacyResourceId: "1011", title: "S / Natural", sku: "LINEN-S-NAT", units: 21, revenue: 920 },
      { id: "gid://shopify/ProductVariant/1012", productId: "gid://shopify/Product/101", productTitle: "Everyday Linen Shirt", legacyResourceId: "1012", title: "M / Natural", sku: "LINEN-M-NAT", units: 21, revenue: 920 },
      { id: "gid://shopify/ProductVariant/1021", productId: "gid://shopify/Product/102", productTitle: "Canvas Tote", legacyResourceId: "1021", title: "One size", sku: "TOTE-CANVAS", units: 31, revenue: 620 },
    ],
    currencyMismatch: false,
  };
  const inventoryData = {
    status: "ready" as const,
    threshold: 5,
    lowStockSkuCount: 2,
    outOfStockSkuCount: 1,
    lowStockVariants: [
      { id: "gid://shopify/ProductVariant/5011", title: "Small / Forest", sku: "MUG-FOREST-S", product: { id: "gid://shopify/Product/501", title: "Stoneware Mug", legacyResourceId: "501" }, available: 2 },
      { id: "gid://shopify/ProductVariant/5021", title: "One size", sku: "TOTE-NATURAL", product: { id: "gid://shopify/Product/502", title: "Market Tote", legacyResourceId: "502" }, available: 4 },
    ],
    outOfStockVariants: [
      { id: "gid://shopify/ProductVariant/5031", title: "Black", sku: "CAP-BLK", product: { id: "gid://shopify/Product/503", title: "Cotton Cap", legacyResourceId: "503" }, available: 0 },
    ],
    unknownCount: 1,
    untrackedCount: 2,
    totalTrackedKnown: 128,
  };
  const fetchedAt = "2026-10-28T12:00:00.000Z";
  // The ready sales fixture represents both required grants: read_orders and
  // read_products (the service also selects Product/Variant identity).
  return {
    range,
    timeZone: "America/New_York",
    currencyCode: "USD",
    scopesVerified: true,
    salesMissingScopes: missingSalesScope ? ["read_orders"] : [],
    inventoryMissingScopes: [],
    sales: missingSalesScope
      ? { status: "permission_required", data: null, message: "Sales analytics require the read_orders permission. Reauthorize StockHub after granting it; no order data was requested.", fetchedAt: null }
      : { status: "ready", data: salesData, fetchedAt },
    inventory: { status: "ready", data: inventoryData, fetchedAt },
    fetchedAt,
  };
}

function OverviewFixture() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const range = params.get("range") === "7" ? 7 : 30;
  const missingSalesScope = params.get("scenario") === "scope-missing";
  return <div className="visual-fixture-shell">
    <aside className="visual-fixture-badge" role="note" style={{ textAlign: "center", padding: "5px 8px", background: "#fff4ce", color: "#4a3b00", font: "600 10px/1.4 system-ui, sans-serif", borderBottom: "1px solid #e8d89a" }}>
      LOCAL FIXTURE · NOT LIVE SHOPIFY ADMIN DATA
    </aside>
    <s-page inlineSize="large"><OverviewDashboard
      data={data}
      error={null}
      imports={imports}
      analytics={overviewAnalytics(range, missingSalesScope)}
    /></s-page>
  </div>;
}

import NewImport from "../../app/routes/app.imports._index";
import CatalogImports from "../../app/routes/app.imports.catalog._index";
import CatalogImportDetail from "../../app/routes/app.imports.catalog.$batchId";
import ImportBatchDetail from "../../app/routes/app.imports.history.$batchId";
import { ImportDirtyContext } from "../../app/import-dirty-context";
import { newImportFixture } from "./new-import-fixture";
import { ReceiptActionsFixture, receiptActionsFixtureAction } from "./ReceiptActionsFixture";
import { receiptDetailFixtureAction, receiptDetailFixtureLoader } from "./receipt-detail-fixture";
import { catalogDetailAction, catalogDetailLoader, catalogListAction, catalogListLoader, hydrateCatalogFixtures, resetCatalogFixtures } from "./catalog-fixture";

const selectedPage = new URLSearchParams(location.search).get("page") ?? "overview";
const skuMode = new URLSearchParams(location.search).get("mode") === "sku";

if (selectedPage === "catalog" && new URLSearchParams(location.search).get("resetCatalog") === "1") {
  resetCatalogFixtures();
  history.replaceState(null, "", "/?page=catalog");
} else if (selectedPage === "catalog") {
  hydrateCatalogFixtures();
}
const catalogBatchId = new URLSearchParams(location.search).get("batchId");
const initialPath = selectedPage === "overview" ? `/app${location.search}` : selectedPage === "products" ? "/app/products" : selectedPage === "new-import" ? "/app/imports" : selectedPage === "receipt-actions" ? "/app/receipt-actions" : selectedPage === "receipt-detail" ? "/app/imports/history/fixture-receipt-001" : selectedPage === "catalog" ? catalogBatchId ? `/app/imports/catalog/${encodeURIComponent(catalogBatchId)}` : "/app/imports/catalog" : "/app";

const router = createMemoryRouter([
  {
    path: "/app",
    element: <OverviewFixture />,
  },
  {
    path: "/app/products",
    element: <s-page inlineSize="large">
      <ProductsCatalog
        products={skuMode ? [matchedSkuProduct] : products}
        pageInfo={pageInfo}
        search={skuMode ? "MATCH-204" : ""}
        searchBy={skuMode ? "sku" : "name"}
        statusFilter="all"
        pageSize={25}
        shop="example-outfitters.myshopify.com"
        currencyCode="USD"
        error={null}
      />
    </s-page>,
  },
  {
    path: "/app/imports",
    element: <s-page heading="Imports" inlineSize="large">
      <div className="stockhub-page stockhub-import-workspace">
        <nav className="stockhub-import-tabs" aria-label="Import pages">
          <div className="stockhub-import-tab-actions">
            <s-button href="/app/imports" variant="primary">New Import</s-button>
            <s-button href="/app/imports/history" variant="secondary">Import History</s-button>
            <s-button href="/app/imports/activity" variant="secondary">Activity History</s-button>
          </div>
        </nav>
        <div className="stockhub-import-content">
          <ImportDirtyContext.Provider value={{ setNewImportDirty: () => {} }}>
            <NewImport />
          </ImportDirtyContext.Provider>
        </div>
      </div>
    </s-page>,
    loader: () => newImportFixture,
  },
  {
    path: "/app/receipt-actions",
    element: <s-page inlineSize="large"><ReceiptActionsFixture /></s-page>,
    action: receiptActionsFixtureAction,
  },
  {
    path: "/app/imports/history/:batchId",
    element: <s-page inlineSize="large"><ImportBatchDetail /></s-page>,
    loader: receiptDetailFixtureLoader,
    action: receiptDetailFixtureAction,
  },
  {
    path: "/app/imports/catalog",
    element: <s-page heading="Product Catalog CSV" inlineSize="large"><CatalogImports /></s-page>,
    loader: catalogListLoader,
    action: catalogListAction,
  },
  {
    path: "/app/imports/catalog/:batchId",
    element: <s-page heading="Product Catalog Draft" inlineSize="large"><CatalogImportDetail /></s-page>,
    loader: catalogDetailLoader,
    action: catalogDetailAction,
  },
], { initialEntries: [initialPath] });

Object.assign(window, { __memoryPath: router.state.location.pathname, __memorySearch: router.state.location.search, __shopifyMutationCalls: 0 });
router.subscribe((state) => Object.assign(window, { __memoryPath: state.location.pathname, __memorySearch: state.location.search }));

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);

function measure() {
  const routeSearch = (window as Window & { __memorySearch?: string }).__memorySearch ?? location.search;
  const overviewParams = new URLSearchParams(routeSearch);
  const box = (selector: string) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const cards = [...document.querySelectorAll(".stockhub-overview-metric")].map((element) => {
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  });
  const metrics = {
    viewport: { width: innerWidth, height: innerHeight },
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    page: box("s-page"),
    content: box(".stockhub-overview"),
    header: box(".stockhub-overview-header"),
    cards,
    overview: selectedPage === "overview" ? {
      scenario: overviewParams.get("scenario") ?? "ready",
      range: overviewParams.get("range") === "7" ? 7 : 30,
      salesCards: [...document.querySelectorAll(".stockhub-overview-sales-metrics .stockhub-overview-metric")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.querySelector(".stockhub-metric-label")?.textContent?.trim(), value: element.querySelector(".stockhub-metric-value")?.textContent?.trim(), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      }),
      snapshotCards: [...document.querySelectorAll(".stockhub-overview-section:not(.stockhub-overview-analytics) .stockhub-overview-metric")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.querySelector(".stockhub-metric-label")?.textContent?.trim(), value: element.querySelector(".stockhub-metric-value")?.textContent?.trim(), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      }),
      rangeControls: [...document.querySelectorAll(".stockhub-overview-range a")].map((element) => ({ label: element.textContent?.trim(), href: element.getAttribute("href"), current: element.getAttribute("aria-current") })),
      salesNotices: [...document.querySelectorAll(".stockhub-overview-analytics .stockhub-analytics-notice")].map((element) => element.textContent?.trim()),
      salesTrend: box(".stockhub-overview-trend"),
      salesBars: document.querySelectorAll(".stockhub-chart-bar-track").length,
      salesRankingCount: document.querySelectorAll(".stockhub-overview-ranking-grid ol > li").length,
      lowStockRows: document.querySelectorAll('.stockhub-overview-inventory-list[aria-label="Low-stock SKUs and variants"] > li').length,
      outOfStockRows: document.querySelectorAll('.stockhub-overview-inventory-list[aria-label="Out-of-stock SKUs"] > li').length,
      inventoryCounts: [...document.querySelectorAll(".stockhub-overview-inventory .stockhub-inventory-summary > div")].map((element) => element.textContent?.trim()),
      shopCurrency: document.querySelector(".stockhub-overview-currency")?.textContent?.trim() ?? "",
      fixtureLabel: document.querySelector(".visual-fixture-badge")?.textContent?.trim() ?? "",
    } : null,
    quickActions: box(".stockhub-overview-shortcuts"),
    overviewWorkspace: box(".stockhub-overview-workspace"),
    attention: box(".stockhub-overview-attention"),
    recentImports: box(".stockhub-overview-recent"),
    primaryActionCount: document.querySelectorAll('.stockhub-overview-header-tools s-button[href="/app/imports"]').length,
    quickActionLinkCount: document.querySelectorAll(".stockhub-overview-shortcuts a").length,
    polarisPageDefined: !!customElements.get("s-page"),
    polarisButtonDefined: !!customElements.get("s-button"),
    products: selectedPage === "products" ? {
      header: box(".stockhub-products-header"),
      content: box(".stockhub-products"),
      toolbar: box(".stockhub-products-filters"),
      filterForm: box(".stockhub-products-filter-form"),
      table: box(".stockhub-products-table"),
      columns: [...document.querySelectorAll(".stockhub-products-table thead th")].map((element) => element.textContent?.trim()),
      rows: [...document.querySelectorAll(".stockhub-product-row")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { y: Math.round(rect.y), height: Math.round(rect.height), text: element.textContent?.trim(),
          actionLinks: element.querySelectorAll('a[href*="/admin/products/"]').length,
          actionTargetHeights: [...element.querySelectorAll('.stockhub-product-actions :is(button, a)')]
            .map((target) => Math.round(target.getBoundingClientRect().height)),
          fullTitle: element.querySelector('.stockhub-product-identity-text strong')?.getAttribute('title') };
      }),
      expandedDetailRows: document.querySelectorAll(".stockhub-product-detail-row").length,
      paginationHrefs: [...document.querySelectorAll(".stockhub-products-pagination s-button[href]")]
        .map((element) => element.getAttribute("href")),
      skuCells: [...document.querySelectorAll(".stockhub-product-row .stockhub-product-sku")]
        .map((element) => element.textContent?.trim()),
      inventoryCells: [...document.querySelectorAll(".stockhub-product-row .stockhub-product-inventory")]
        .map((element) => element.textContent?.trim()),
    } : null,
    newImport: selectedPage === "new-import" ? {
      header: box(".stockhub-hero-panel"),
      content: box(".stockhub-import-new"),
      form: box("#import-preview-form"),
      stepper: box('s-grid[accessibilityLabel="Import workflow"]'),
      dropzone: box(".stockhub-dropzone"),
      fileInput: !!document.getElementById("csv-file"),
      locationSelect: !!document.getElementById("location-id"),
      validateButton: !!document.querySelector('s-button[type="submit"]'),
      guidanceCard: box(".stockhub-guidance-card"),
    } : null,
    catalog: selectedPage === "catalog" ? {
      route: (window as Window & { __memoryPath?: string }).__memoryPath ?? location.pathname,
      pageWidth: document.documentElement.scrollWidth,
      tableRegions: [...document.querySelectorAll<HTMLElement>(".stockhub-catalog-table-wrap")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.getAttribute("aria-label"), tabIndex: element.tabIndex,
          width: Math.round(rect.width), right: Math.round(rect.right), clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth, tableWidth: element.querySelector("table")?.getBoundingClientRect().width ?? 0 };
      }),
      fieldCount: document.querySelectorAll(".stockhub-catalog-field input").length,
      fieldRects: [...document.querySelectorAll<HTMLElement>(".stockhub-catalog-field")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), right: Math.round(rect.right) };
      }),
      rowCardCount: document.querySelectorAll(".stockhub-catalog-row-card").length,
      rowStatuses: [...document.querySelectorAll(".stockhub-catalog-row-card > p strong")].map((element) => element.textContent?.trim()),
      zeroConfirmationCount: document.querySelectorAll('.stockhub-catalog-confirm-zero input[type="checkbox"]').length,
      fileInput: !!document.getElementById("catalog-file"),
      previewButton: !!document.querySelector('button[value="preview-mapping"]'),
      shopifyMutationCalls: (window as Window & { __shopifyMutationCalls?: number }).__shopifyMutationCalls ?? 0,
    } : null,
    receiptActions: selectedPage === "receipt-actions" ? (() => {
      const host = document.querySelector<HTMLElement>(".stockhub-merge-action s-button");
      const innerButton = host?.shadowRoot?.querySelector<HTMLButtonElement>("button");
      const searchField = document.querySelector("s-text-field[label=\"Search line items\"]");
      const searchInput = searchField?.shadowRoot?.querySelector<HTMLInputElement>("input");
      const style = (element: Element | null) => {
        if (!element) return null;
        const computed = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          display: computed.display,
          visibility: computed.visibility,
          opacity: computed.opacity,
          overflowX: computed.overflowX,
          overflowY: computed.overflowY,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
          clientRectCount: element.getClientRects().length,
        };
      };
      const ancestors: ReturnType<typeof style>[] = [];
      for (let node = host?.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        ancestors.push(style(node));
      }
      return {
        summary: (() => {
          const cards = document.querySelectorAll(".stockhub-receipt-summary-card");
          const region = document.querySelector<HTMLElement>(".stockhub-receipt-progress-summary");
          const rect = region?.getBoundingClientRect();
          return {
            width: rect?.width ?? 0,
            scrollWidth: region?.scrollWidth ?? 0,
            cardCount: cards.length,
            labels: [...document.querySelectorAll(".stockhub-receipt-summary-card > span")].map((element) => element.textContent?.trim()),
            zeroEligibleTerminal: document.querySelector(".stockhub-receipt-terminal")?.textContent?.trim() ?? "",
            mergeActionCount: document.querySelectorAll(".stockhub-merge-action").length,
            warningCount: document.querySelectorAll("s-banner[tone=critical], s-banner[tone=warning]").length,
          };
        })(),
        customElementDefined: !!customElements.get("s-button"),
        searchLabel: searchField?.getAttribute("label"),
        searchFieldRect: searchInput ? (() => {
          const rect = searchInput.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom };
        })() : null,
        variant: host?.getAttribute("variant"),
        host: style(host),
        shadowButton: style(innerButton ?? null),
        ancestors,
      };
    })() : null,
    receiptDetail: selectedPage === "receipt-detail" ? (() => {
      const tableWrap = document.querySelector<HTMLElement>(".stockhub-lines-table-wrap");
      const table = document.querySelector<HTMLTableElement>(".stockhub-lines-table");
      const mobileList = document.querySelector<HTMLElement>(".stockhub-mobile-lines");
      const actionSelector = innerWidth <= 760 ? ".stockhub-mobile-lines" : ".stockhub-lines-table-wrap";
      const rect = (element: Element) => {
        const value = element.getBoundingClientRect();
        return { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height), right: Math.round(value.right), bottom: Math.round(value.bottom) };
      };
      return {
        header: box(".stockhub-receipt-header"),
        previewNote: document.querySelector(".stockhub-receipt-draft-note")?.textContent?.trim() ?? "",
        qualitySummary: box(".stockhub-quality-summary"),
        qualityCards: [...document.querySelectorAll<HTMLButtonElement>(".stockhub-draft-status-summary button")].map((button) => ({ text: button.innerText.trim(), pressed: button.getAttribute("aria-pressed"), rect: rect(button) })),
        issueGroups: [...document.querySelectorAll<HTMLElement>(".stockhub-validation-issue-list > li")].map((item) => ({
          label: item.querySelector("strong")?.textContent?.trim() ?? "",
          count: item.querySelector(".stockhub-validation-issue-list__count")?.textContent?.trim() ?? "",
          action: item.querySelector("button")?.textContent?.trim() ?? "",
          actionRect: item.querySelector("button") ? rect(item.querySelector("button")!) : null,
        })),
        toolbar: box(".stockhub-line-toolbar"),
        toolbarSummary: document.querySelector(".stockhub-line-toolbar__summary")?.textContent?.trim() ?? "",
        searchValue: document.querySelector<HTMLInputElement>('s-text-field[label="Search line items"]')?.value ?? "",
        statusFilterValue: document.querySelector<HTMLSelectElement>('s-select[label="Quality status"]')?.value ?? "",
        operationFilterValue: document.querySelector<HTMLSelectElement>('s-select[label="Operation type"]')?.value ?? "",
        resultText: document.querySelector(".stockhub-line-results")?.textContent?.trim() ?? "",
        table: {
          display: tableWrap ? getComputedStyle(tableWrap).display : null,
          width: tableWrap?.clientWidth ?? 0,
          scrollWidth: tableWrap?.scrollWidth ?? 0,
          tableWidth: table ? rect(table).width : 0,
          headings: [...document.querySelectorAll<HTMLElement>(".stockhub-lines-table thead th")].map((heading) => ({
            label: heading.textContent?.trim() ?? "",
            ...rect(heading),
            clientWidth: heading.clientWidth,
            scrollWidth: heading.scrollWidth,
            whiteSpace: getComputedStyle(heading).whiteSpace,
          })),
          rows: [...document.querySelectorAll<HTMLTableRowElement>(".stockhub-lines-table tbody tr")].map((row) => ({
            height: Math.round(row.getBoundingClientRect().height),
            sku: row.querySelector('[data-label="SKU"]')?.textContent?.trim() ?? "",
          })),
          productColumnWidth: table?.querySelector("col.stockhub-lines-table__product") ? rect(table.querySelector("col.stockhub-lines-table__product")!).width : 0,
          skuColumnWidth: table?.querySelector("col.stockhub-lines-table__sku") ? rect(table.querySelector("col.stockhub-lines-table__sku")!).width : 0,
        },
        mobile: {
          display: mobileList ? getComputedStyle(mobileList).display : null,
          cards: [...document.querySelectorAll<HTMLElement>(".stockhub-mobile-line-card")].map((card) => ({
            ...rect(card),
            sku: card.querySelector("code")?.textContent?.trim() ?? "",
            actionHeights: [...card.querySelectorAll<HTMLElement>(".stockhub-mobile-line-card__actions button")].map((button) => Math.round(button.getBoundingClientRect().height)),
          })),
        },
        visibleActionHeights: [...document.querySelectorAll<HTMLElement>(`${actionSelector} .stockhub-row-actions button`)].map((button) => Math.round(button.getBoundingClientRect().height)),
        mergeButtonCount: [...document.querySelectorAll(".stockhub-merge-action s-button")].filter((button) => /Merge eligible lines|Resume eligible lines/.test(button.textContent ?? "")).length,
        mergeDialogCount: document.querySelectorAll('.stockhub-merge-confirmation[role="dialog"]').length,
        verifyAction: document.querySelector('.stockhub-receipt-header__actions s-button[type="submit"]')?.textContent?.trim() ?? "",
        shopifyMutationCalls: (window as Window & { __shopifyMutationCalls?: number }).__shopifyMutationCalls ?? 0,
      };
    })() : null,
  };
  document.getElementById("visual-metrics")!.textContent = JSON.stringify(metrics);
  document.body.dataset.visualReady = "true";
}

Object.assign(window, { __refreshVisualMetrics: measure });
setTimeout(measure, 2500);
