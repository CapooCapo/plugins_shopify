/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const storesRoute = new URL("../app/routes/app.stores.tsx", import.meta.url);
const storeDetailRoute = new URL("../app/routes/app.store.$shop.tsx", import.meta.url);

test("Stores presents only the authenticated Shopify session with read-only detail navigation", async () => {
  const [stores, detail] = await Promise.all([
    readFile(storesRoute, "utf8"),
    readFile(storeDetailRoute, "utf8"),
  ]);

  assert.match(stores, /authenticate\.admin\(request\)/);
  assert.match(stores, /query StockHubAuthorizedStore/);
  assert.match(stores, /<s-section heading="Current session store">/);
  assert.match(stores, /not a multi-store registry/i);
  assert.match(stores, /<s-badge>Authenticated session<\/s-badge>/);
  assert.match(stores, /<s-button href=\{`\/app\/store\/\$\{encodeURIComponent\(store\.myshopifyDomain\)\}`\}[^>]*>View store details<\/s-button>/,
    "the sole store action must navigate to the authenticated store's real detail route");
  assert.equal((stores.match(/<s-button\b/g) ?? []).length, 1,
    "the current-session view offers only its store-details navigation action");
  assert.doesNotMatch(stores, /<Form|<form|name=["'](?:shop|domain)["']|Add (?:another )?store|Connect (?:another )?store|Sync now|Delete store|Disconnect store/i,
    "there must be no fake multi-store connect, add, sync, delete, or disconnect action");
  assert.match(detail, /params\.shop !== session\.shop/,
    "a route parameter must not authorize access to another shop");
  assert.match(detail, /productsCount\(limit: null\)/);
  assert.match(detail, /loadShopifyLocationContext\(admin\)/);
  assert.match(detail, /queryGrantedScopes\(scopes\)/);
  assert.match(detail, /prisma\.importBatch\.findMany\([\s\S]*?where:\s*\{\s*shop:\s*session\.shop\s*\}[\s\S]*?take:\s*5/,
    "recent import activity must be bounded and scoped to the authenticated shop");
  assert.match(detail, /locations\.locations\.slice\(0, 10\)/);
  assert.match(detail, /recentImports\.map/);
  assert.match(detail, /to="\/app\/stores">Back to stores/,
    "store details must have a working return route");
  assert.match(detail, /to="\/app\/products">View products/,
    "store details must route to the existing Products page");
  assert.match(detail, /to="\/app\/imports\/history">View import history/,
    "store details must route to the existing import-history page");
  assert.doesNotMatch(detail, /not changed by Sprint 1/i);
});

test("Store Details distinguishes confirmed missing read scopes from unknown authorization", async () => {
  const detail = await readFile(storeDetailRoute, "utf8");

  assert.match(detail, /const scopesVerified = Boolean\([\s\S]*?grantedScopes && locationScopes && sameScopeGrant\(grantedScopes, locationScopes\)/,
    "authorization is known only when both current grants are returned and match");
  assert.match(detail, /queryGrantedScopes\(scopes\)\.catch\(\(\) => null\)/,
    "a failed grant lookup must remain unknown instead of being treated as verified");
  assert.match(detail, /scopesVerified && missingReadScopes\.length \?/,
    "missing-scope diagnostics may be rendered only after grant verification");
  assert.match(detail, /Confirmed missing read access: \{missingReadScopes\.join\(", "\)\}/,
    "only verified grants may produce a confirmed-missing warning");
  assert.match(detail, /Current Shopify grants and location access could not be cross-checked/,
    "unavailable or conflicting grant data must be described as unknown");
  assert.match(detail, /scopesVerified \? \(\s*<s-text>Required read scopes are granted:/,
    "complete verified grants must have their own success state");
});
