import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getGraphQLData } from "../utils/shopify-graphql.server";
import { loadShopifyLocationContext } from "../utils/shopify-locations.server";
import {
  missingScopesForGrant,
  queryGrantedScopes,
} from "../utils/shopify-scopes.server";
import { formatStockhubDateTime } from "../utils/stockhub-format.js";

type ProductCount = { count: number; precision: "EXACT" | "AT_LEAST" };
type StoreData = {
  shop: {
    name: string;
    myshopifyDomain: string;
    primaryDomain: { host: string };
  };
  products: ProductCount;
};
const REQUIRED_READ_SCOPES = ["read_products", "read_inventory", "read_locations"];

function sameScopeGrant(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((scope) => right.includes(scope));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session, scopes } = await authenticate.admin(request);

  // A URL parameter is never authority to read another store's data.
  if (!params.shop || params.shop !== session.shop) {
    throw new Response("Store not found", { status: 404 });
  }

  const storePromise = admin.graphql(
    `#graphql
      query StockHubStoreDetails {
        shop {
          name
          myshopifyDomain
          primaryDomain { host }
        }
        products: productsCount(limit: null) {
          count
          precision
        }
      }`,
  ).then((response) => getGraphQLData<StoreData>(response)).then((data) => ({
    store: data.shop,
    products: data.products,
    error: null,
  })).catch(() => ({
    store: null,
    products: null,
    error: "Store details and product count could not be loaded. Confirm read_products access and try again.",
  }));

  const locationsPromise = loadShopifyLocationContext(admin);
  const importsPromise = prisma.importBatch.findMany({
    where: { shop: session.shop },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 5,
    select: {
      id: true,
      receiptCode: true,
      locationName: true,
      createdAt: true,
      status: true,
    },
  }).catch(() => null);
  const grantedScopesPromise = queryGrantedScopes(scopes).catch(() => null);

  const [storeResult, locations, recentImports, grantedScopes] = await Promise.all([
    storePromise,
    locationsPromise,
    importsPromise,
    grantedScopesPromise,
  ]);

  const locationScopes = locations.status === "error" ? null : locations.scopes;
  const scopesVerified = Boolean(
    grantedScopes && locationScopes && sameScopeGrant(grantedScopes, locationScopes),
  );
  const missingReadScopes = grantedScopes
    ? missingScopesForGrant(grantedScopes, REQUIRED_READ_SCOPES)
    : REQUIRED_READ_SCOPES;

  return {
    ...storeResult,
    locations,
    recentImports,
    scopesVerified,
    missingReadScopes,
  };
};

function formatCount(value: ProductCount | null) {
  if (!value) return "Unavailable";
  return value.precision === "EXACT" ? value.count : `At least ${value.count}`;
}

function humanStatus(status: string) {
  return status === "COMPLETED" ? "Completed" : status === "PARTIAL" ? "Partially completed"
    : status === "UNCERTAIN" ? "Outcome uncertain" : status === "FAILED" ? "Failed"
      : status === "BLOCKED" ? "Blocked" : status === "RUNNING" ? "In progress"
        : status === "PROCESSING" ? "Processing" : status === "PREVIEWED" ? "Previewed"
          : status.toLowerCase().replaceAll("_", " ");
}

function importStatusTone(status: string): "success" | "critical" | "warning" | "info" | "neutral" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED" || status === "BLOCKED") return "critical";
  if (status === "PARTIAL" || status === "UNCERTAIN") return "warning";
  if (status === "PREVIEWED" || status === "RUNNING" || status === "PROCESSING") return "info";
  return "neutral";
}

function importStatusIcon(status: string) {
  if (status === "COMPLETED") return "check-circle";
  if (status === "FAILED" || status === "BLOCKED") return "alert-circle";
  if (status === "PARTIAL" || status === "UNCERTAIN") return "alert-triangle";
  if (status === "RUNNING" || status === "PROCESSING") return "clock";
  return "info";
}

export default function StoreDetails() {
  const {
    store,
    products,
    error,
    locations,
    recentImports,
    scopesVerified,
    missingReadScopes,
  } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Store details">
      <div className="stockhub-page stockhub-store-detail">
      <div className="stockhub-back-link"><s-section>
        <Link to="/app/stores">Back to stores</Link>
      </s-section></div>
      {error ? (
        <div className="stockhub-state-panel"><s-section>
          <s-banner tone="critical">{error}</s-banner>
        </s-section></div>
      ) : store ? (
        <div className="stockhub-hero-panel"><s-section heading={store.name}>
          <s-stack direction="block" gap="base">
            <s-text>Shopify domain: {store.myshopifyDomain}</s-text>
            <s-text>Primary domain: {store.primaryDomain.host}</s-text>
            <s-badge tone={scopesVerified ? "success" : "warning"}>
              {scopesVerified ? "Authorization verified" : "Authorization unknown"}
            </s-badge>
          </s-stack>
        </s-section></div>
      ) : null}

      <div className="stockhub-panel"><s-section heading="Products">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text>Total products: {formatCount(products)}</s-text>
          <Link to="/app/products">View products</Link>
        </s-stack>
      </s-section></div>

      <div className="stockhub-panel"><s-section heading="Locations">
        {locations.status === "ready" ? (
          locations.locations.length ? (
            <s-stack direction="block" gap="small">
              <s-text>{locations.locations.length} active locations</s-text>
              {locations.locations.slice(0, 10).map((location) => (
                <s-text key={location.id}>{location.name}</s-text>
              ))}
              {locations.locations.length > 10 ? (
                <s-text>Showing 10 of {locations.locations.length} active locations.</s-text>
              ) : null}
            </s-stack>
          ) : (
            <s-paragraph>No active locations were returned by Shopify.</s-paragraph>
          )
        ) : (
          <s-banner tone="warning">{locations.message}</s-banner>
        )}
      </s-section></div>

      <div className="stockhub-panel stockhub-table-panel"><s-section heading="Import activity">
        {recentImports === null ? (
          <s-paragraph>Import activity is currently unavailable.</s-paragraph>
        ) : recentImports.length ? (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary" format="base">Receipt</s-table-header>
              <s-table-header listSlot="labeled" format="base">Location</s-table-header>
              <s-table-header listSlot="labeled" format="base">Created</s-table-header>
              <s-table-header listSlot="labeled" format="base">Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recentImports.map((batch) => (
                <s-table-row key={batch.id}>
                  <s-table-cell>
                    <Link to={`/app/imports/history/${encodeURIComponent(batch.id)}`}>
                      {batch.receiptCode.trim() || "Receipt unavailable"}
                    </Link>
                  </s-table-cell>
                  <s-table-cell>{batch.locationName}</s-table-cell>
                  <s-table-cell>{formatStockhubDateTime(batch.createdAt)}</s-table-cell>
                  <s-table-cell><s-badge tone={importStatusTone(batch.status)} icon={importStatusIcon(batch.status)}>{humanStatus(batch.status)}</s-badge></s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph>No imports have been recorded for this store.</s-paragraph>
        )}
        <Link to="/app/imports/history">View import history</Link>
      </s-section></div>

      <div className="stockhub-panel"><s-section heading="Connection and access">
        <s-stack direction="block" gap="base">
          <s-text>
            Shopify authorization: {scopesVerified ? "Verified" : "Could not verify"}
          </s-text>
          {scopesVerified && missingReadScopes.length ? (
            <s-banner tone="warning">
              Confirmed missing read access: {missingReadScopes.join(", ")}.
              Reauthorize StockHub after updating app permissions.
            </s-banner>
          ) : scopesVerified ? (
            <s-text>Required read scopes are granted: {REQUIRED_READ_SCOPES.join(", ")}.</s-text>
          ) : (
            <s-paragraph>
              Current Shopify grants and location access could not be cross-checked.
            </s-paragraph>
          )}
          {locations.status === "ready" && locations.scopes.includes("write_inventory") ? (
            <s-text>Inventory write access is granted for import operations.</s-text>
          ) : null}
        </s-stack>
      </s-section></div>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
