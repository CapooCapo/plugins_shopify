import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const MAX_LOCATION_PAGES = 25;
const DIAGNOSE_LOCATIONS_QUERY = `#graphql
  query DiagnoseStockHubLocations {
    shop {
      myshopifyDomain
      currencyCode
    }
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
    locations(first: 20, includeInactive: false) {
      nodes {
        id
        name
        isActive
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const LOCATIONS_PAGE_QUERY = `#graphql
  query StockHubLocationsPage($after: String!) {
    locations(first: 20, includeInactive: false, after: $after) {
      nodes { id name isActive }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export type ShopifyLocation = {
  id: string;
  name: string;
  isActive: boolean;
};

export type ShopifyLocationContext =
  | {
      status: "ready";
      shopDomain: string;
      currencyCode: string;
      scopes: string[];
      locations: ShopifyLocation[];
    }
  | {
      status: "missing_scope";
      missingScopes: string[];
      scopes: string[];
      message: string;
    }
  | {
      status: "error";
      message: string;
      httpStatus?: number;
      graphqlError?: boolean;
    };

type DiagnoseLocationsData = {
  shop?: {
    myshopifyDomain?: unknown;
    currencyCode?: unknown;
  } | null;
  currentAppInstallation?: {
    accessScopes?: Array<{ handle?: unknown }> | null;
  } | null;
  locations?: {
    nodes?: Array<{
      id?: unknown;
      name?: unknown;
      isActive?: unknown;
    }> | null;
    pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null;
  } | null;
};

const LOAD_ERROR_MESSAGE =
  "Shopify could not load this store's locations. Verify the app's read_locations permission, then refresh the embedded app and retry.";
const MISSING_LOCATION_SCOPE_MESSAGE =
  "This app installation is missing read_locations, which Shopify requires to read location names and active status. Add read_locations to the app's requested scopes and reauthorize the embedded app before retrying.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLocationNodes(nodes: unknown): ShopifyLocation[] | null {
  if (!Array.isArray(nodes)) return null;

  const locations: ShopifyLocation[] = [];
  for (const item of nodes) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !item.id.startsWith("gid://shopify/Location/") ||
      typeof item.name !== "string" ||
      typeof item.isActive !== "boolean"
    ) {
      return null;
    }
    if (item.isActive) {
      locations.push({ id: item.id, name: item.name, isActive: true });
    }
  }
  return locations;
}

function parseLocationConnection(value: unknown): {
  locations: ShopifyLocation[];
  hasNextPage: boolean;
  endCursor: string | null;
} | null {
  if (!isRecord(value) || !isRecord(value.pageInfo)) return null;
  const locations = parseLocationNodes(value.nodes);
  const { hasNextPage, endCursor } = value.pageInfo;
  if (
    !locations ||
    typeof hasNextPage !== "boolean" ||
    !(endCursor === null || (typeof endCursor === "string" && endCursor.length > 0)) ||
    (hasNextPage && (typeof endCursor !== "string" ||
      !Array.isArray(value.nodes) || value.nodes.length === 0))
  ) {
    return null;
  }
  return { locations, hasNextPage, endCursor };
}

/**
 * Fetches location data and the installed app scopes using only the authenticated
 * Admin API context. Errors are intentionally sanitized; raw Shopify responses
 * can contain request details and are not suitable for displaying to merchants.
 */
export async function loadShopifyLocationContext(
  admin: AdminApiContext,
): Promise<ShopifyLocationContext> {
  try {
    const response = await admin.graphql(DIAGNOSE_LOCATIONS_QUERY);
    if (!response.ok) {
      return { status: "error", message: LOAD_ERROR_MESSAGE, httpStatus: response.status };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: "error", message: LOAD_ERROR_MESSAGE };
    }
    if (!isRecord(body) || !isRecord(body.data)) {
      return { status: "error", message: LOAD_ERROR_MESSAGE };
    }
    const data = body.data as DiagnoseLocationsData;
    const accessScopes = data.currentAppInstallation?.accessScopes;
    if (!Array.isArray(accessScopes)) {
      return {
        status: "error",
        message: "Shopify returned incomplete store, permission, or location information. Refresh the app and retry.",
      };
    }

    const scopes = accessScopes.flatMap((scope) =>
      isRecord(scope) && typeof scope.handle === "string" ? [scope.handle] : [],
    );
    if (!scopes.includes("read_locations")) {
      return {
        status: "missing_scope",
        missingScopes: ["read_locations"],
        scopes,
        message: MISSING_LOCATION_SCOPE_MESSAGE,
      };
    }

    if (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length > 0)) {
      return { status: "error", message: LOAD_ERROR_MESSAGE, graphqlError: true };
    }

    const shopDomain = data.shop?.myshopifyDomain;
    const currencyCode = data.shop?.currencyCode;
    if (
      typeof shopDomain !== "string" ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopDomain) ||
      typeof currencyCode !== "string" ||
      !/^[A-Z]{3}$/.test(currencyCode)
    ) {
      return {
        status: "error",
        message: "Shopify returned incomplete store, permission, or location information. Refresh the app and retry.",
      };
    }

    let connection = parseLocationConnection(data.locations);
    if (!connection) {
      return {
        status: "error",
        message: "Shopify returned invalid location data. Refresh the embedded app and retry.",
      };
    }

    const locations: ShopifyLocation[] = [];
    const seenLocationIds = new Set<string>();
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_LOCATION_PAGES; page += 1) {
      for (const location of connection.locations) {
        if (seenLocationIds.has(location.id)) {
          return { status: "error", message: LOAD_ERROR_MESSAGE };
        }
        seenLocationIds.add(location.id);
        locations.push(location);
      }
      if (!connection.hasNextPage) {
        return { status: "ready", shopDomain, currencyCode, scopes, locations };
      }
      const cursor = connection.endCursor;
      if (!cursor || seenCursors.has(cursor) || page === MAX_LOCATION_PAGES - 1) {
        return { status: "error", message: LOAD_ERROR_MESSAGE };
      }
      seenCursors.add(cursor);
      const pageResponse = await admin.graphql(LOCATIONS_PAGE_QUERY, { variables: { after: cursor } });
      if (!pageResponse.ok) return { status: "error", message: LOAD_ERROR_MESSAGE, httpStatus: pageResponse.status };
      const pageBody: unknown = await pageResponse.json();
      if (!isRecord(pageBody) || !isRecord(pageBody.data)) {
        return { status: "error", message: LOAD_ERROR_MESSAGE };
      }
      if (pageBody.errors !== undefined && (!Array.isArray(pageBody.errors) || pageBody.errors.length > 0)) {
        return { status: "error", message: LOAD_ERROR_MESSAGE, graphqlError: true };
      }
      connection = parseLocationConnection(pageBody.data.locations);
      if (!connection) return { status: "error", message: LOAD_ERROR_MESSAGE };
    }

    return { status: "error", message: LOAD_ERROR_MESSAGE };
  } catch {
    return { status: "error", message: LOAD_ERROR_MESSAGE };
  }
}
