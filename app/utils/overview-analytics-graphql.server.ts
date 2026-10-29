export type RequestBudget = { remaining: number };

export class RequestBudgetExceededError extends Error {
  constructor() {
    super("The per-load Shopify request budget was exhausted.");
    this.name = "RequestBudgetExceededError";
  }
}

const MAX_QUERY_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;
const FALLBACK_RETRY_DELAY_MS = 300;
const RETRY_DELAY_BUFFER_MS = 100;
export const SALES_ORDERS_QUERY = `#graphql
  query StockHubOverviewOrders($first: Int!, $after: String, $query: String!, $lineItemsFirst: Int!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      nodes {
        id
        createdAt
        cancelledAt
        test
        lineItems(first: $lineItemsFirst) {
          nodes {
            id
            currentQuantity
            priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
            product { id title legacyResourceId featuredImage { url } }
            variant { id title sku legacyResourceId }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const ORDER_LINE_ITEMS_QUERY = `#graphql
  query StockHubOverviewOrderLineItems($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      lineItems(first: $first, after: $after) {
        nodes {
          id
          currentQuantity
          priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
          product { id title legacyResourceId featuredImage { url } }
          variant { id title sku legacyResourceId }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const INVENTORY_VARIANTS_QUERY = `#graphql
  query StockHubOverviewInventoryVariants($first: Int!, $after: String, $levelsFirst: Int!) {
    productVariants(first: $first, after: $after) {
      nodes {
        id
        title
        sku
        legacyResourceId
        product { id title legacyResourceId isGiftCard featuredImage { url } }
        inventoryItem {
          id
          tracked
          inventoryLevels(first: $levelsFirst, includeInactive: false) {
            nodes {
              isActive
              location { id isActive }
              quantities(names: ["available"]) { name quantity }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const INVENTORY_LEVELS_QUERY = `#graphql
  query StockHubOverviewInventoryLevels($id: ID!, $first: Int!, $after: String) {
    inventoryItem(id: $id) {
      inventoryLevels(first: $first, after: $after, includeInactive: false) {
        nodes {
          isActive
          location { id isActive }
          quantities(names: ["available"]) { name quantity }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export type AdminGraphQL = {
  graphql: (query: string, options?: {
    variables?: Record<string, unknown>;
    tries?: number;
    signal?: AbortSignal;
  }) => Promise<Response>;
};

type GraphQLError = { message?: string; extensions?: { code?: string } };
type GraphQLBody = {
  data?: unknown;
  errors?: GraphQLError[];
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: {
        currentlyAvailable?: number;
        restoreRate?: number;
      };
    };
  };
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterHeaderMs(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * Shopify exposes the requested query cost, available bucket points, and
 * restore rate on GraphQL responses. Honor that signal when possible, but
 * never wait indefinitely: a delay above the cap fails closed instead of
 * sending another request before the bucket should be ready.
 */
function retryDelayMs(response: Response, body: GraphQLBody | null, retryIndex: number): number | null {
  const retryAfter = retryAfterHeaderMs(response);
  if (retryAfter !== null) return retryAfter <= MAX_RETRY_DELAY_MS ? retryAfter : null;

  const cost = body?.extensions?.cost;
  const requested = cost?.requestedQueryCost;
  const available = cost?.throttleStatus?.currentlyAvailable;
  const restoreRate = cost?.throttleStatus?.restoreRate;
  if ([requested, available, restoreRate].every((value) => typeof value === "number" && Number.isFinite(value))
    && requested! >= 0 && available! >= 0 && restoreRate! > 0) {
    const requiredMs = Math.max(0, requested! - available!) / restoreRate! * 1_000;
    // If metadata says the bucket already has room, retain a small fallback
    // delay because Shopify may still have rejected on a concurrent request.
    const delay = requiredMs > 0 ? Math.ceil(requiredMs + RETRY_DELAY_BUFFER_MS) : FALLBACK_RETRY_DELAY_MS * 2 ** retryIndex;
    return delay <= MAX_RETRY_DELAY_MS ? delay : null;
  }

  const fallback = FALLBACK_RETRY_DELAY_MS * 2 ** retryIndex;
  return fallback <= MAX_RETRY_DELAY_MS ? fallback : null;
}

export class OverviewAnalyticsReadError extends Error {
  constructor(message = "Shopify analytics could not be fully loaded.") {
    super(message);
    this.name = "OverviewAnalyticsReadError";
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function queryData<T>(
  admin: AdminGraphQL,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
  requestBudget?: RequestBudget,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_QUERY_ATTEMPTS; attempt += 1) {
    if (requestBudget) {
      if (requestBudget.remaining <= 0) throw new RequestBudgetExceededError();
      // Count every network attempt, including throttling/network retries.
      requestBudget.remaining -= 1;
    }
    let response: Response;
    try {
      response = await admin.graphql(query, { variables, tries: 1, ...(signal ? { signal } : {}) });
    } catch {
      if (attempt < MAX_QUERY_ATTEMPTS - 1 && !signal?.aborted) {
        await wait(FALLBACK_RETRY_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw new OverviewAnalyticsReadError();
    }

    let body: GraphQLBody;
    try {
      body = await response.json() as GraphQLBody;
    } catch {
      if ((response.status === 429 || !response.ok) && attempt < MAX_QUERY_ATTEMPTS - 1 && !signal?.aborted) {
        const delay = retryDelayMs(response, null, attempt);
        if (delay !== null) {
          await wait(delay);
          continue;
        }
      }
      throw new OverviewAnalyticsReadError("Shopify returned an invalid analytics response.");
    }
    const throttled = body.errors?.some((error) => error.extensions?.code === "THROTTLED") === true;
    if ((response.status === 429 || throttled) && attempt < MAX_QUERY_ATTEMPTS - 1 && !signal?.aborted) {
      const delay = retryDelayMs(response, body, attempt);
      if (delay !== null) {
        await wait(delay);
        continue;
      }
    }
    if (!response.ok || body.errors?.length || body.data == null) {
      throw new OverviewAnalyticsReadError();
    }
    return body.data as T;
  }
  throw new OverviewAnalyticsReadError();
}

export function connection<T>(value: unknown): { nodes: T[]; hasNextPage: boolean; endCursor: string | null } | null {
  if (!record(value) || !record(value.pageInfo) || !Array.isArray(value.nodes) || typeof value.pageInfo.hasNextPage !== "boolean") return null;
  const cursor = value.pageInfo.endCursor;
  if (!(cursor === null || typeof cursor === "string")) return null;
  return { nodes: value.nodes as T[], hasNextPage: value.pageInfo.hasNextPage, endCursor: cursor };
}

export function appendPartialReasons<T extends { status: "ready" | "partial" | "unavailable"; reason?: string }>(
  result: T,
  reasons: string[],
): T {
  const uniqueReasons = [...new Set(reasons.filter(Boolean))];
  if (!uniqueReasons.length) return result;
  const existing = result.reason ? [result.reason] : [];
  return {
    ...result,
    status: "partial",
    reason: [...new Set([...existing, ...uniqueReasons])].join(" "),
  };
}
