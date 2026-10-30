import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { InventoryAlerts } from "../components/InventoryAlerts";
import "../styles/stockhub/inventory-alerts.css";
import { createInventoryAlertsSample } from "../utils/inventory-alerts-fixtures";
import { loadInventoryAlertsData } from "../utils/inventory-alerts.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, scopes } = await authenticate.admin(request);
  const url = new URL(request.url);
  const samplePreview = url.searchParams.get("sample") === "1";
  const data = samplePreview
    ? createInventoryAlertsSample()
    : await loadInventoryAlertsData({ admin, scopes, shop: session.shop, signal: request.signal });
  return { data, shop: session.shop, samplePreview, migrated: url.searchParams.get("migrated") === "1" };
};

export default function InventoryAlertsRoute() {
  const { data, shop, samplePreview, migrated } = useLoaderData<typeof loader>();
  return <s-page inlineSize="large"><InventoryAlerts data={data} shop={shop} samplePreview={samplePreview} migrated={migrated} /></s-page>;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
