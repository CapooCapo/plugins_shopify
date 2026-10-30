/* eslint-env node */
/* global globalThis */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function loadRoute(t) {
  const calls = [];
  globalThis.__stockhubSizeGuideRouteTest = {
    calls,
    auth: async () => ({
      session: { shop: "test-store.myshopify.com" },
      admin: { graphql: async (...args) => { calls.push(args); throw new Error("Unexpected Shopify call"); } },
    }),
    prisma: new Proxy({}, { get: () => async () => { throw new Error("Invalid input must not touch storage"); } }),
  };
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [{
      name: "stockhub-size-guide-route-test-mocks",
      enforce: "pre",
      resolveId(source) {
        if (source === "../shopify.server") return "\0stockhub-size-guide-test-shopify.server";
        if (source === "../db.server") return "\0stockhub-size-guide-test-db.server";
        return null;
      },
      load(id) {
        if (id === "\0stockhub-size-guide-test-shopify.server") {
          return `export const authenticate = { admin: async (request) => globalThis.__stockhubSizeGuideRouteTest.auth(request) };`;
        }
        if (id === "\0stockhub-size-guide-test-db.server") {
          return `export default globalThis.__stockhubSizeGuideRouteTest.prisma;`;
        }
        return null;
      },
    }],
    server: { middlewareMode: true },
    ssr: { noExternal: ["@shopify/shopify-app-react-router"] },
    logLevel: "error",
  });
  t.after(async () => vite.close());
  return { route: await vite.ssrLoadModule("/app/routes/app.size-guides.tsx"), calls };
}

test("Size Guide action rejects invalid measurement and untrusted product IDs before writes", async (t) => {
  const { route, calls } = await loadRoute(t);
  const chart = new URLSearchParams({
    intent: "save",
    title: "Invalid chart",
    unit: "cm",
    columns: JSON.stringify([{ name: "Size", kind: "label" }, { name: "Chest", kind: "measurement" }]),
    rows: JSON.stringify([["S", "0"]]),
  });
  const invalidChart = await route.action({ request: new Request("http://localhost/app/size-guides", { method: "POST", body: chart }), params: {}, context: {} });
  assert.equal(invalidChart.init.status, 400);
  assert.match(invalidChart.data.error, /positive finite/);

  const invalidProduct = await route.action({ request: new Request("http://localhost/app/size-guides", {
    method: "POST", body: new URLSearchParams({ intent: "assignProducts", guideId: "unknown", productIds: "not-a-shopify-product" }),
  }), params: {}, context: {} });
  assert.equal(invalidProduct.init.status, 400);
  assert.match(invalidProduct.data.error, /valid products from Shopify's product picker/);
  assert.deepEqual(calls, [], "invalid chart or product input cannot call Shopify");
});
