/* eslint-env node */
/* global globalThis */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { createSizeGuideRepositoryMockSource } from "./size-guide-sync-repository-mock.mjs";

const shop = "test-store.myshopify.com";
const productId = "gid://shopify/Product/123";
const assignmentId = "assignment-1";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function loadSyncModule(t) {
  const publishStarted = deferred();
  const publishGate = deferred();
  const state = {
    publishStarted,
    publishGate,
    assignment: {
      id: assignmentId,
      shop,
      guideId: "guide-1",
      productId,
      productTitle: "Everyday shirt",
      syncStatus: "PENDING",
      syncedGuideUpdatedAt: null,
      lastError: null,
      guide: {
        id: "guide-1",
        shop,
        title: "Everyday shirt",
        unit: "cm",
        columns: [{ name: "Size", kind: "label" }, { name: "Chest", kind: "measurement" }],
        rows: [["S", "88"]],
        updatedAt: new Date("2026-10-29T00:00:00.000Z"),
      },
    },
    publicMetafield: null,
    operations: [],
  };
  globalThis.__stockhubSizeGuideSyncRace = state;
  state.locks = {};
  state.nextToken = 0;
  const repositorySource = createSizeGuideRepositoryMockSource("__stockhubSizeGuideSyncRace");
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [{
      name: "stockhub-size-guide-sync-race-test-mock-repository",
      enforce: "pre",
      resolveId(source) {
        return source === "./size-guide-repository.server" || source === "virtual:size-guide-repository-mock"
          ? "\0stockhub-size-guide-sync-race-repository" : null;
      },
      load(id) { return id === "\0stockhub-size-guide-sync-race-repository" ? repositorySource : null; },
    }],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    logLevel: "error",
  });
  t.after(async () => vite.close());
  return { sync: await vite.ssrLoadModule("/app/utils/size-guide-sync.server.ts"), state };
}

async function loadOrphanPublishSyncModule(t) {
  const oldPublishStarted = deferred();
  const oldPublishGate = deferred();
  const state = {
    oldPublishStarted,
    oldPublishGate,
    assignments: {},
    publicMetafield: null,
    operations: [],
  };
  const oldAssignment = {
    id: "old-assignment",
    shop,
    guideId: "old-guide",
    productId,
    productTitle: "Everyday shirt",
    syncStatus: "PENDING",
    syncedGuideUpdatedAt: null,
    lastError: null,
    guide: {
      id: "old-guide",
      shop,
      title: "Old guide",
      unit: "cm",
      columns: [{ name: "Size", kind: "label" }, { name: "Chest", kind: "measurement" }],
      rows: [["S", "88"]],
      updatedAt: new Date("2026-10-29T00:00:00.000Z"),
    },
  };
  state.assignments[oldAssignment.id] = oldAssignment;
  state.locks = {};
  state.nextToken = 0;
  globalThis.__stockhubSizeGuideOrphanRace = state;
  const repositorySource = createSizeGuideRepositoryMockSource("__stockhubSizeGuideOrphanRace");
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [{
      name: "stockhub-size-guide-orphan-race-test-mock-repository",
      enforce: "pre",
      resolveId(source) {
        return source === "./size-guide-repository.server" || source === "virtual:size-guide-repository-mock"
          ? "\0stockhub-size-guide-orphan-race-repository" : null;
      },
      load(id) { return id === "\0stockhub-size-guide-orphan-race-repository" ? repositorySource : null; },
    }],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    logLevel: "error",
  });
  t.after(async () => vite.close());
  return { sync: await vite.ssrLoadModule("/app/utils/size-guide-sync.server.ts"), state };
}

test("removal waits for an in-flight publish, then removes its metafield before deleting the assignment", async (t) => {
  const { sync, state } = await loadSyncModule(t);
  const admin = {
    graphql: async (query, { variables }) => {
      if (query.includes("StockHubSetSizeGuide")) {
        state.operations.push("publish-start");
        state.publishStarted.resolve();
        await state.publishGate.promise;
        state.publicMetafield = variables.metafields[0].value;
        state.operations.push("publish-finish");
        return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
      }
      if (query.includes("StockHubDeleteSizeGuide")) {
        state.operations.push("remove-metafield");
        state.publicMetafield = null;
        return Response.json({ data: { metafieldsDelete: { userErrors: [] } } });
      }
      throw new Error("Unexpected GraphQL operation");
    },
  };

  const publish = sync.syncSizeGuideAssignment(admin, shop, assignmentId);
  await state.publishStarted.promise;
  const removal = await sync.removeSizeGuideAssignment(admin, shop, productId);
  assert.deepEqual(removal, { status: "pending" });
  assert.equal(state.assignment.syncStatus, "REMOVE_WAITING_SYNC");
  assert.deepEqual(state.operations, ["publish-start"]);

  const earlyRetry = await sync.retrySizeGuideRemoval(admin, structuredClone(state.assignment));
  assert.deepEqual(earlyRetry, { status: "pending" });
  assert.deepEqual(state.operations, ["publish-start"], "a pending publish must not be mistaken for a retryable removal");

  state.publishGate.resolve();
  const publishResult = await publish;
  assert.deepEqual(publishResult, { status: "removed" });
  assert.deepEqual(state.operations, ["publish-start", "publish-finish", "remove-metafield"]);
  assert.equal(state.publicMetafield, null, "the in-flight publish cannot leave a public chart after removal wins");
  assert.equal(state.assignment, null, "canonical assignment is deleted only after metafield removal completes");
});

test("unassignment after an edit waits behind the publish lock and removes the late metafield", async (t) => {
  const { sync, state } = await loadSyncModule(t);
  const admin = {
    graphql: async (query, { variables }) => {
      if (query.includes("StockHubSetSizeGuide")) {
        state.operations.push("publish-start");
        state.publishStarted.resolve();
        await state.publishGate.promise;
        state.publicMetafield = variables.metafields[0].value;
        state.operations.push("publish-finish");
        return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
      }
      if (query.includes("StockHubDeleteSizeGuide")) {
        state.operations.push("remove-metafield");
        state.publicMetafield = null;
        return Response.json({ data: { metafieldsDelete: { userErrors: [] } } });
      }
      throw new Error("Unexpected GraphQL operation");
    },
  };

  const publish = sync.syncSizeGuideAssignment(admin, shop, assignmentId);
  await state.publishStarted.promise;

  // An edit can happen while a publish is in flight. The durable publish lock
  // must make unassignment wait, even if the guide version changes meanwhile.
  state.assignment.guide.rows = [["S", "96"]];
  state.assignment.guide.updatedAt = new Date("2026-10-29T00:01:00.000Z");
  state.assignment.syncStatus = "PENDING";
  const removal = await sync.removeSizeGuideAssignment(admin, shop, productId);

  assert.deepEqual(removal, { status: "pending" });
  assert.equal(state.assignment.syncStatus, "REMOVE_WAITING_SYNC");
  assert.equal(state.publicMetafield, null);
  assert.deepEqual(state.operations, ["publish-start"], "unassignment does not issue delete before the outstanding publish completes");

  state.publishGate.resolve();
  const publishResult = await publish;
  assert.deepEqual(publishResult, { status: "removed" });
  assert.equal(state.assignment, null);
  assert.equal(state.publicMetafield, null, "the deferred removal deletes the value after the publish completes");
});

test("a persisted removal waiting on sync can be recovered with retry after process restart", async (t) => {
  const { sync, state } = await loadSyncModule(t);
  const admin = {
    graphql: async (query) => {
      if (query.includes("StockHubDeleteSizeGuide")) {
        state.operations.push("remove-metafield");
        state.publicMetafield = null;
        return Response.json({ data: { metafieldsDelete: { userErrors: [] } } });
      }
      throw new Error("Unexpected GraphQL operation");
    },
  };

  // Model a fresh process loading the durable row left behind when the process
  // that owned the publish exited before it could finish deferred removal.
  state.assignment.syncStatus = "REMOVE_WAITING_SYNC";
  state.publicMetafield = JSON.stringify({ title: "Everyday shirt", rows: [["S", "88"]] });
  const retry = await sync.retrySizeGuideRemoval(admin, structuredClone(state.assignment));

  assert.deepEqual(retry, { status: "removed" });
  assert.deepEqual(state.operations, ["remove-metafield"]);
  assert.equal(state.publicMetafield, null);
  assert.equal(state.assignment, null, "the waiting assignment must not remain stuck after successful retry");
});

test("orphan reconciliation releases its durable fence before publishing the current assignment", async (t) => {
  const { sync, state } = await loadOrphanPublishSyncModule(t);
  const cleanupStarted = deferred();
  const cleanupGate = deferred();
  const admin = {
    graphql: async (query, { variables }) => {
      if (query.includes("StockHubSetSizeGuide")) {
        const value = variables.metafields[0].value;
        const title = JSON.parse(value).title;
        if (title === "Old guide") {
          state.operations.push("old-publish-start");
          state.oldPublishStarted.resolve();
          await state.oldPublishGate.promise;
        } else {
          state.operations.push("new-publish-finish");
        }
        state.publicMetafield = value;
        return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
      }
      if (query.includes("StockHubDeleteSizeGuide")) {
        state.operations.push("stale-cleanup-start");
        cleanupStarted.resolve();
        await cleanupGate.promise;
        state.publicMetafield = null;
        state.operations.push("stale-cleanup-finish");
        return Response.json({ data: { metafieldsDelete: { userErrors: [] } } });
      }
      throw new Error("Unexpected GraphQL operation");
    },
  };

  const oldPublish = sync.syncSizeGuideAssignment(admin, shop, "old-assignment");
  await state.oldPublishStarted.promise;

  // The prior assignment is removed and a new assignment for the same product
  // starts publishing while the old Shopify mutation is still in flight.
  delete state.assignments["old-assignment"];
  state.assignments["newer-assignment"] = {
    id: "newer-assignment",
    shop,
    guideId: "new-guide",
    productId,
    productTitle: "Everyday shirt",
    syncStatus: "PENDING",
    syncedGuideUpdatedAt: null,
    lastError: null,
    guide: {
      id: "new-guide",
      shop,
      title: "New guide",
      unit: "cm",
      columns: [{ name: "Size", kind: "label" }, { name: "Chest", kind: "measurement" }],
      rows: [["S", "96"]],
      updatedAt: new Date("2026-10-29T00:01:00.000Z"),
    },
  };

  state.oldPublishGate.resolve();
  await cleanupStarted.promise;
  assert.equal(state.locks[`${shop}\u0000${productId}`].state, "CLEANUP");
  assert.deepEqual(await sync.syncSizeGuideAssignment(admin, shop, "newer-assignment"), { status: "unchanged" });
  assert.equal(JSON.parse(state.publicMetafield).title, "Old guide", "the cleanup fence prevents a second publish until the delete completes");

  cleanupGate.resolve();
  const oldResult = await oldPublish;
  assert.deepEqual(oldResult, { status: "unchanged" });
  assert.deepEqual(state.operations, ["old-publish-start", "stale-cleanup-start", "stale-cleanup-finish", "new-publish-finish"]);
  assert.equal(state.assignments["newer-assignment"].syncStatus, "SYNCED");
  assert.equal(state.locks[`${shop}\u0000${productId}`], undefined);
  assert.notEqual(state.publicMetafield, null, "the current assignment is published only after the cleanup lock is released");
  assert.equal(JSON.parse(state.publicMetafield).title, "New guide");
});
