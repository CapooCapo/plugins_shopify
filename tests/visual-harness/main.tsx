import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ProductsCatalog } from "../../app/components/ProductsCatalog";
import { matchedSkuProduct, pageInfo, products } from "./products-fixture";
import { OverviewFixture } from "./overview-fixture";
import "../../app/styles/stockhub.css";

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
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), right: Math.round(rect.right), bottom: Math.round(rect.bottom) };
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
      samplePreview: overviewParams.get("sample") === "1",
      range: overviewParams.get("range") === "7" ? 7 : 30,
      salesCards: [...document.querySelectorAll(".stockhub-overview-sales-metrics .stockhub-overview-metric")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.querySelector(".stockhub-metric-label")?.textContent?.trim(), value: element.querySelector(".stockhub-metric-value")?.textContent?.trim(), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      }),
      rangeControls: [...document.querySelectorAll(".stockhub-overview-range a")].map((element) => ({ label: element.textContent?.trim(), href: element.getAttribute("href"), current: element.getAttribute("aria-current") })),
      salesNotices: [...document.querySelectorAll(".stockhub-overview-trend .stockhub-analytics-notice")].map((element) => element.textContent?.trim()),
      salesEmptyStates: [...document.querySelectorAll(".stockhub-overview-trend .stockhub-analytics-empty")].map((element) => element.textContent?.trim()),
      salesTrend: box(".stockhub-overview-trend"),
      chartPlot: box(".stockhub-chart-plot"),
      salesNotice: document.querySelector(".stockhub-overview-trend .stockhub-analytics-notice")?.textContent?.trim() ?? "",
      salesEmpty: document.querySelector(".stockhub-overview-trend .stockhub-analytics-empty")?.textContent?.trim() ?? "",
      chartMeasureLabel: document.querySelector(".stockhub-chart-measure-label")?.textContent?.trim() ?? "",
      chartAxisTicks: [...document.querySelectorAll(".stockhub-chart-y-axis span")].map((element) => element.textContent?.trim()),
      chartLineCount: document.querySelectorAll(".stockhub-chart-line").length,
      chartAreaCount: document.querySelectorAll(".stockhub-chart-area").length,
      salesPoints: document.querySelectorAll(".stockhub-chart-point").length,
      inventoryPanel: box(".stockhub-overview-attention"),
      analysisGrid: box(".stockhub-overview-analysis-grid"),
      analysisGridColumns: getComputedStyle(document.querySelector(".stockhub-overview-analysis-grid")!).gridTemplateColumns,
      bestSellers: box(".stockhub-overview-best-sellers"),
      rankingControls: [...document.querySelectorAll(".stockhub-ranking-switch button")].map((element) => ({
        label: element.textContent?.trim() ?? "",
        pressed: element.getAttribute("aria-pressed"),
        visible: element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility !== "hidden",
      })),
      topProductTitle: document.querySelector(".stockhub-overview-best-sellers ol > li strong")?.textContent?.trim() ?? "",
      inventoryNotes: [...document.querySelectorAll(".stockhub-overview-attention .stockhub-overview-metric-note")].map((element) => element.textContent?.trim()),
      attentionRows: [...document.querySelectorAll(".stockhub-overview-attention-list > li")].map((element) => element.textContent?.trim() ?? ""),
      salesRankingCount: document.querySelectorAll(".stockhub-overview-best-sellers ol > li").length,
      lowStockRows: document.querySelectorAll(".stockhub-attention-status--low").length,
      outOfStockRows: document.querySelectorAll(".stockhub-attention-status--out").length,
      shopCurrency: document.querySelector(".stockhub-chart-measure-label")?.textContent?.trim() ?? "",
      fixtureLabel: document.querySelector(".visual-fixture-badge")?.textContent?.trim() ?? "",
      sampleBadge: document.querySelector(".stockhub-overview-sample-badge")?.textContent?.trim() ?? "",
      historyLink: (() => { const link = document.querySelector(".stockhub-overview-recent .stockhub-overview-section-heading a"); return { href: link?.getAttribute("href"), label: link?.textContent?.trim() }; })(),
      sectionOrder: [...document.querySelector(".stockhub-overview")!.children].map((element) => {
        if (element.matches("header.stockhub-overview-header")) return "header";
        if (element.classList.contains("stockhub-overview-metrics")) return "kpis";
        if (element.classList.contains("stockhub-overview-analysis-grid")) return "analysis-grid";
        if (element.classList.contains("stockhub-overview-attention")) return "inventory-attention";
        if (element.classList.contains("stockhub-overview-recent")) return "recent-imports";
        return element.tagName.toLowerCase();
      }),
      analysisOrder: [...document.querySelector(".stockhub-overview-analysis-grid")!.children].map((element) => {
        if (element.classList.contains("stockhub-overview-trend")) return "sales-performance";
        if (element.classList.contains("stockhub-overview-best-sellers")) return "best-sellers";
        return element.tagName.toLowerCase();
      }),
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
