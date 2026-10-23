/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scopesModuleUrl = new URL("../app/utils/shopify-scopes.server.ts", import.meta.url);
const importsRouteUrl = new URL("../app/routes/app.imports._index.tsx", import.meta.url);

async function getShopifyScopesHelpers() {
  try {
    const helpers = await import("../app/utils/shopify-scopes.server.ts");
    assert.equal(typeof helpers.queryGrantedScopes, "function");
    assert.equal(typeof helpers.missingScopesForGrant, "function");
    return helpers;
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      assert.fail(
        `Missing regression target ${scopesModuleUrl.pathname}#queryGrantedScopes`,
      );
    }
    throw error;
  }
}

test("current Shopify grants win over stale persisted session scope", async () => {
  const { queryGrantedScopes, missingScopesForGrant } = await getShopifyScopesHelpers();
  const sessionScope = "read_locations,write_inventory,write_products";
  const requiredReadScopes = ["read_products", "read_inventory"];
  const grantedByShopify = [
    "read_inventory",
    "read_locations",
    "read_products",
    "write_inventory",
    "write_products",
  ];

  const granted = await queryGrantedScopes({
    async query() {
      return { granted: grantedByShopify, required: [], optional: [] };
    },
  });

  assert.ok(
    requiredReadScopes.some((scope) => !sessionScope.split(",").includes(scope)),
    "the fixture must model a stale Prisma Session.scope value",
  );
  assert.deepEqual(
    missingScopesForGrant(granted, requiredReadScopes),
    [],
    "the scopes Shopify currently grants must satisfy the read authorization check",
  );
});

test("Imports loader, preview and merge authorize from Shopify's queried grant, not session.scope", async () => {
  const source = await readFile(importsRouteUrl, "utf8");
  const loader = source.slice(source.indexOf("export const loader"), source.indexOf("export const action"));
  const action = source.slice(source.indexOf("export const action"));

  assert.match(source, /queryGrantedScopes\s*\(\s*scopes\s*\)/);
  assert.match(source, /missingScopesForGrant\s*\(\s*grantedScopes\s*,/);
  assert.match(loader, /missingScopesForGrant\s*\(\s*grantedScopes\s*,/);
  assert.match(action, /missingScopesForGrant\s*\(\s*grantedScopes\s*,/);
  assert.doesNotMatch(
    source,
    /missingScopes\s*\(\s*session\.scope\s*,/,
    "stale persisted scope metadata must not gate UI, preview, or merge authorization",
  );
});

test("Shopify scope query errors or malformed grants fail closed", async () => {
  const { queryGrantedScopes } = await getShopifyScopesHelpers();

  await assert.rejects(
    queryGrantedScopes({
      async query() {
        throw new Error("Shopify scope query failed");
      },
    }),
    /Shopify scope query failed/,
  );
  await assert.rejects(
    queryGrantedScopes({
      async query() {
        return { granted: "read_products" };
      },
    }),
    /scope|grant/i,
  );
});

test("conflicting current Shopify scope responses disable the loader UI and reject preview and merge", async () => {
  const [source, detail] = await Promise.all([
    readFile(importsRouteUrl, "utf8"),
    readFile(new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url), "utf8"),
  ]);
  const loader = source.slice(source.indexOf("export const loader"), source.indexOf("export const action"));
  const action = source.slice(source.indexOf("export const action"));
  const previewDisabled = source.slice(
    source.indexOf("const previewDisabled ="),
    source.indexOf(";", source.indexOf("const previewDisabled =")),
  );
  const mergeDisabled = detail.match(/const mergeDisabled\s*=\s*([^;]+);/)?.[1] ?? "";
  assert.match(
    loader,
    /authorizationStatus\s*===\s*"verified"[\s\S]*?!sameScopeGrant\(grantedScopes,\s*locationScopes\)[\s\S]*?authorizationStatus\s*=\s*"mismatch"[\s\S]*?locationStatus\s*=\s*"error"/,
    "a disagreement between the SDK grant and location-query grant must mark loader authorization invalid",
  );
  assert.match(
    loader,
    /if\s*\(authorizationStatus\s*===\s*"mismatch"\)\s*\{[\s\S]*?locations\s*=\s*\[\][\s\S]*?missingLocationScopes\s*=\s*\[\]/,
    "the loader must not expose locations after current Shopify grant sources disagree",
  );
  assert.match(previewDisabled, /data\.authorizationStatus\s*!==\s*"verified"/);
  assert.match(mergeDisabled, /!scopesVerified[\s\S]*missingReadScopes\.length\s*>\s*0[\s\S]*missingWriteScopes\.includes\("write_inventory"\)[\s\S]*productWriteRequired\s*&&\s*missingWriteScopes\.includes\("write_products"\)/,
    "the receipt action requires verified read scopes and inventory write, and requires product write only when eligible product creation needs it");
  assert.match(
    action,
    /const needsProductWrite\s*=\s*batch\.lines\.some\([\s\S]*?line\.operationType\s*===\s*"CREATE_DRAFT"[\s\S]*?!\["VARIANT_PRICE_CONFIGURED",\s*"INVENTORY_ACTIVATING",\s*"INVENTORY_ACTIVE"\]\.includes\(line\.stage\)[\s\S]*?if\s*\(needsProductWrite\)\s*neededScopes\.add\("write_products"\)/,
    "the action's write_products requirement must remain conditional on an eligible product-creation stage",
  );
  assert.match(
    action,
    /if\s*\(!sameScopeGrant\(grantedScopes,\s*locationContext\.scopes\)\)\s*\{\s*return\s*\{\s*authorizationError:\s*SCOPE_VERIFICATION_MISMATCH\s*\}/,
    "merge must reject when its Shopify scope sources disagree",
  );
  assert.match(
    action,
    /if\s*\(!sameScopeGrant\(grantedScopes,\s*locationContext\.scopes\)\)\s*\{\s*return\s*\{\s*authorizationError:\s*SCOPE_VERIFICATION_MISMATCH\s*\}/,
    "preview must reject when its Shopify scope sources disagree",
  );
});
