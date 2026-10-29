import { Prisma } from "@prisma/client";
import prisma from "../db.server";

const ORPHAN_CLEANUP_MARKER = "ORPHAN_CLEANUP_PENDING:";
const SYNC_LOCK_LEASE = Prisma.raw("INTERVAL '10 minutes'");

/** Persist a late/uncertain Shopify write before attempting any compensating delete. */
export async function requestOrphanGuideCleanup(shop: string, productId: string, publishToken: string, productTitle: string): Promise<string | null> {
  const cleanupToken = crypto.randomUUID();
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ token: string; state: string; leaseUntil: Date }>>`
      SELECT "token", "state", "leaseUntil" FROM "SizeGuideProductSyncLock"
      WHERE "shop" = ${shop} AND "productId" = ${productId} FOR UPDATE`;
    const row = rows[0];
    let ownerToken: string | null = null;
    let markerToken = row?.token ?? cleanupToken;
    if (!row) {
      await tx.$executeRaw`
        INSERT INTO "SizeGuideProductSyncLock" ("shop", "productId", "productTitle", "state", "token", "leaseUntil", "cleanupGeneration", "cleanupPending", "lastError")
        VALUES (${shop}, ${productId}, ${productTitle}, 'CLEANUP', ${cleanupToken}, CURRENT_TIMESTAMP + ${SYNC_LOCK_LEASE}, 1, TRUE,
          ${"A late publish completed after its prior cleanup lease was released."})`;
      ownerToken = cleanupToken;
      markerToken = cleanupToken;
    } else if ((row.state === "PUBLISHING" && row.token === publishToken) || row.leaseUntil.getTime() <= Date.now()) {
      await tx.$executeRaw`
        UPDATE "SizeGuideProductSyncLock" SET "productTitle" = ${productTitle}, "state" = 'CLEANUP', "token" = ${cleanupToken},
          "leaseUntil" = CURRENT_TIMESTAMP + ${SYNC_LOCK_LEASE}, "cleanupGeneration" = "cleanupGeneration" + 1,
          "cleanupPending" = TRUE, "lastError" = ${"A late publish completed after its prior cleanup lease was released."},
          "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}`;
      ownerToken = cleanupToken;
      markerToken = cleanupToken;
    } else {
      await tx.$executeRaw`
        UPDATE "SizeGuideProductSyncLock" SET "cleanupGeneration" = "cleanupGeneration" + 1,
          "cleanupPending" = TRUE, "lastError" = ${"A late publish is pending cleanup by the current product lock owner."},
          "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}`;
    }
    await tx.$executeRaw`
      UPDATE "SizeGuideProduct" SET "syncStatus" = 'FAILED', "lastError" = ${`${ORPHAN_CLEANUP_MARKER}${markerToken}`},
        "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}
          AND "syncStatus" IN ('PENDING', 'SYNCING', 'SYNCED', 'FAILED')`;
    return ownerToken;
  });
}

/** Let a still-active publisher take ownership of a cleanup request before it exits. */
export async function claimPendingGuideCleanup(shop: string, productId: string, publishToken: string): Promise<string | null> {
  const cleanupToken = crypto.randomUUID();
  return prisma.$transaction(async (tx) => {
    const changed = await tx.$executeRaw`
      UPDATE "SizeGuideProductSyncLock" SET "state" = 'CLEANUP', "token" = ${cleanupToken},
        "leaseUntil" = CURRENT_TIMESTAMP + ${SYNC_LOCK_LEASE}, "lastError" = ${"The active publisher is reconciling a late storefront write."},
        "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}
          AND "state" = 'PUBLISHING' AND "token" = ${publishToken} AND "cleanupPending" = TRUE`;
    if (!changed) return null;
    await tx.$executeRaw`
      UPDATE "SizeGuideProduct" SET "syncStatus" = 'FAILED', "lastError" = ${`${ORPHAN_CLEANUP_MARKER}${cleanupToken}`},
        "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}
          AND "syncStatus" IN ('PENDING', 'SYNCING', 'SYNCED', 'FAILED')`;
    return cleanupToken;
  });
}

/** Start a cleanup pass and capture the generation it must cover. */
export async function beginGuideCleanupPass(shop: string, productId: string, cleanupToken: string): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ cleanupGeneration: string }>>`
      UPDATE "SizeGuideProductSyncLock" SET "cleanupPending" = FALSE,
        "leaseUntil" = CURRENT_TIMESTAMP + ${SYNC_LOCK_LEASE}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "shop" = ${shop} AND "productId" = ${productId} AND "state" = 'CLEANUP' AND "token" = ${cleanupToken}
      RETURNING "cleanupGeneration"::text AS "cleanupGeneration"`;
    return rows[0]?.cleanupGeneration ?? null;
  });
}

export async function promoteGuideSyncLockToCleanup(shop: string, productId: string, publishToken: string): Promise<string | null> {
  const cleanupToken = crypto.randomUUID();
  return prisma.$transaction(async (tx) => {
    const changed = await tx.$executeRaw`
      UPDATE "SizeGuideProductSyncLock" SET "state" = 'CLEANUP', "token" = ${cleanupToken},
        "leaseUntil" = CURRENT_TIMESTAMP + ${SYNC_LOCK_LEASE}, "lastError" = ${"A previous publish is being reconciled."},
        "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}
          AND "state" = 'PUBLISHING' AND "token" = ${publishToken}`;
    if (!changed) return null;
    await tx.$executeRaw`
      UPDATE "SizeGuideProduct" SET "syncStatus" = 'FAILED', "lastError" = ${`${ORPHAN_CLEANUP_MARKER}${cleanupToken}`},
        "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}
          AND "syncStatus" IN ('PENDING', 'SYNCING', 'SYNCED', 'FAILED')`;
    return cleanupToken;
  });
}

export async function claimExpiredGuideCleanup(shop: string, productId: string, token: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$executeRaw`
      UPDATE "SizeGuideProductSyncLock" SET "state" = 'CLEANUP', "token" = ${token},
        "leaseUntil" = CURRENT_TIMESTAMP + ${SYNC_LOCK_LEASE}, "lastError" = ${"Retrying interrupted size-guide cleanup."},
        "cleanupGeneration" = "cleanupGeneration" + 1, "cleanupPending" = TRUE,
        "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}
          AND "leaseUntil" <= CURRENT_TIMESTAMP AND "state" IN ('PUBLISHING', 'CLEANUP')`;
    if (!claimed) return false;
    await tx.$executeRaw`
      UPDATE "SizeGuideProduct" SET "syncStatus" = 'FAILED', "lastError" = ${`${ORPHAN_CLEANUP_MARKER}${token}`},
        "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}
          AND "syncStatus" IN ('PENDING', 'SYNCING', 'SYNCED', 'FAILED')`;
    return true;
  });
}

export async function finishGuideCleanup(shop: string, productId: string, token: string, generation: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const stable = await tx.$queryRaw<Array<{ cleanupGeneration: string; cleanupPending: boolean }>>`
      SELECT "cleanupGeneration"::text AS "cleanupGeneration", "cleanupPending" FROM "SizeGuideProductSyncLock"
      WHERE "shop" = ${shop} AND "productId" = ${productId} AND "state" = 'CLEANUP' AND "token" = ${token} FOR UPDATE`;
    if (!stable[0]) return false;
    if (stable[0].cleanupPending || stable[0].cleanupGeneration !== generation) return false;
    await tx.$executeRaw`
      UPDATE "SizeGuideProduct" SET "syncStatus" = 'FAILED', "lastError" = ${"A previous publish removed this chart. Retry to publish it."},
        "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}
          AND "syncStatus" = 'FAILED' AND "lastError" = ${`${ORPHAN_CLEANUP_MARKER}${token}`}`;
    await tx.$executeRaw`
      DELETE FROM "SizeGuideProductSyncLock" WHERE "shop" = ${shop} AND "productId" = ${productId}
        AND "state" = 'CLEANUP' AND "token" = ${token} AND "cleanupPending" = FALSE
        AND "cleanupGeneration" = ${generation}::bigint`;
    return true;
  });
}

export async function recordGuideCleanupFailure(shop: string, productId: string, token: string, message: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SizeGuideProductSyncLock" SET "lastError" = ${message.slice(0, 500)},
      "leaseUntil" = CURRENT_TIMESTAMP + ${SYNC_LOCK_LEASE}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "shop" = ${shop} AND "productId" = ${productId} AND "state" = 'CLEANUP' AND "token" = ${token}`;
}
