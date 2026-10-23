/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getGraphQLData,
  ShopifyGraphQLError,
} from "../app/utils/shopify-graphql.server.ts";

const importsRouteUrl = new URL("../app/routes/app.imports._index.tsx", import.meta.url);
const mergeServiceUrl = new URL("../app/utils/import-merge.server.ts", import.meta.url);
const locationServiceUrl = new URL("../app/utils/shopify-locations.server.ts", import.meta.url);
const locationServiceSpecifier = "../app/utils/shopify-locations.server.ts";

async function readSource(url) {
  return readFile(url, "utf8");
}

async function readLocationServiceSource() {
  try {
    return await readSource(locationServiceUrl);
  } catch (error) {
    if (error?.code === "ENOENT") {
      assert.fail(`Missing regression target ${locationServiceSpecifier}`);
    }
    throw error;
  }
}

function expectContract(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

function expectNoContract(source, pattern, message) {
  assert.ok(!pattern.test(source), message);
}

function makeAdmin(data) {
  const queries = [];
  return {
    queries,
    async graphql(query, options) {
      queries.push({ query, options });
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

function makeAdminResponse(response) {
  const calls = [];
  return {
    calls,
    async graphql(query, options) {
      calls.push({ query, options });
      return new Response(response.body, {
        status: response.status ?? 200,
        headers: { "Content-Type": response.contentType ?? "application/json" },
      });
    },
  };
}

async function loadShopifyLocationContext(admin) {
  let locationService;
  try {
    locationService = await import(locationServiceSpecifier);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail(`Missing regression target ${locationServiceSpecifier}#loadShopifyLocationContext`);
    }
    throw error;
  }

  assert.equal(
    typeof locationService.loadShopifyLocationContext,
    "function",
    `${locationServiceSpecifier} must export loadShopifyLocationContext(admin)`,
  );
  return locationService.loadShopifyLocationContext(admin);
}

function adminResponse(data, status = 200) {
  return {
    status,
    body: JSON.stringify({ data }),
  };
}

test("loadShopifyLocationContext returns actual active locations, domain, currency, and scopes", async () => {
  const admin = makeAdminResponse(adminResponse({
    shop: { myshopifyDomain: "merchant.myshopify.com", currencyCode: "VND" },
    currentAppInstallation: {
      accessScopes: [
        { handle: "read_products" },
        { handle: "read_inventory" },
        { handle: "read_locations" },
      ],
    },
    locations: {
      nodes: [
        { id: "gid://shopify/Location/11", name: "HCM", isActive: true },
        { id: "gid://shopify/Location/12", name: "Inactive", isActive: false },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  }));

  const result = await loadShopifyLocationContext(admin);

  assert.equal(result.status, "ready");
  assert.equal(result.shopDomain, "merchant.myshopify.com");
  assert.equal(result.currencyCode, "VND");
  assert.deepEqual(result.scopes, ["read_products", "read_inventory", "read_locations"]);
  assert.deepEqual(result.locations, [
    { id: "gid://shopify/Location/11", name: "HCM", isActive: true },
  ]);
  assert.equal(admin.calls.length, 1);
  assert.match(admin.calls[0].query, /currentAppInstallation\s*\{\s*accessScopes\s*\{\s*handle\s*\}/s);
  assert.match(admin.calls[0].query, /locations\s*\(\s*first:\s*20\s*,\s*includeInactive:\s*false\s*\)/);
});

test("loadShopifyLocationContext includes an authorized active location after the first 20", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 20 }, (_, index) => ({
    id: `gid://shopify/Location/${index + 1}`,
    name: `Warehouse ${index + 1}`,
    isActive: true,
  }));
  const laterLocation = {
    id: "gid://shopify/Location/21",
    name: "Warehouse 21",
    isActive: true,
  };
  const admin = {
    async graphql(query, options) {
      calls.push({ query, options });
      const page = calls.length === 1
        ? { nodes: firstPage, pageInfo: { hasNextPage: true, endCursor: "cursor-20" } }
        : { nodes: [laterLocation], pageInfo: { hasNextPage: false, endCursor: null } };
      return new Response(JSON.stringify({ data: {
        shop: { myshopifyDomain: "merchant.myshopify.com", currencyCode: "VND" },
        currentAppInstallation: { accessScopes: [{ handle: "read_locations" }] },
        locations: page,
      } }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  };

  const result = await loadShopifyLocationContext(admin);

  assert.equal(result.status, "ready");
  assert.equal(result.locations.length, 21);
  assert.deepEqual(result.locations.at(-1), laterLocation);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options?.variables?.after, "cursor-20");
});

test("loadShopifyLocationContext reports an actionable missing-scope result when neither location-read scope is installed", async () => {
  const admin = makeAdminResponse(adminResponse({
    shop: { myshopifyDomain: "merchant.myshopify.com", currencyCode: "VND" },
    currentAppInstallation: {
      accessScopes: [{ handle: "read_products" }],
    },
    locations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  }));

  const result = await loadShopifyLocationContext(admin);

  assert.equal(result.status, "missing_scope");
  assert.deepEqual(result.missingScopes, ["read_locations"]);
  assert.match(result.message, /read_locations/);
  assert.match(result.message, /authorize|permission|scope/i);
});

test("read_inventory alone is insufficient for location names and active status", async () => {
  const admin = makeAdminResponse(adminResponse({
    shop: { myshopifyDomain: "merchant.myshopify.com", currencyCode: "VND" },
    currentAppInstallation: {
      accessScopes: [
        { handle: "read_products" },
        { handle: "read_inventory" },
      ],
    },
    locations: { nodes: [] },
  }));

  const result = await loadShopifyLocationContext(admin);

  assert.equal(result.status, "missing_scope");
  assert.deepEqual(result.missingScopes, ["read_locations"]);
  assert.match(result.message, /read_locations/);
  if (Array.isArray(result.scopes)) {
    assert.deepEqual(result.scopes, ["read_products", "read_inventory"]);
  }
});

test("partial ACCESS_DENIED data with read_inventory but no read_locations is diagnosed as missing_scope", async () => {
  const admin = makeAdminResponse({
    body: JSON.stringify({
      data: {
        shop: { myshopifyDomain: "merchant.myshopify.com", currencyCode: "VND" },
        currentAppInstallation: {
          accessScopes: [
            { handle: "read_products" },
            { handle: "read_inventory" },
          ],
        },
        locations: null,
      },
      errors: [
        {
          message: "Access denied for locations.name and locations.isActive",
          extensions: { code: "ACCESS_DENIED" },
        },
      ],
    }),
  });

  const result = await loadShopifyLocationContext(admin);

  assert.equal(result.status, "missing_scope");
  assert.deepEqual(result.missingScopes, ["read_locations"]);
  assert.match(result.message, /read_locations/);
  if (Array.isArray(result.scopes)) {
    assert.deepEqual(result.scopes, ["read_products", "read_inventory"]);
  }
});

test("loadShopifyLocationContext keeps a successful empty location list distinct from failure", async () => {
  const admin = makeAdminResponse(adminResponse({
    shop: { myshopifyDomain: "merchant.myshopify.com", currencyCode: "VND" },
    currentAppInstallation: {
      accessScopes: [{ handle: "read_inventory" }, { handle: "read_locations" }],
    },
    locations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  }));

  const result = await loadShopifyLocationContext(admin);

  assert.equal(result.status, "ready");
  assert.deepEqual(result.locations, []);
  assert.equal(result.error, undefined);
});

test("loadShopifyLocationContext sanitizes GraphQL failures and returns actionable errors", async () => {
  const secret = "shpat-sensitive-mock-token";
  const admin = makeAdminResponse({
    body: JSON.stringify({ errors: [{ message: `ACCESS_DENIED with ${secret}` }] }),
  });

  const result = await loadShopifyLocationContext(admin);

  assert.equal(result.status, "error");
  assert.match(result.message, /location|Shopify|permission|scope/i);
  assert.doesNotMatch(result.message, /shpat-sensitive-mock-token/);
});

test("loadShopifyLocationContext sanitizes HTTP/API failures without leaking response bodies", async () => {
  const secret = "shpat-sensitive-mock-token";
  const admin = makeAdminResponse({
    status: 502,
    body: `upstream timeout token=${secret}`,
    contentType: "text/plain",
  });

  const result = await loadShopifyLocationContext(admin);

  assert.equal(result.status, "error");
  assert.match(result.message, /location|Shopify|API|retry/i);
  assert.doesNotMatch(result.message, /shpat-sensitive-mock-token/);
});

test("location context query includes authenticated shop identity and currency", async () => {
  const [route, service] = await Promise.all([
    readSource(importsRouteUrl),
    readLocationServiceSource(),
  ]);

  expectContract(route, /authenticate\.admin\(request\)/, "location query must use the authenticated Admin context");
  expectContract(service, /shop\s*\{[^}]*myshopifyDomain[^}]*currencyCode/s, "query must read the authenticated shop domain and currency");
  expectNoContract(route, /currentAppInstallation/, "query must be defined once in the location utility, not duplicated in the route");
  expectNoContract(route, /query\s+StockHubImportLocations|const\s+CONTEXT_QUERY/, "route must not retain a duplicate locations query");
});

test("location context inspects installed scopes and diagnoses a missing read permission", async () => {
  const service = await readLocationServiceSource();

  expectContract(service, /currentAppInstallation\s*\{\s*accessScopes\s*\{\s*handle\s*\}/s, "query must inspect scopes granted to this app installation");
  expectContract(service, /missingScopes[\s\S]*read_locations/, "loader must report the required read_locations scope from the installation scope list");
  expectContract(service, /read_locations/, "location query diagnostics must name read_locations");
});

test("location context explicitly requests active locations", async () => {
  const service = await readLocationServiceSource();

  expectContract(service, /locations\s*\(\s*first:\s*20\s*,\s*includeInactive:\s*false\s*\)/, "query must ask Shopify for active locations only");
  expectContract(service, /nodes\s*\{\s*id\s+name\s+isActive\s*\}/, "query must use Shopify location IDs, names and active status");
});

test("mocked Admin GraphQL location data preserves actual fields and filters inactive rows", async () => {
  const mockedData = {
    shop: { myshopifyDomain: "merchant.myshopify.com", currencyCode: "VND" },
    currentAppInstallation: {
      accessScopes: [
        { handle: "read_products" },
        { handle: "read_inventory" },
        { handle: "read_locations" },
      ],
    },
    locations: {
      nodes: [
        { id: "gid://shopify/Location/11", name: "HCM", isActive: true },
        { id: "gid://shopify/Location/12", name: "Inactive", isActive: false },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  const admin = makeAdmin(mockedData);
  const response = await admin.graphql("DiagnoseStockHubLocations");
  const data = await getGraphQLData(response);

  assert.equal(data.shop.myshopifyDomain, "merchant.myshopify.com");
  assert.deepEqual(data.currentAppInstallation.accessScopes.map(({ handle }) => handle), [
    "read_products",
    "read_inventory",
    "read_locations",
  ]);
  assert.equal(data.shop.currencyCode, "VND");
  assert.deepEqual(
    data.locations.nodes.filter(({ isActive }) => isActive),
    [{ id: "gid://shopify/Location/11", name: "HCM", isActive: true }],
  );
  assert.equal(admin.queries.length, 1);

});

test("a successful empty location connection is not represented as an API/load failure", async () => {
  const admin = makeAdmin({
    shop: { myshopifyDomain: "merchant.myshopify.com", currencyCode: "VND" },
    currentAppInstallation: { accessScopes: [{ handle: "read_inventory" }] },
    locations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  });
  const data = await getGraphQLData(await admin.graphql("DiagnoseStockHubLocations"));

  assert.deepEqual(data.locations.nodes, []);
});

test("GraphQL errors become sanitized failures without reflecting token-bearing details", async () => {
  const secret = "shpat-sensitive-mock-token";
  const response = new Response(
    JSON.stringify({ errors: [{ message: `Unauthorized with ${secret}` }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(getGraphQLData(response), (error) => {
    assert.ok(error instanceof ShopifyGraphQLError);
    assert.doesNotMatch(error.message, /shpat-sensitive-mock-token/);
    return true;
  });
});

test("Merge revalidates the submitted location against this authenticated store server-side", async () => {
  const [route, mergeService] = await Promise.all([
    readSource(importsRouteUrl),
    readSource(mergeServiceUrl),
  ]);

  expectContract(route, /authenticate\.admin\(request\)/, "route must authenticate before location-sensitive actions");
  expectContract(route, /await\s+queryLocations\(admin\)/, "preview must query actual locations with the session Admin API");
  expectContract(route, /candidate\.id\s*===\s*locationId\s*&&\s*candidate\.isActive/, "preview must reject submitted IDs that are not actual active locations");
  expectContract(route, /mergeImportBatch\s*\(\s*\{[^}]*shop:\s*session\.shop/s, "merge must be scoped to the authenticated shop");
  expectContract(mergeService, /readLocations\s*\(\s*admin\s*\)/, "merge service must re-fetch locations server-side");
  expectContract(mergeService, /location\.id\s*===\s*batch\.locationId/, "merge service must match the persisted location ID");
  expectContract(mergeService, /!verifiedLocation\s*\|\|\s*!verifiedLocation\.isActive/, "merge must reject missing or inactive locations");
});
