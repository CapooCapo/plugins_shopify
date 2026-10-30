import { getGraphQLData } from "./shopify-graphql.server";
import type { AdminGraphQL } from "./overview-analytics-graphql.server";
import type { OverviewData } from "./overview-types";

export const OVERVIEW_STORE_QUERY = `#graphql
  query StockHubOverview {
    shop { name myshopifyDomain ianaTimezone currencyCode }
    all: productsCount(limit: null) { count precision }
    active: productsCount(query: "status:active", limit: null) { count precision }
    draft: productsCount(query: "status:draft", limit: null) { count precision }
  }
`;

export async function loadOverviewStoreData(admin: AdminGraphQL): Promise<OverviewData> {
  const response = await admin.graphql(OVERVIEW_STORE_QUERY);
  return getGraphQLData<OverviewData>(response);
}
