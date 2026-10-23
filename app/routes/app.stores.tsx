import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getGraphQLData } from "../utils/shopify-graphql.server";
import { loadShopifyLocationContext } from "../utils/shopify-locations.server";
import { queryGrantedScopes } from "../utils/shopify-scopes.server";
import { RoutePending } from "../components/RoutePending";

type StoreData = { shop: { name: string; myshopifyDomain: string } };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, scopes } = await authenticate.admin(request);

  try {
    const [response, locations, importCount, grantedScopes] = await Promise.all([
      admin.graphql(
      `#graphql
        query StockHubAuthorizedStore {
          shop {
            name
            myshopifyDomain
        }
      }`,
      ),
      loadShopifyLocationContext(admin),
      prisma.importBatch.count({ where: { shop: session.shop } }),
      queryGrantedScopes(scopes).catch(() => null),
    ]);
    return {
      store: (await getGraphQLData<StoreData>(response)).shop,
      locationCount: locations.status === "ready" ? locations.locations.length : null,
      importCount,
      permissionsVerified: grantedScopes !== null,
      error: null,
    };
  } catch {
    return {
      store: null,
      error: "The authenticated Shopify store could not be loaded. Try again.",
    };
  }
};

export default function Stores() {
  const { store, error, locationCount, importCount, permissionsVerified } = useLoaderData<typeof loader>();

  return (
    <s-page inlineSize="large">
      <main className="stockhub-page stockhub-stores">
      <RoutePending />
      <header className="stockhub-stores-header">
        <div>
          <div className="stockhub-overview-eyebrow">StockHub connection</div>
          <h1>Stores</h1>
          <p>This app currently supports one authenticated Shopify store per Admin session.</p>
        </div>
      </header>
      <section className="stockhub-store-card"><s-section heading="Current session store">
        {error ? (
          <s-banner tone="critical">{error}</s-banner>
        ) : store ? (
          <div className="stockhub-store-summary">
            <div className="stockhub-store-summary-identity">
              <span className="stockhub-store-monogram" aria-hidden="true">S</span>
              <div><s-heading>{store.name}</s-heading><s-text>{store.myshopifyDomain}</s-text></div>
            </div>
            <div className="stockhub-store-summary-metrics" aria-label="Store summary">
              <span><strong>{locationCount ?? "—"}</strong> active location{locationCount === 1 ? "" : "s"}</span>
              <span><strong>{importCount}</strong> import receipt{importCount === 1 ? "" : "s"}</span>
              <s-badge tone={permissionsVerified ? "success" : "warning"}>{permissionsVerified ? "Permissions verified" : "Permissions unverified"}</s-badge>
            </div>
            <div className="stockhub-store-summary-action"><s-badge>Authenticated session</s-badge><s-button href={`/app/store/${encodeURIComponent(store.myshopifyDomain)}`} variant="primary">View store details</s-button></div>
          </div>
        ) : (
          <s-text>Store details are unavailable for this session.</s-text>
        )}
      </s-section></section>
      <section className="stockhub-stores-connection" aria-labelledby="stores-connection-title">
        <h2 id="stores-connection-title">Connection information</h2>
        <p>This is not a multi-store registry: StockHub does not provide multi-store OAuth in this version. Open the app from each Shopify Admin that needs its own authenticated session.</p>
      </section>
      </main>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
