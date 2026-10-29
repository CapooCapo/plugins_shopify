import { getGraphQLData } from "./shopify-graphql.server";

export type SizeGuideProduct = { id: string; title: string };
type ProductAdmin = { graphql: (query: string, options: { variables: Record<string, unknown> }) => Promise<Response> };

export async function searchSizeGuideProducts(admin: ProductAdmin, search: string): Promise<SizeGuideProduct[]> {
  if (search.length < 2) return [];
  const query = `#graphql
    query StockHubSizeGuideProductSearch($query: String!) {
      products(first: 20, query: $query, sortKey: TITLE) {
        nodes { id title }
      }
    }`;
  const data = await getGraphQLData<{ products: { nodes: SizeGuideProduct[] } }>(await admin.graphql(query, {
    variables: { query: `title:${JSON.stringify(search)}` },
  }));
  return data.products.nodes;
}

export async function getSizeGuideProduct(admin: ProductAdmin, id: string): Promise<SizeGuideProduct | null> {
  const data = await getGraphQLData<{ node: SizeGuideProduct | null }>(await admin.graphql(`#graphql
    query StockHubSizeGuideProduct($id: ID!) {
      node(id: $id) { ... on Product { id title } }
    }`, { variables: { id } }));
  return data.node;
}
