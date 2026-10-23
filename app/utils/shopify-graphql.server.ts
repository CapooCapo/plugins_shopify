type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

export class ShopifyGraphQLError extends Error {
  constructor() {
    super("Shopify Admin GraphQL request failed");
    this.name = "ShopifyGraphQLError";
  }
}

export async function getGraphQLData<T>(response: Response): Promise<T> {
  let body: GraphQLResponse<T>;

  try {
    body = (await response.json()) as GraphQLResponse<T>;
  } catch {
    throw new ShopifyGraphQLError();
  }

  if (!response.ok || body.errors?.length || body.data == null) {
    throw new ShopifyGraphQLError();
  }

  return body.data;
}
