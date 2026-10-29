/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";
import { sizeGuideStorefrontProjection } from "../app/utils/size-guides.shared.ts";

const databaseUrl = process.env.STOCKHUB_TEST_DATABASE_URL;
const expectedDatabase = "stockhub_regression";
const expectedHost = "127.0.0.1";
const expectedPort = 55432;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function response(data) {
  return Response.json({ data });
}

function adminFor(remote, { gatePublish } = {}) {
  return {
    async graphql(query, { variables }) {
      const operationName = query.match(/(?:mutation|query)\s+(\w+)/)?.[1] ?? "unknown";
      remote.graphqlOperations ??= [];
      remote.graphqlOperations.push(operationName);
      if (query.includes("StockHubSetSizeGuide")) {
        remote.setCalls += 1;
        if (gatePublish) {
          gatePublish.started.resolve();
          await gatePublish.gate.promise;
        }
        remote.value = variables.metafields[0].value;
        return response({ metafieldsSet: { userErrors: [] } });
      }
      if (query.includes("StockHubDeleteSizeGuide")) {
        remote.deleteCalls += 1;
        remote.value = null;
        if (remote.failDeleteCalls?.includes(remote.deleteCalls)) {
          throw new Error("Simulated lost response after Shopify applied metafieldsDelete");
        }
        return response({ metafieldsDelete: { userErrors: [] } });
      }
      throw new Error(`Unexpected Shopify GraphQL operation: ${operationName}`);
    },
  };
}

async function loadInstance(t, prisma, Prisma) {
  const globalKey = `__stockhubSizeGuidePostgresClient_${randomUUID().replaceAll("-", "")}`;
  const dbVirtualId = `\0stockhub-size-guide-postgres-db-${randomUUID()}`;
  const prismaProbeId = `\0stockhub-size-guide-prisma-runtime-probe-${randomUUID()}`;
  globalThis[globalKey] = prisma;
  t.after(() => { delete globalThis[globalKey]; });

  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    appType: "custom",
    plugins: [{
      name: "stockhub-size-guide-postgres-db-injection",
      enforce: "pre",
      resolveId(source) {
        if (source === "../db.server") return dbVirtualId;
        if (source === "virtual:stockhub-size-guide-prisma-runtime-probe") return prismaProbeId;
        return null;
      },
      load(id) {
        if (id === dbVirtualId) return `const prisma = globalThis[${JSON.stringify(globalKey)}]; export default prisma;`;
        if (id === prismaProbeId) return `export { Prisma } from "@prisma/client";`;
        return null;
      },
    }],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    ssr: { external: ["@prisma/client"] },
    logLevel: "error",
  });
  t.after(async () => vite.close());
  const [repository, sync, runtimeProbe] = await Promise.all([
    vite.ssrLoadModule("/app/utils/size-guide-repository.server.ts"),
    vite.ssrLoadModule("/app/utils/size-guide-sync.server.ts"),
    vite.ssrLoadModule("virtual:stockhub-size-guide-prisma-runtime-probe"),
  ]);
  assert.strictEqual(runtimeProbe.Prisma, Prisma, "Vite-resolved @prisma/client must be the same module instance used to construct test clients");
  return { repository, sync };
}

async function verifyTarget(prisma, url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Guarded PostgreSQL test URL is invalid."); }
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)
    && parsed.hostname === expectedHost
    && Number(parsed.port) === expectedPort
    && parsed.pathname === `/${expectedDatabase}`
    && parsed.username && parsed.password
    && process.env.DATABASE_URL === url)) {
    throw new Error("Refusing PostgreSQL integration test: URL must exactly match the explicit isolated loopback test target.");
  }
  const rows = await prisma.$queryRaw`SELECT current_database() AS database, current_user AS "user",
    inet_server_addr()::text AS "serverAddress", inet_client_addr()::text AS "clientAddress",
    inet_server_port() AS "serverPort"`;
  const row = rows[0];
  if (row?.database !== expectedDatabase
    || row?.user !== decodeURIComponent(parsed.username)
    || !["127.0.0.1", "127.0.0.1/32", "::1", "::1/128"].includes(row?.serverAddress)
    || !["127.0.0.1", "127.0.0.1/32", "::1", "::1/128"].includes(row?.clientAddress)
    || Number(row?.serverPort) !== expectedPort) {
    throw new Error("Refusing PostgreSQL integration test: connected server identity is not the isolated loopback database.");
  }
}

async function fixture(repository, shop, productId) {
  const guideId = `guide-${randomUUID()}`;
  await repository.createSizeGuide(shop, guideId, {
    title: "PostgreSQL race fixture", unit: "cm",
    columns: [{ name: "Size", kind: "label" }, { name: "Chest", kind: "measurement" }],
    rows: [["S", "88"]],
  });
  await repository.createSizeGuideAssignment({ shop, guideId, productId, productTitle: "Race fixture" });
  return repository.getSizeGuideAssignment(shop, productId);
}

async function expireLock(prisma, shop, productId) {
  await prisma.$executeRaw`UPDATE "SizeGuideProductSyncLock"
    SET "leaseUntil" = CURRENT_TIMESTAMP - INTERVAL '1 second'
    WHERE "shop" = ${shop} AND "productId" = ${productId}`;
}

test("Size Guide sync uses PostgreSQL fencing across workers and recovers orphan cleanup", {
  skip: !databaseUrl,
}, async (t) => {
  const parsed = new URL(databaseUrl);
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)
    && parsed.hostname === expectedHost
    && Number(parsed.port) === expectedPort
    && parsed.pathname === `/${expectedDatabase}`
    && parsed.username && parsed.password
    && process.env.DATABASE_URL === databaseUrl)) {
    throw new Error("Refusing PostgreSQL integration test: explicit isolated test URL/DATABASE_URL guard failed.");
  }

  const { Prisma, PrismaClient } = await import("@prisma/client");
  const prismaA = new PrismaClient({ datasourceUrl: databaseUrl });
  const prismaB = new PrismaClient({ datasourceUrl: databaseUrl });
  const shops = new Set();
  t.after(async () => {
    for (const shop of shops) {
      await prismaA.$executeRaw`DELETE FROM "SizeGuideProductSyncLock" WHERE "shop" = ${shop}`;
      await prismaA.$executeRaw`DELETE FROM "SizeGuideProduct" WHERE "shop" = ${shop}`;
      await prismaA.$executeRaw`DELETE FROM "SizeGuide" WHERE "shop" = ${shop}`;
    }
    await Promise.all([prismaA.$disconnect(), prismaB.$disconnect()]);
  });
  await Promise.all([prismaA.$connect(), prismaB.$connect()]);
  await Promise.all([verifyTarget(prismaA, databaseUrl), verifyTarget(prismaB, databaseUrl)]);
  const instanceA = await loadInstance(t, prismaA, Prisma);
  const instanceB = await loadInstance(t, prismaB, Prisma);

  await t.test("migration defaults and PostgreSQL constraints are present", async () => {
    const shop = `pg-size-guide-${randomUUID()}@test.myshopify.com`;
    const productId = `gid://shopify/Product/${randomUUID()}`;
    shops.add(shop);
    await prismaA.$executeRaw`INSERT INTO "SizeGuideProductSyncLock"
      ("shop", "productId", "productTitle", "state", "token", "leaseUntil")
      VALUES (${shop}, ${productId}, 'constraint fixture', 'CLEANUP', 'test-token', CURRENT_TIMESTAMP + INTERVAL '10 minutes')`;
    const defaults = await prismaA.$queryRaw`SELECT "cleanupGeneration", "cleanupPending"
      FROM "SizeGuideProductSyncLock" WHERE "shop" = ${shop} AND "productId" = ${productId}`;
    assert.equal(defaults[0].cleanupGeneration, 0n);
    assert.equal(defaults[0].cleanupPending, false);

    const insert = (pid, state, token) => prismaA.$executeRaw`INSERT INTO "SizeGuideProductSyncLock"
      ("shop", "productId", "productTitle", "state", "token", "leaseUntil")
      VALUES (${shop}, ${pid}, 'constraint fixture', ${state}, ${token}, CURRENT_TIMESTAMP + INTERVAL '10 minutes')`;
    await assert.rejects(insert("not-a-shopify-product-gid", "CLEANUP", "bad-product"), /productId_check/);
    await assert.rejects(insert(`gid://shopify/Product/${randomUUID()}`, "INVALID", "bad-state"), /state_check/);
    await assert.rejects(insert(productId, "CLEANUP", "duplicate"), /duplicate key|unique|Key .* already exists/i);
  });

  await t.test("only one concurrent worker claims a publish lock", async () => {
    const shop = `pg-size-guide-${randomUUID()}@test.myshopify.com`;
    const productId = `gid://shopify/Product/${randomUUID()}`;
    shops.add(shop);
    const assignment = await fixture(instanceA.repository, shop, productId);
    const claims = await Promise.all([
      instanceA.repository.beginGuideSync(shop, assignment.id),
      instanceB.repository.beginGuideSync(shop, assignment.id),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = claims.find(Boolean);
    assert.ok(winner?.syncLockToken);
    const lock = await instanceB.repository.getSizeGuideProductSyncLock(shop, productId);
    assert.equal(lock.state, "PUBLISHING");
    assert.equal(lock.token, winner.syncLockToken);
    await instanceA.repository.releaseGuideSyncLock(shop, productId, winner.syncLockToken);
  });

  await t.test("a late publish after another worker's cleanup is reconciled", async () => {
    const shop = `pg-size-guide-${randomUUID()}@test.myshopify.com`;
    const productId = `gid://shopify/Product/${randomUUID()}`;
    shops.add(shop);
    const assignment = await fixture(instanceA.repository, shop, productId);
    assert.ok(Array.isArray(assignment?.guide?.columns), "PostgreSQL row mapper returns projection columns as an array");
    assert.ok(Array.isArray(assignment?.guide?.rows), "PostgreSQL row mapper returns projection rows as an array");
    const projection = sizeGuideStorefrontProjection(assignment.guide);
    assert.ok(Array.isArray(projection.columns) && projection.columns.length > 0);
    assert.ok(Array.isArray(projection.rows) && projection.rows.length > 0);
    const gatePublish = { started: deferred(), gate: deferred() };
    const remote = { value: null, setCalls: 0, deleteCalls: 0 };
    const oldPublish = instanceA.sync.syncSizeGuideAssignment(adminFor(remote, { gatePublish }), shop, assignment.id);
    const publishCompletion = oldPublish.then(
      (value) => ({ kind: "completed", value }),
      (error) => ({ kind: "rejected", error }),
    );
    const first = await Promise.race([
      gatePublish.started.promise.then(() => ({ kind: "graphql-started" })),
      publishCompletion,
    ]);
    const exitDetails = first.kind === "rejected"
      ? `sync rejected before Shopify set (${first.error?.name ?? "Error"})`
      : `sync returned before Shopify set (status=${first.value?.status ?? "unknown"})`;
    const adapterDetails = remote.graphqlOperations?.length
      ? `GraphQL calls=${remote.graphqlOperations.length}; operations=${remote.graphqlOperations.join(",")}`
      : "GraphQL calls=0";
    const earlyExit = `${exitDetails}; ${adapterDetails}`;
    assert.equal(first.kind, "graphql-started", earlyExit);

    const activeAssignment = await instanceA.repository.getSizeGuideAssignment(shop, productId);
    const publishLock = await instanceA.repository.getSizeGuideProductSyncLock(shop, productId);
    assert.ok(activeAssignment, "worker A's assignment remains persisted during the delayed publish");
    assert.ok(publishLock, "worker A's PostgreSQL publish fence remains persisted");
    assert.equal(activeAssignment.syncStatus, "SYNCING");
    assert.equal(publishLock.state, "PUBLISHING");
    assert.equal(publishLock.productId, productId);

    await prismaB.$executeRaw`DELETE FROM "SizeGuideProduct" WHERE "shop" = ${shop} AND "productId" = ${productId}`;
    await expireLock(prismaB, shop, productId);
    assert.deepEqual(await instanceB.sync.retryOrphanedSizeGuideCleanup(adminFor(remote), shop, productId), { status: "removed" });
    assert.equal(remote.deleteCalls, 1);
    assert.equal(await instanceB.repository.getSizeGuideProductSyncLock(shop, productId), null);

    gatePublish.gate.resolve();
    assert.deepEqual(await oldPublish, { status: "unchanged" });
    assert.equal(remote.deleteCalls, 2, "late successful set is followed by a second delete");
    assert.equal(remote.value, null);
    assert.equal(await instanceB.repository.getSizeGuideProductSyncLock(shop, productId), null);
  });

  await t.test("a newer cleanup generation prevents stale cleanup from releasing the fence", async () => {
    const shop = `pg-size-guide-${randomUUID()}@test.myshopify.com`;
    const productId = `gid://shopify/Product/${randomUUID()}`;
    shops.add(shop);
    const assignment = await fixture(instanceA.repository, shop, productId);
    const publish = await instanceA.repository.beginGuideSync(shop, assignment.id);
    const cleanupToken = await instanceA.repository.requestOrphanGuideCleanup(
      shop, productId, publish.syncLockToken, assignment.productTitle,
    );
    assert.ok(cleanupToken);
    const staleGeneration = await instanceA.repository.beginGuideCleanupPass(shop, productId, cleanupToken);
    assert.ok(staleGeneration);

    assert.equal(await instanceB.repository.requestOrphanGuideCleanup(
      shop, productId, "late-publisher-token", assignment.productTitle,
    ), null, "current cleanup owner records the later generation without being displaced");
    const dirty = await instanceA.repository.getSizeGuideProductSyncLock(shop, productId);
    assert.equal(dirty.cleanupPending, true);
    assert.equal(BigInt(dirty.cleanupGeneration), BigInt(staleGeneration) + 1n);
    assert.equal(await instanceA.repository.finishGuideCleanup(shop, productId, cleanupToken, staleGeneration), false);

    const currentGeneration = await instanceB.repository.beginGuideCleanupPass(shop, productId, cleanupToken);
    assert.equal(currentGeneration, dirty.cleanupGeneration);
    assert.equal(await instanceB.repository.finishGuideCleanup(shop, productId, cleanupToken, currentGeneration), true);
    assert.equal(await instanceA.repository.getSizeGuideProductSyncLock(shop, productId), null);
  });

  await t.test("a fresh worker reclaims an abandoned publisher after its lease expires", async () => {
    const shop = `pg-size-guide-${randomUUID()}@test.myshopify.com`;
    const productId = `gid://shopify/Product/${randomUUID()}`;
    shops.add(shop);
    await prismaA.$executeRaw`INSERT INTO "SizeGuideProductSyncLock"
      ("shop", "productId", "productTitle", "state", "token", "leaseUntil", "cleanupGeneration", "cleanupPending")
      VALUES (${shop}, ${productId}, 'crashed publisher', 'PUBLISHING', ${randomUUID()},
        CURRENT_TIMESTAMP - INTERVAL '1 second', 2, FALSE)`;
    assert.equal((await instanceA.repository.listOrphanedSizeGuideSyncLocks(shop)).length, 1);

    const remote = { value: "possibly-published", setCalls: 0, deleteCalls: 0 };
    assert.deepEqual(await instanceB.sync.retryOrphanedSizeGuideCleanup(adminFor(remote), shop, productId), { status: "removed" });
    assert.equal(remote.deleteCalls, 1, "the replacement worker cleans the storefront value left by the abandoned owner");
    assert.equal(remote.value, null);
    assert.equal(await instanceA.repository.getSizeGuideProductSyncLock(shop, productId), null);
  });

  await t.test("lost delete response leaves durable orphan lock for retry after lease expiry", async () => {
    const shop = `pg-size-guide-${randomUUID()}@test.myshopify.com`;
    const productId = `gid://shopify/Product/${randomUUID()}`;
    shops.add(shop);
    const leaseToken = randomUUID();
    await prismaA.$executeRaw`INSERT INTO "SizeGuideProductSyncLock"
      ("shop", "productId", "productTitle", "state", "token", "leaseUntil", "cleanupGeneration", "cleanupPending")
      VALUES (${shop}, ${productId}, 'orphan fixture', 'CLEANUP', ${leaseToken}, CURRENT_TIMESTAMP - INTERVAL '1 second', 4, TRUE)`;
    assert.equal((await instanceA.repository.listOrphanedSizeGuideSyncLocks(shop)).length, 1);

    const remote = { value: "possibly-present", setCalls: 0, deleteCalls: 0, failDeleteCalls: [1] };
    const admin = adminFor(remote);
    assert.deepEqual(await instanceB.sync.retryOrphanedSizeGuideCleanup(admin, shop, productId), { status: "failed" });
    assert.equal(remote.value, null, "the failed response models delete applying before the connection was lost");
    const persisted = await instanceA.repository.getSizeGuideProductSyncLock(shop, productId);
    assert.equal(persisted.state, "CLEANUP");
    assert.equal(persisted.cleanupPending, false);
    assert.equal(persisted.cleanupGeneration, "5");

    assert.deepEqual(await instanceA.sync.retryOrphanedSizeGuideCleanup(admin, shop, productId), { status: "pending" });
    assert.equal(remote.deleteCalls, 1, "retry waits for the recovery lease");
    await expireLock(prismaA, shop, productId);
    assert.deepEqual(await instanceA.sync.retryOrphanedSizeGuideCleanup(admin, shop, productId), { status: "removed" });
    assert.equal(remote.deleteCalls, 2, "retry repeats idempotent cleanup after losing the prior response");
    assert.equal(remote.value, null);
    assert.equal(await instanceB.repository.getSizeGuideProductSyncLock(shop, productId), null);
  });
});
