/* eslint-env node */
/* global globalThis */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { createSizeGuideRepositoryMockSource } from "./size-guide-sync-repository-mock.mjs";

const shop = "test-store.myshopify.com";
const productId = "gid://shopify/Product/123";
const stateName = "__stockhubSizeGuideProductLockRace";
const lockKey = `${shop}\u0000${productId}`;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function assignment(id, guideId, title, chest, updatedAt) {
  return {
    id,
    shop,
    guideId,
    productId,
    productTitle: "Everyday shirt",
    syncStatus: "PENDING",
    syncedGuideUpdatedAt: null,
    lastError: null,
    guide: {
      id: guideId,
      shop,
      title,
      unit: "cm",
      columns: [{ name: "Size", kind: "label" }, { name: "Chest", kind: "measurement" }],
      rows: [["S", chest]],
      updatedAt: new Date(updatedAt),
    },
  };
}

async function loadInstance(t) {
  const repositorySource = createSizeGuideRepositoryMockSource(stateName);
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [{
      name: "stockhub-size-guide-product-lock-test-repository",
      enforce: "pre",
      resolveId(source) {
        return source === "./size-guide-repository.server" || source === "virtual:size-guide-repository-mock"
          ? "\0stockhub-size-guide-product-lock-repository" : null;
      },
      load(id) { return id === "\0stockhub-size-guide-product-lock-repository" ? repositorySource : null; },
    }],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "error",
  });
  t.after(async () => vite.close());
  const [sync, repository] = await Promise.all([
    vite.ssrLoadModule("/app/utils/size-guide-sync.server.ts"),
    vite.ssrLoadModule("virtual:size-guide-repository-mock"),
  ]);
  return { sync, repository };
}

function adminFor(state, { failFirstDelete = false } = {}) {
  return {
    graphql: async (query, { variables }) => {
      if (query.includes("StockHubSetSizeGuide")) {
        state.setCalls += 1;
        state.publicMetafield = variables.metafields[0].value;
        return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
      }
      if (query.includes("StockHubDeleteSizeGuide")) {
        state.deleteCalls += 1;
        state.publicMetafield = null;
        if (failFirstDelete && state.deleteCalls === 1) {
          throw new Error("Simulated lost response after Shopify applied metafieldsDelete");
        }
        return Response.json({ data: { metafieldsDelete: { userErrors: [] } } });
      }
      throw new Error("Unexpected GraphQL operation");
    },
  };
}

test("durable cleanup fence blocks a second module and assignment creation until stale publish is reconciled", async (t) => {
  const state = {
    assignments: { "old-assignment": assignment("old-assignment", "old-guide", "Old guide", "88", "2026-10-29T00:00:00.000Z") },
    locks: {},
    nextToken: 0,
    setCalls: 0,
    deleteCalls: 0,
    publicMetafield: null,
    oldPublishStarted: deferred(),
    oldPublishGate: deferred(),
    cleanupStarted: deferred(),
    cleanupGate: deferred(),
  };
  globalThis[stateName] = state;
  const instanceA = await loadInstance(t);
  const instanceB = await loadInstance(t);
  const admin = adminFor(state);
  const originalGraphql = admin.graphql;
  admin.graphql = async (query, options) => {
    if (query.includes("StockHubSetSizeGuide") && JSON.parse(options.variables.metafields[0].value).title === "Old guide") {
      state.oldPublishStarted.resolve();
      await state.oldPublishGate.promise;
    }
    if (query.includes("StockHubDeleteSizeGuide")) {
      state.cleanupStarted.resolve();
      await state.cleanupGate.promise;
    }
    return originalGraphql(query, options);
  };

  const oldPublish = instanceA.sync.syncSizeGuideAssignment(admin, shop, "old-assignment");
  await state.oldPublishStarted.promise;
  delete state.assignments["old-assignment"];
  state.oldPublishGate.resolve();
  await state.cleanupStarted.promise;
  assert.equal(state.locks[lockKey].state, "CLEANUP", "cleanup fence is durable before Shopify delete begins");

  const newAssignment = assignment("new-assignment", "new-guide", "New guide", "96", "2026-10-29T00:01:00.000Z");
  await assert.rejects(
    instanceB.repository.createSizeGuideAssignment({ shop, productId, assignment: newAssignment }),
    /SIZE_GUIDE_PRODUCT_SYNC_LOCKED/,
    "a new assignment cannot be attached while the orphan cleanup lease is held",
  );
  assert.deepEqual(await instanceB.sync.syncSizeGuideAssignment(admin, shop, "new-assignment"), { status: "unchanged" });
  assert.equal(state.setCalls, 1, "the second module cannot publish through the cleanup fence");

  state.cleanupGate.resolve();
  assert.deepEqual(await oldPublish, { status: "unchanged" });
  assert.equal(state.locks[lockKey], undefined, "successful cleanup releases the product lock");

  await instanceB.repository.createSizeGuideAssignment({ shop, productId, assignment: newAssignment });
  assert.deepEqual(await instanceB.sync.syncSizeGuideAssignment(admin, shop, "new-assignment"), { status: "synced" });
  assert.equal(state.assignments["new-assignment"].syncStatus, "SYNCED");
  assert.equal(JSON.parse(state.publicMetafield).title, "New guide");
});

test("lost delete response leaves a CLEANUP fence; another instance retries and permits a fresh publish", async (t) => {
  const state = {
    assignments: { "old-assignment": assignment("old-assignment", "old-guide", "Old guide", "88", "2026-10-29T00:00:00.000Z") },
    locks: {},
    nextToken: 0,
    setCalls: 0,
    deleteCalls: 0,
    publicMetafield: null,
    publishStarted: deferred(),
    publishGate: deferred(),
  };
  globalThis[stateName] = state;
  const instanceA = await loadInstance(t);
  const instanceB = await loadInstance(t);
  const admin = adminFor(state, { failFirstDelete: true });
  const originalGraphql = admin.graphql;
  admin.graphql = async (query, options) => {
    if (query.includes("StockHubSetSizeGuide") && JSON.parse(options.variables.metafields[0].value).title === "Old guide") {
      state.publishStarted.resolve();
      await state.publishGate.promise;
    }
    return originalGraphql(query, options);
  };

  const stalePublisher = instanceA.sync.syncSizeGuideAssignment(admin, shop, "old-assignment");
  await state.publishStarted.promise;
  delete state.assignments["old-assignment"];
  state.publishGate.resolve();
  await assert.rejects(stalePublisher, /lost response after Shopify applied/);

  const cleanupLock = state.locks[lockKey];
  assert.equal(cleanupLock.state, "CLEANUP", "the remote delete may have applied, so its durable fence survives the lost response");
  assert.equal(state.publicMetafield, null);
  assert.deepEqual(await instanceB.sync.retryOrphanedSizeGuideCleanup(admin, shop, productId), { status: "pending" });
  assert.equal(state.deleteCalls, 1, "retry waits until the recovery lease expires");
  await assert.rejects(
    instanceB.repository.createSizeGuideAssignment({
      shop, productId, assignment: assignment("new-assignment", "new-guide", "New guide", "96", "2026-10-29T00:01:00.000Z"),
    }),
    /SIZE_GUIDE_PRODUCT_SYNC_LOCKED/,
    "the orphan lock remains effective even though no assignment row exists",
  );

  cleanupLock.leaseUntil = new Date(Date.now() - 1);
  assert.deepEqual(await instanceB.sync.retryOrphanedSizeGuideCleanup(admin, shop, productId), { status: "removed" });
  assert.equal(state.deleteCalls, 2, "recovery re-deletes to cover the lost response window");
  assert.equal(state.locks[lockKey], undefined);
  assert.equal(state.publicMetafield, null);

  const latest = assignment("new-assignment", "new-guide", "New guide", "96", "2026-10-29T00:01:00.000Z");
  await instanceB.repository.createSizeGuideAssignment({ shop, productId, assignment: latest });
  assert.deepEqual(await instanceB.sync.syncSizeGuideAssignment(admin, shop, latest.id), { status: "synced" });
  assert.equal(state.assignments[latest.id].syncStatus, "SYNCED");
  assert.equal(JSON.parse(state.publicMetafield).title, "New guide");
});

test("late publish after another instance reclaims and releases cleanup cannot orphan its metafield", async (t) => {
  const state = {
    assignments: { "old-assignment": assignment("old-assignment", "old-guide", "Old guide", "88", "2026-10-29T00:00:00.000Z") },
    locks: {},
    nextToken: 0,
    setCalls: 0,
    deleteCalls: 0,
    publicMetafield: null,
    publishStarted: deferred(),
    publishGate: deferred(),
    latePublishApplied: deferred(),
    publishResponseGate: deferred(),
  };
  globalThis[stateName] = state;
  const instanceA = await loadInstance(t);
  const instanceB = await loadInstance(t);
  const admin = {
    graphql: async (query, { variables }) => {
      if (query.includes("StockHubSetSizeGuide")) {
        state.setCalls += 1;
        state.publishStarted.resolve();
        await state.publishGate.promise;
        state.publicMetafield = variables.metafields[0].value;
        state.latePublishApplied.resolve();
        await state.publishResponseGate.promise;
        return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
      }
      if (query.includes("StockHubDeleteSizeGuide")) {
        state.deleteCalls += 1;
        state.publicMetafield = null;
        return Response.json({ data: { metafieldsDelete: { userErrors: [] } } });
      }
      throw new Error("Unexpected GraphQL operation");
    },
  };

  const stalePublisher = instanceA.sync.syncSizeGuideAssignment(admin, shop, "old-assignment");
  await state.publishStarted.promise;
  assert.equal(state.locks[lockKey].state, "PUBLISHING");

  // The assignment is orphaned while A's Shopify write is still outstanding.
  // Worker B reclaims A's expired lease, deletes the metafield, and releases
  // CLEANUP before A receives the success response for its older write.
  delete state.assignments["old-assignment"];
  state.locks[lockKey].leaseUntil = new Date(Date.now() - 1);
  assert.deepEqual(await instanceB.sync.retryOrphanedSizeGuideCleanup(admin, shop, productId), { status: "removed" });
  assert.equal(state.deleteCalls, 1);
  assert.equal(state.publicMetafield, null);
  assert.equal(state.locks[lockKey], undefined, "worker B completed and released the recovered cleanup lease");

  state.publishGate.resolve();
  await state.latePublishApplied.promise;
  assert.equal(JSON.parse(state.publicMetafield).title, "Old guide", "the stale Shopify write lands after worker B releases cleanup");
  assert.equal(state.locks[lockKey], undefined, "the late write temporarily restores an orphan without a cleanup fence");
  state.publishResponseGate.resolve();
  assert.deepEqual(await stalePublisher, { status: "unchanged" });
  assert.equal(state.assignments["old-assignment"], undefined);
  const recoveredByDelete = state.publicMetafield === null && state.deleteCalls >= 2;
  const retainedCleanupFence = state.locks[lockKey]?.state === "CLEANUP";
  assert.ok(
    recoveredByDelete || retainedCleanupFence,
    "the late Shopify write must be followed by deletion or a durable cleanup fence; otherwise an orphan chart is restored without recovery",
  );
  t.diagnostic(recoveredByDelete
    ? "late Shopify write was followed by a second delete; no cleanup lock remains"
    : "late Shopify write remains behind a durable CLEANUP lock");
});
