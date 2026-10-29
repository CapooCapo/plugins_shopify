import { useLocation } from "react-router";
import { OverviewDashboard } from "../../app/components/OverviewDashboard";
import type { OverviewAnalytics } from "../../app/utils/overview-analytics.server";
import { createSampleOverviewAnalytics } from "../../app/utils/overview-analytics-demo";
import { createSampleOverviewImports } from "../../app/utils/overview-imports-demo";
import type { ImportOverview } from "../../app/utils/overview-types";

const data = {
  shop: { name: "Example Outfitters", myshopifyDomain: "example-outfitters.myshopify.com" },
  all: { count: 27, precision: "EXACT" as const },
  active: { count: 15, precision: "EXACT" as const },
  draft: { count: 11, precision: "EXACT" as const },
};

const now = new Date("2026-10-29T12:00:00.000Z");
const imports: ImportOverview = {
  sample: false,
  recent: [
    { id: "fixture-inventory-1", label: "IMP-00214", kind: "inventory", locationName: "North warehouse", createdAt: now, updatedAt: now, status: "COMPLETED", detailHref: "/app/imports/history/fixture-inventory-1" },
    { id: "fixture-inventory-2", label: "IMP-00213", kind: "inventory", locationName: "East store", createdAt: new Date(now.getTime() - 86_400_000), updatedAt: now, status: "PREVIEWED", detailHref: "/app/imports/history/fixture-inventory-2" },
    { id: "fixture-catalog-1", label: "Autumn catalog.csv", kind: "catalog", locationName: null, createdAt: now, updatedAt: now, status: "CATALOG_EXECUTION_COMPLETE", detailHref: "/app/imports/catalog/fixture-catalog-1" },
  ],
};

function readyAnalytics(range: 7 | 30): OverviewAnalytics {
  const base = createSampleOverviewAnalytics(range, "America/New_York", now);
  return {
    ...base,
    currencyCode: "CAD",
    sales: { ...base.sales, status: "ready", data: { ...base.sales.data!, currencyCode: "CAD" } },
    inventory: { ...base.inventory, status: "ready" },
  };
}

export function OverviewFixture() {
  const params = new URLSearchParams(useLocation().search);
  const range = params.get("range") === "7" ? 7 : 30;
  const samplePreview = params.get("sample") === "1";
  const scenario = params.get("scenario");
  const analytics = readyAnalytics(range);
  if (scenario === "scope-missing" || scenario === "blocked") {
    analytics.sales = { status: "permission_required", data: null, message: "Sales analytics require the read_orders permission. No order data was requested.", fetchedAt: null };
  } else if (scenario === "empty" || scenario === "ready-empty") {
    analytics.sales = { status: "ready", data: { ...analytics.sales.data!, totals: { revenue: 0, orders: 0, units: 0 }, daily: analytics.sales.data!.daily.map((day) => ({ ...day, revenue: 0, orders: 0, units: 0 })), topProducts: [], topVariants: [], variantDemand: [] }, fetchedAt: now.toISOString() };
  } else if (scenario === "partial") {
    const message = "Only part of the order history was retrieved. Sales totals and rankings reflect the available data and may be incomplete.";
    const salesData = analytics.sales.data!;
    analytics.sales = {
      status: "partial",
      data: {
        ...salesData,
        status: "partial",
        reason: message,
        topProducts: salesData.topProducts.slice(0, 3),
        topVariants: salesData.topVariants.slice(0, 4),
        variantDemand: salesData.variantDemand.slice(0, 4),
      },
      message,
      fetchedAt: now.toISOString(),
    };
  }
  return <div className="visual-fixture-shell">
    <aside className="visual-fixture-badge" role="note">LOCAL FIXTURE · NOT LIVE SHOPIFY ADMIN DATA</aside>
    <s-page inlineSize="large"><OverviewDashboard
      data={samplePreview ? null : data}
      storeName={samplePreview ? "Example Outfitters" : data.shop.name}
      error={null}
      imports={samplePreview ? createSampleOverviewImports() : imports}
      analytics={samplePreview ? createSampleOverviewAnalytics(range, "America/New_York", now) : analytics}
      samplePreview={samplePreview}
    /></s-page>
  </div>;
}
