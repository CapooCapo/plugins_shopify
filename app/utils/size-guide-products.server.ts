export type SizeGuideProduct = { id: string; title: string; imageUrl?: string | null };
type ProductAdmin = { graphql: (query: string, options: { variables: Record<string, unknown> }) => Promise<Response> };
type ProductNodesResponse = {
  data?: { nodes?: Array<(SizeGuideProduct & { featuredImage?: { url?: string | null } | null }) | null> };
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
};

export class SizeGuideProductLookupError extends Error {
  constructor(readonly errorType: "permission" | "api") {
    super(errorType === "permission" ? "Shopify product access was denied." : "Shopify products could not be verified.");
    this.name = "SizeGuideProductLookupError";
  }
}

/** Verify all picker IDs in one authenticated Admin API read; never trust client titles. */
export async function getSizeGuideProductsByIds(admin: ProductAdmin, ids: string[]): Promise<SizeGuideProduct[]> {
  let response: Response;
  try {
    response = await admin.graphql(`#graphql
      query StockHubSizeGuideProducts($ids: [ID!]!) {
        nodes(ids: $ids) { ... on Product { id title featuredImage { url } } }
      }`, { variables: { ids } });
  } catch {
    throw new SizeGuideProductLookupError("api");
  }

  let body: ProductNodesResponse;
  try { body = await response.json() as ProductNodesResponse; }
  catch { throw new SizeGuideProductLookupError(response.status === 401 || response.status === 403 ? "permission" : "api"); }
  const denied = response.status === 401 || response.status === 403 || body.errors?.some((error) => {
    const code = error.extensions?.code?.toUpperCase();
    return code === "ACCESS_DENIED" || code === "FORBIDDEN" || /access denied|permission/i.test(error.message ?? "");
  });
  if (denied) throw new SizeGuideProductLookupError("permission");
  if (!response.ok || body.errors?.length || !body.data?.nodes) throw new SizeGuideProductLookupError("api");
  return body.data.nodes.flatMap((node) => node ? [{
    id: node.id,
    title: node.title,
    imageUrl: node.featuredImage?.url ?? null,
  }] : []);
}
