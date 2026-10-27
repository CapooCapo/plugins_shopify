import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { OverviewDashboard } from "../../app/components/OverviewDashboard";
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

import NewImport from "../../app/routes/app.imports._index";
import CatalogImports from "../../app/routes/app.imports.catalog._index";
import CatalogImportDetail from "../../app/routes/app.imports.catalog.$batchId";
import { ImportDirtyContext } from "../../app/import-dirty-context";
import { newImportFixture } from "./new-import-fixture";
import { ReceiptActionsFixture, receiptActionsFixtureAction } from "./ReceiptActionsFixture";
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
const initialPath = selectedPage === "products" ? "/app/products" : selectedPage === "new-import" ? "/app/imports" : selectedPage === "receipt-actions" ? "/app/receipt-actions" : selectedPage === "catalog" ? catalogBatchId ? `/app/imports/catalog/${encodeURIComponent(catalogBatchId)}` : "/app/imports/catalog" : "/app";

const router = createMemoryRouter([
  {
    path: "/app",
    element: <s-page inlineSize="large"><OverviewDashboard data={data} error={null} imports={imports} /></s-page>,
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
    quickActions: box(".stockhub-overview-shortcuts"),
    recentImports: box(".stockhub-overview-recent"),
    primaryActionCount: document.querySelectorAll('.stockhub-overview-header-action s-button[href="/app/imports"]').length,
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
          const wrap = document.querySelector<HTMLElement>(".stockhub-receipt-summary-wrap");
          const table = document.querySelector<HTMLElement>(".stockhub-receipt-summary");
          const rect = wrap?.getBoundingClientRect();
          return {
            width: rect?.width ?? 0,
            scrollWidth: wrap?.scrollWidth ?? 0,
            rowCount: table?.querySelectorAll("tbody tr").length ?? 0,
            caption: table?.querySelector("caption")?.textContent?.trim() ?? "",
            tones: [...(table?.querySelectorAll(".stockhub-receipt-summary-count") ?? [])]
              .map((element) => [...element.classList].find((name) => name.startsWith("stockhub-receipt-summary-count--")) ?? ""),
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
  };
  document.getElementById("visual-metrics")!.textContent = JSON.stringify(metrics);
  document.body.dataset.visualReady = "true";
}

Object.assign(window, { __refreshVisualMetrics: measure });
setTimeout(measure, 2500);
