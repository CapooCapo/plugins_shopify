import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Outlet,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const navigation = useNavigation();

  return (
    <AppProvider apiKey={apiKey}>
      <NavMenu>
        {/* Keep the app-home destination separate from its visible navigation item.
            App Bridge uses the rel=home link for the app-name destination and
            excludes it from the rendered menu. */}
        <a href="/app" rel="home">
          StockHub home
        </a>
        <a href="/app">Overview</a>
        <a href="/app/stores">Stores</a>
        <a href="/app/products">Products</a>
        <a href="/app/imports">Imports</a>
        <a href="/app/restock">Restock Planner</a>
      </NavMenu>
      {navigation.state === "loading" ? (
        <div role="status" aria-live="polite">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-spinner size="base" accessibilityLabel="Loading workspace" />
            <s-text>Loading workspace…</s-text>
          </s-stack>
        </div>
      ) : null}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
