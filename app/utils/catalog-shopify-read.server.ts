import type { CatalogShopifyVariant } from "./catalog-compare.shared";

const VARIANTS_QUERY = `#graphql
  query StockHubCatalogVariantSnapshot($first: Int!, $after: String) {
    shop { myshopifyDomain }
    productVariants(first: $first, after: $after) {
      nodes {
        id sku price selectedOptions { name value }
        product { id title descriptionHtml vendor productType options { name values } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type GraphQLPage = {
  data?: { shop?: { myshopifyDomain?: string }; productVariants?: { nodes?: Array<{ id?: unknown; sku?: unknown; price?: unknown; selectedOptions?: unknown; product?: { id?: unknown; title?: unknown; descriptionHtml?: unknown; vendor?: unknown; productType?: unknown; options?: unknown } }>; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } };
  errors?: Array<{ message?: string; extensions?: { code?: string; cost?: { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } } }>;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function queryPage(graphql: (query: string, options: { variables: { first: number; after: string | null } }) => Promise<Response>, after: string | null): Promise<GraphQLPage> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try { response = await graphql(VARIANTS_QUERY, { variables: { first: 250, after } }); }
    catch { if (attempt < 2) { await wait(200 * (attempt + 1)); continue; } throw new Error("Shopify catalog could not be read. Try again later."); }
    let body: GraphQLPage;
    try { body = await response.json() as GraphQLPage; }
    catch { throw new Error("Shopify returned an invalid catalog response."); }
    if (!response.ok) {
      if (response.status === 429 && attempt < 2) { await wait(500 * (attempt + 1)); continue; }
      throw new Error("Shopify catalog could not be read. Try again later.");
    }
    const errors = body.errors ?? [];
    const throttled = errors.some((error) => error.extensions?.code === "THROTTLED");
    if (throttled && attempt < 2) { await wait(500 * (attempt + 1)); continue; }
    if (errors.length || !body.data?.productVariants) throw new Error("Shopify catalog could not be read. Try again later.");
    return body;
  }
  throw new Error("Shopify catalog could not be read. Try again later.");
}

/** Reads every variant using the authenticated Admin API connection; never issues a mutation. */
export async function readShopifyCatalogSnapshot(graphql: (query: string, options: { variables: { first: number; after: string | null } }) => Promise<Response>, expectedShop: string) {
  const variants: CatalogShopifyVariant[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let hasNext = true;
  while (hasNext) {
    if (++pages > 100) throw new Error("Shopify catalog is too large to compare safely in one preview.");
    const body = await queryPage(graphql, cursor);
    const actualShop = body.data?.shop?.myshopifyDomain;
    if (typeof actualShop !== "string" || actualShop.toLowerCase() !== expectedShop.toLowerCase()) throw new Error("The authenticated Shopify shop does not match this catalog draft.");
    const connection = body.data!.productVariants!;
    const pageInfo = connection.pageInfo;
    if (!Array.isArray(connection.nodes) || !pageInfo || typeof pageInfo.hasNextPage !== "boolean" ||
      !(pageInfo.endCursor === null || typeof pageInfo.endCursor === "string") ||
      (pageInfo.hasNextPage && (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor))) {
      throw new Error("Shopify returned an incomplete catalog page.");
    }
    for (const node of connection.nodes) {
      const product = node.product;
      if (typeof node.id !== "string" || !(node.sku === null || typeof node.sku === "string") || !(node.price === null || typeof node.price === "string") ||
        !product || typeof product.id !== "string" || typeof product.title !== "string" ||
        !(product.descriptionHtml === null || typeof product.descriptionHtml === "string") || typeof product.vendor !== "string" || typeof product.productType !== "string" ||
        !Array.isArray(node.selectedOptions) || !node.selectedOptions.every((option) => typeof option === "object" && option !== null && typeof (option as { name?: unknown }).name === "string" && typeof (option as { value?: unknown }).value === "string") ||
        !Array.isArray(product.options) || !product.options.every((option) => typeof option === "object" && option !== null && typeof (option as { name?: unknown }).name === "string" && Array.isArray((option as { values?: unknown }).values) && (option as { values: unknown[] }).values.every((value) => typeof value === "string"))) {
        throw new Error("Shopify returned an incomplete catalog response.");
      }
      variants.push({ id: node.id, sku: node.sku, price: node.price, selectedOptions: node.selectedOptions as Array<{ name: string; value: string }>, productId: product.id, productTitle: product.title, productDescription: product.descriptionHtml, vendor: product.vendor, productType: product.productType, productOptions: product.options as Array<{ name: string; values: string[] }> });
    }
    cursor = pageInfo.endCursor as string | null;
    if (pageInfo.hasNextPage && !cursor) throw new Error("Shopify returned an incomplete catalog page.");
    if (pageInfo.hasNextPage) await wait(100);
    hasNext = pageInfo.hasNextPage;
  }
  variants.sort((left, right) => left.productId.localeCompare(right.productId) || (left.sku ?? "").localeCompare(right.sku ?? "") || left.id.localeCompare(right.id));
  return { variants, fetchedAt: new Date().toISOString() };
}

export const catalogVariantSnapshotQuery = VARIANTS_QUERY;
