import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { OverviewDashboard } from "../components/OverviewDashboard";
import { loadOverviewAnalytics } from "../utils/overview-analytics.server";
import { createSampleOverviewAnalytics } from "../utils/overview-analytics-demo";
import { createSampleOverviewImports } from "../utils/overview-imports-demo";
import type { OverviewData } from "../utils/overview-types";
import { loadRecentOverviewImports } from "../utils/overview-imports.server";
import { loadOverviewStoreData } from "../utils/overview-store.server";

export type { ImportOverview, OverviewData, ProductCount, RecentImport } from "../utils/overview-types";

const SAMPLE_TIME_ZONE = "America/New_York";
const SAMPLE_NOW = new Date("2026-10-29T12:00:00.000Z");

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, scopes } = await authenticate.admin(request);
  const url = new URL(request.url);
  const range: 7 | 30 = url.searchParams.get("range") === "7" ? 7 : 30;
  const samplePreview = url.searchParams.get("sample") === "1";
  if (samplePreview) {
    return {
      data: null,
      storeName: "Example Outfitters",
      error: null,
      imports: createSampleOverviewImports(),
      analytics: createSampleOverviewAnalytics(range, SAMPLE_TIME_ZONE, SAMPLE_NOW),
      samplePreview: true,
    };
  }

  const importsPromise = loadRecentOverviewImports(session.shop);
  let data: OverviewData | null = null;
  let error: string | null = null;
  try {
    data = await loadOverviewStoreData(admin);
  } catch {
    error = "Shopify product data could not be loaded. Confirm the app has read_products access and try again.";
  }
  const analytics = await loadOverviewAnalytics({
    admin,
    scopes,
    shop: session.shop,
    range,
    timeZone: data?.shop.ianaTimezone ?? null,
    currencyCode: data?.shop.currencyCode ?? null,
    signal: request.signal,
  });
  return { data, storeName: data?.shop.name ?? session.shop, error, imports: await importsPromise, analytics, samplePreview: false };
};

export default function Overview() {
  const { data, storeName, error, imports, analytics, samplePreview } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  return <s-page inlineSize="large">
    <OverviewDashboard data={data} storeName={storeName} error={error} imports={imports} analytics={analytics} samplePreview={samplePreview} loading={navigation.state === "loading"} />
  </s-page>;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
