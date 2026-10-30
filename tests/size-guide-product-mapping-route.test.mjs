/* eslint-env node */
/* global globalThis */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const guideId = "guide-a";
const productA = "gid://shopify/Product/101";
const productB = "gid://shopify/Product/202";

function createState({ shop = "shop-a.myshopify.com", graphQLFailure = null, missingIds = [] } = {}) {
  return {
    shop,
    graphQLFailure,
    missingIds: new Set(missingIds),
    graphQLCalls: [],
    repositoryCalls: [],
    writeCalls: 0,
    assignments: new Map(),
    locks: new Set(),
    guides: new Map([[`${shop}\u0000${guideId}`, { id: guideId, shop }]]),
  };
}

async function loadRoute(t, state) {
  globalThis.__stockhubSizeGuideMappingTest = state;
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [{
      name: "stockhub-size-guide-product-mapping-route-test-mocks",
      enforce: "pre",
      resolveId(source) {
        if (source === "../shopify.server") return "\0stockhub-size-guide-mapping-shopify";
        if (source === "../db.server") return "\0stockhub-size-guide-mapping-db";
        if (source === "../utils/size-guide-repository.server") return "\0stockhub-size-guide-mapping-repository";
        if (source === "../utils/size-guide-sync.server") return "\0stockhub-size-guide-mapping-sync";
        return null;
      },
      load(id) {
        if (id === "\0stockhub-size-guide-mapping-shopify") return `
          export const authenticate = { admin: async () => ({
            session: { shop: globalThis.__stockhubSizeGuideMappingTest.shop },
            admin: { graphql: async (...args) => {
              const state = globalThis.__stockhubSizeGuideMappingTest;
              state.graphQLCalls.push(args);
              if (state.graphQLFailure) return state.graphQLFailure;
              const variables = args[1]?.variables ?? {};
              return Response.json({ data: { nodes: (variables.ids ?? []).map((id) => state.missingIds.has(id) ? null : ({
                id, title: id.endsWith("101") ? "Tee A" : "Tee B", featuredImage: null,
              })) } });
            } },
          }) };
        `;
        if (id === "\0stockhub-size-guide-mapping-db") return `export default {};`;
        if (id === "\0stockhub-size-guide-mapping-repository") return `
          const state = () => globalThis.__stockhubSizeGuideMappingTest;
          export async function getSizeGuide(shop, id) {
            return state().guides.get(shop + "\\u0000" + id) ?? null;
          }
          export async function assignSizeGuideProducts(input) {
            state().repositoryCalls.push(input);
            const conflicts = [];
            for (const item of input.products) {
              const key = input.shop + "\\u0000" + item.id;
              if (state().locks.has(key)) return { status: "locked", productIds: [item.id] };
              const existing = state().assignments.get(key);
              if (existing && existing.guideId !== input.guideId) conflicts.push({ productId: item.id, currentGuideId: existing.guideId });
            }
            if (conflicts.length && (!input.confirmReplacements ||
              conflicts.some((item) => !input.replaceProductIds.includes(item.productId)))) {
              return { status: "replacement_confirmation_required", conflicts };
            }
            state().writeCalls += 1;
            const unchangedProductIds = [];
            const assignmentIds = [];
            for (const item of input.products) {
              const key = input.shop + "\\u0000" + item.id;
              const existing = state().assignments.get(key);
              if (existing?.guideId === input.guideId) unchangedProductIds.push(item.id);
              const assignment = existing ?? { shop: input.shop, guideId: input.guideId, productId: item.id, productTitle: item.title };
              assignment.guideId = input.guideId;
              assignment.productTitle = item.title;
              state().assignments.set(key, assignment);
              assignmentIds.push(item.id);
            }
            return { status: "assigned", assignmentIds, unchangedProductIds };
          }
          export async function createSizeGuide() { throw new Error("unexpected repository call"); }
          export async function createSizeGuideAssignment() { throw new Error("unexpected single-product assignment"); }
          export async function deleteSizeGuide() { throw new Error("unexpected repository call"); }
          export async function getSizeGuideAssignment() { return null; }
          export async function listGuideAssignments() { return []; }
          export async function listOrphanedSizeGuideSyncLocks() { return []; }
          export async function listSizeGuides() { return []; }
          export async function saveSizeGuide() { throw new Error("unexpected repository call"); }
        `;
        if (id === "\0stockhub-size-guide-mapping-sync") return `
          export async function removeSizeGuideAssignment() { return { status: "success" }; }
          export async function retryOrphanedSizeGuideCleanup() { return { status: "success" }; }
          export async function retrySizeGuideRemoval() { return { status: "success" }; }
          export async function retrySizeGuideSync() { return { status: "success" }; }
          export async function syncSizeGuideAssignment() { return { status: "success" }; }
        `;
        return null;
      },
    }],
    server: { middlewareMode: true },
    ssr: { noExternal: ["@shopify/shopify-app-react-router"] },
    logLevel: "error",
  });
  t.after(async () => vite.close());
  return vite.ssrLoadModule("/app/routes/app.size-guides.tsx");
}

function assignmentRequest(productIds, extra = {}) {
  const body = new URLSearchParams({ intent: "assignProducts", guideId, ...extra });
  for (const id of productIds) body.append("productIds", id);
  return new Request("http://localhost/app/size-guides", { method: "POST", body });
}

function statusOf(result) { return result.init?.status ?? result.status; }

test("bulk product assignment verifies GIDs in one batch and deduplicates before persistence", async (t) => {
  const state = createState();
  const route = await loadRoute(t, state);
  const result = await route.action({ request: assignmentRequest([productA, productB, productA]), params: {}, context: {} });

  assert.ok(statusOf(result) < 400, "a valid picker selection should be accepted");
  assert.equal(state.graphQLCalls.length, 1, "all selected products should be fetched in one Admin GraphQL call");
  assert.deepEqual(state.graphQLCalls[0][1].variables.ids, [productA, productB]);
  assert.deepEqual(state.repositoryCalls[0].products.map((product) => product.id), [productA, productB]);
  assert.match(state.graphQLCalls[0][0], /nodes\s*\(/);
  assert.equal(state.writeCalls, 1);
  assert.deepEqual([...state.assignments.values()].map((assignment) => assignment.productId), [productA, productB]);
});

test("a selected product assigned to another guide requires explicit replacement confirmation", async (t) => {
  const state = createState();
  state.assignments.set(`${state.shop}\u0000${productA}`, { shop: state.shop, guideId: "guide-old", productId: productA });
  state.guides.set(`${state.shop}\u0000guide-new`, { id: "guide-new", shop: state.shop });
  const route = await loadRoute(t, state);

  const rejected = await route.action({ request: assignmentRequest([productA], { guideId: "guide-new" }), params: {}, context: {} });
  assert.equal(statusOf(rejected), 409);
  assert.equal(state.writeCalls, 0, "unconfirmed replacement must not write any assignment");

  const confirmed = await route.action({
    request: assignmentRequest([productA], { guideId: "guide-new", replaceProductIds: productA, confirmReplacements: "yes" }),
    params: {}, context: {},
  });
  assert.ok(statusOf(confirmed) < 400);
  assert.equal(state.repositoryCalls[0].shop, state.shop);
  assert.deepEqual(state.repositoryCalls.at(-1).replaceProductIds, [productA]);
  assert.equal(state.repositoryCalls.at(-1).confirmReplacements, true);
  assert.equal(state.assignments.get(`${state.shop}\u0000${productA}`).guideId, "guide-new");
});

test("bulk assignment is isolated to the authenticated shop and empty selection is a no-submit no-op", async (t) => {
  const state = createState({ shop: "shop-a.myshopify.com" });
  state.assignments.set(`shop-b.myshopify.com\u0000${productA}`, {
    shop: "shop-b.myshopify.com", guideId: "guide-b", productId: productA,
  });
  const route = await loadRoute(t, state);

  const empty = await route.action({ request: assignmentRequest([]), params: {}, context: {} });
  assert.equal(statusOf(empty), 400);
  assert.equal(state.graphQLCalls.length, 0);
  assert.equal(state.repositoryCalls.length, 0);

  const result = await route.action({ request: assignmentRequest([productA]), params: {}, context: {} });
  assert.ok(statusOf(result) < 400);
  assert.equal(state.repositoryCalls[0].shop, "shop-a.myshopify.com");
  assert.equal(state.assignments.get(`shop-b.myshopify.com\u0000${productA}`).guideId, "guide-b");
});

test("reselecting a product already assigned to this guide is idempotent", async (t) => {
  const state = createState();
  state.assignments.set(`${state.shop}\u0000${productA}`, {
    shop: state.shop, guideId, productId: productA, productTitle: "Tee A",
  });
  const route = await loadRoute(t, state);
  const result = await route.action({ request: assignmentRequest([productA]), params: {}, context: {} });

  assert.ok(statusOf(result) < 400);
  assert.equal(state.assignments.size, 1, "reselection must not create a second active mapping");
  assert.equal(state.assignments.get(`${state.shop}\u0000${productA}`).guideId, guideId);
});

test("product permission failures and other Admin API failures are distinguishable", async (t) => {
  for (const [kind, failure] of [
    ["permission", Response.json({ errors: [{ message: "Access denied", extensions: { code: "ACCESS_DENIED" } }] })],
    ["permission", new Response("Unauthorized", { status: 401 })],
    ["permission", new Response("Forbidden", { status: 403 })],
    ["api", new Response("upstream unavailable", { status: 503 })],
  ]) {
    const state = createState({ graphQLFailure: failure });
    const route = await loadRoute(t, state);
    const result = await route.action({ request: assignmentRequest([productA]), params: {}, context: {} });
    assert.equal(result.data.errorType, kind);
    assert.equal(statusOf(result), kind === "permission" ? 403 : 502);
    assert.equal(state.writeCalls, 0, "product query failures must be reported before any database writes");
  }
});

test("missing Shopify products and active sync locks prevent all assignment writes", async (t) => {
  const missing = createState({ missingIds: [productB] });
  const missingRoute = await loadRoute(t, missing);
  const missingResult = await missingRoute.action({
    request: assignmentRequest([productA, productB]), params: {}, context: {},
  });
  assert.ok(statusOf(missingResult) >= 400);
  assert.equal(missing.writeCalls, 0, "partial Shopify lookup results must not partially persist a selection");

  const locked = createState();
  locked.locks.add(`${locked.shop}\u0000${productA}`);
  const lockedRoute = await loadRoute(t, locked);
  const lockedResult = await lockedRoute.action({ request: assignmentRequest([productA]), params: {}, context: {} });
  assert.equal(statusOf(lockedResult), 409);
  assert.equal(locked.writeCalls, 0, "active publish/cleanup fence must block mapping changes");
});
