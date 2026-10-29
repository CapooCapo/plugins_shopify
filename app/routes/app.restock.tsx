import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { RestockPlanner } from "../components/restock/RestockPlanner";
import { createRestockDemo } from "../utils/restock/restock-fixtures";
import { loadRestockData } from "../utils/restock/restock.server";
import type { RestockPeriod } from "../utils/restock/restock.types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, scopes } = await authenticate.admin(request);
  const url = new URL(request.url);
  const period: RestockPeriod = url.searchParams.get("period") === "56" ? 56 : 28;
  const samplePreview = url.searchParams.get("sample") === "1";
  const data = samplePreview
    ? createRestockDemo(period)
    : await loadRestockData({ admin, scopes, shop: session.shop, period, signal: request.signal });
  return { data, samplePreview };
};

export default function RestockRoute() {
  const { data, samplePreview } = useLoaderData<typeof loader>();
  return <s-page inlineSize="large"><RestockPlanner data={data} samplePreview={samplePreview} /></s-page>;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
