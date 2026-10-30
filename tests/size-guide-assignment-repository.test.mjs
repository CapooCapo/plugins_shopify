/* eslint-env node */
/* global globalThis */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";

const shop = "assignment-repository-test.myshopify.com";
const guideId = "guide-current";
const productId = "gid://shopify/Product/101";
const assignmentId = "assignment-pending";

async function loadRepository(t, initialState) {
  const globalKey = `__stockhubSizeGuideAssignmentRepositoryTest_${randomUUID().replaceAll("-", "")}`;
  globalThis[globalKey] = initialState;
  t.after(() => { delete globalThis[globalKey]; });

  const dbVirtualId = `\0stockhub-size-guide-assignment-repository-db-${randomUUID()}`;
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [{
      name: "stockhub-size-guide-assignment-repository-db-mock",
      enforce: "pre",
      resolveId(source) {
        return source === "../db.server" ? dbVirtualId : null;
      },
      load(id) {
        if (id === dbVirtualId) return `export default globalThis[${JSON.stringify(globalKey)}].prisma;`;
        return null;
      },
    }],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    ssr: { external: ["@prisma/client"] },
    logLevel: "error",
  });
  t.after(async () => vite.close());
  return vite.ssrLoadModule("/app/utils/size-guide-assignment-repository.server.ts");
}

test("same-guide PENDING assignments are not reported as unchanged", async (t) => {
  const state = {
    assignments: [{
      id: assignmentId,
      productId,
      guideId,
      syncStatus: "PENDING",
      lastError: null,
    }],
    locks: [],
    reads: [],
    writes: [],
  };
  state.prisma = {
    async $transaction(callback) {
      return callback({
        async $queryRaw(strings, ...values) {
          const query = strings.join("?");
          state.reads.push({ query, values });
          if (query.includes('FROM "SizeGuide" WHERE')) return [{ id: guideId }];
          if (query.includes("pg_advisory_xact_lock")) return [];
          if (query.includes('FROM "SizeGuideProduct" WHERE')) return state.assignments;
          if (query.includes('FROM "SizeGuideProductSyncLock" WHERE')) return state.locks;
          throw new Error(`Unexpected Prisma query: ${query}`);
        },
        async $executeRaw(strings, ...values) {
          state.writes.push({ query: strings.join("?"), values });
          return 1;
        },
      });
    },
  };

  const repository = await loadRepository(t, state);
  const result = await repository.assignSizeGuideProducts({
    shop,
    guideId,
    products: [{ id: productId, title: "Essential Cotton T-Shirt" }],
    replaceProductIds: [],
    confirmReplacements: false,
  });

  assert.equal(result.status, "assigned");
  if (result.status !== "assigned") return;
  assert.deepEqual(result.assignmentIds, [assignmentId]);
  assert.deepEqual(
    result.unchangedProductIds,
    [],
    "a same-guide PENDING mapping must remain eligible for publish instead of being treated as unchanged",
  );
  assert.equal(state.writes.length, 0, "the repository should report pending work without mutating the assignment row");
});
