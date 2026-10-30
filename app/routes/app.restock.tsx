import type { HeadersFunction } from "react-router";
import { redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = () => redirect("/app/inventory-alerts?migrated=1");

export default function RetiredRestockRoute() {
  return null;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
