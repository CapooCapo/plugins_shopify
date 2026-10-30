import { Prisma, type PrismaClient } from "@prisma/client";
import prisma from "../db.server";
import type { SizeGuideColumn } from "./size-guides.shared";

type SqlClient = PrismaClient | Prisma.TransactionClient;
export type SizeGuideRecord = {
  id: string;
  shop: string;
  title: string;
  unit: "cm" | "in" | "mm";
  columns: SizeGuideColumn[];
  rows: string[][];
  updatedAt: Date;
};
export type SizeGuideAssignment = {
  id: string;
  shop: string;
  guideId: string;
  productId: string;
  productTitle: string;
  syncStatus: "PENDING" | "SYNCING" | "SYNCED" | "FAILED" | "REMOVE_WAITING_SYNC" | "REMOVE_PENDING" | "REMOVE_FAILED";
  syncedGuideUpdatedAt: Date | null;
  lastError: string | null;
  guide: SizeGuideRecord;
  syncLockToken?: string;
};
export type SizeGuideSyncLock = {
  shop: string;
  productId: string;
  productTitle: string;
  state: "PUBLISHING" | "CLEANUP";
  token: string;
  leaseUntil: Date;
  lastError: string | null;
  cleanupGeneration: string;
  cleanupPending: boolean;
};

const ORPHAN_CLEANUP_MARKER = "ORPHAN_CLEANUP_PENDING:";
const SYNC_LOCK_LEASE = Prisma.raw("INTERVAL '10 minutes'");

function guide(row: Record<string, unknown>): SizeGuideRecord {
  return {
    id: String(row.id),
    shop: String(row.shop),
    title: String(row.title),
    unit: row.unit as SizeGuideRecord["unit"],
    columns: row.columnsJson as SizeGuideColumn[],
    rows: row.rowsJson as string[][],
    updatedAt: row.updatedAt as Date,
  };
}

function assignment(row: Record<string, unknown>): SizeGuideAssignment {
  return {
    id: String(row.id),
    shop: String(row.shop),
    guideId: String(row.guideId),
    productId: String(row.productId),
    productTitle: String(row.productTitle),
    syncStatus: row.syncStatus as SizeGuideAssignment["syncStatus"],
    syncedGuideUpdatedAt: row.syncedGuideUpdatedAt as Date | null,
    lastError: row.lastError as string | null,
    guide: guide({
      id: row.guide_id,
      shop: row.guide_shop,
      title: row.guide_title,
      unit: row.guide_unit,
      columnsJson: row.guide_columnsJson,
      rowsJson: row.guide_rowsJson,
      updatedAt: row.guide_updatedAt,
    }),
  };
}

const GUIDE_COLUMNS = `g."id" AS guide_id, g."shop" AS guide_shop, g."title" AS guide_title,
  g."unit" AS guide_unit, g."columnsJson" AS "guide_columnsJson", g."rowsJson" AS "guide_rowsJson",
  g."updatedAt" AS "guide_updatedAt"`;

export async function listSizeGuides(shop: string): Promise<Array<SizeGuideRecord & { products: SizeGuideAssignment[] }>> {
  const [guides, products] = await Promise.all([
    prismaQueryGuides(shop),
    prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT p.*, ${Prisma.raw(GUIDE_COLUMNS)}
      FROM "SizeGuideProduct" p JOIN "SizeGuide" g ON g."shop" = p."shop" AND g."id" = p."guideId"
      WHERE p."shop" = ${shop} ORDER BY p."productTitle" ASC`,
  ]);
  const productRows = products.map(assignment);
  return guides.map((item) => ({ ...item, products: productRows.filter((row) => row.guideId === item.id) }));
}

export async function listOrphanedSizeGuideSyncLocks(shop: string): Promise<SizeGuideSyncLock[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT l.* FROM "SizeGuideProductSyncLock" l
    WHERE l."shop" = ${shop} AND NOT EXISTS (
      SELECT 1 FROM "SizeGuideProduct" p WHERE p."shop" = l."shop" AND p."productId" = l."productId"
    ) ORDER BY l."updatedAt" ASC`;
  return rows.map((row) => ({
    shop: String(row.shop), productId: String(row.productId), productTitle: String(row.productTitle),
    state: row.state as SizeGuideSyncLock["state"], token: String(row.token),
    leaseUntil: row.leaseUntil as Date, lastError: row.lastError as string | null,
    cleanupGeneration: String(row.cleanupGeneration ?? 0), cleanupPending: Boolean(row.cleanupPending),
  }));
}

export async function getSizeGuideProductSyncLock(shop: string, productId: string): Promise<SizeGuideSyncLock | null> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "SizeGuideProductSyncLock" WHERE "shop" = ${shop} AND "productId" = ${productId} LIMIT 1`;
  const row = rows[0];
  return row ? {
    shop: String(row.shop), productId: String(row.productId), productTitle: String(row.productTitle),
    state: row.state as SizeGuideSyncLock["state"], token: String(row.token),
    leaseUntil: row.leaseUntil as Date, lastError: row.lastError as string | null,
    cleanupGeneration: String(row.cleanupGeneration ?? 0), cleanupPending: Boolean(row.cleanupPending),
  } : null;
}

async function prismaQueryGuides(shop: string) {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "SizeGuide" WHERE "shop" = ${shop} ORDER BY "updatedAt" DESC`;
  return rows.map(guide);
}

export async function getSizeGuide(shop: string, id: string): Promise<SizeGuideRecord | null> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "SizeGuide" WHERE "shop" = ${shop} AND "id" = ${id} LIMIT 1`;
  return rows[0] ? guide(rows[0]) : null;
}

async function getAssignmentFrom(client: SqlClient, shop: string, productId: string): Promise<SizeGuideAssignment | null> {
  const rows = await client.$queryRaw<Array<Record<string, unknown>>>`
    SELECT p.*, ${Prisma.raw(GUIDE_COLUMNS)}
    FROM "SizeGuideProduct" p JOIN "SizeGuide" g ON g."shop" = p."shop" AND g."id" = p."guideId"
    WHERE p."shop" = ${shop} AND p."productId" = ${productId} LIMIT 1`;
  return rows[0] ? assignment(rows[0]) : null;
}

export async function getSizeGuideAssignment(shop: string, productId: string): Promise<SizeGuideAssignment | null> {
  return getAssignmentFrom(prisma, shop, productId);
}

export async function saveSizeGuide(shop: string, id: string, value: {
  title: string; unit: string; columns: SizeGuideColumn[]; rows: string[][];
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const changed = await tx.$executeRaw`
      UPDATE "SizeGuide" SET "title" = ${value.title}, "unit" = ${value.unit},
        "columnsJson" = ${JSON.stringify(value.columns)}::jsonb, "rowsJson" = ${JSON.stringify(value.rows)}::jsonb,
        "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "id" = ${id}`;
    if (changed === 0) throw new Error("SIZE_GUIDE_NOT_FOUND");
    await tx.$executeRaw`
      UPDATE "SizeGuideProduct" p SET "syncStatus" = CASE
          WHEN EXISTS (SELECT 1 FROM "SizeGuideProductSyncLock" l WHERE l."shop" = p."shop"
            AND l."productId" = p."productId" AND l."state" = 'CLEANUP') THEN 'FAILED'
          WHEN p."syncStatus" = 'SYNCING' THEN 'SYNCING' ELSE 'PENDING' END,
        "lastError" = CASE WHEN EXISTS (SELECT 1 FROM "SizeGuideProductSyncLock" l WHERE l."shop" = p."shop"
          AND l."productId" = p."productId" AND l."state" = 'CLEANUP') THEN p."lastError" ELSE NULL END,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE p."shop" = ${shop} AND p."guideId" = ${id} AND p."syncStatus" IN ('PENDING', 'SYNCING', 'SYNCED', 'FAILED')`;
  });
}

export async function createSizeGuide(shop: string, id: string, value: {
  title: string; unit: string; columns: SizeGuideColumn[]; rows: string[][];
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "SizeGuide" ("id", "shop", "title", "unit", "columnsJson", "rowsJson")
    VALUES (${id}, ${shop}, ${value.title}, ${value.unit}, ${JSON.stringify(value.columns)}::jsonb, ${JSON.stringify(value.rows)}::jsonb)`;
}

export async function createSizeGuideAssignment(input: {
  shop: string; guideId: string; productId: string; productTitle: string;
}): Promise<void> {
  const inserted = await prisma.$executeRaw`
    INSERT INTO "SizeGuideProduct" ("id", "shop", "guideId", "productId", "productTitle")
    SELECT ${crypto.randomUUID()}, ${input.shop}, ${input.guideId}, ${input.productId}, ${input.productTitle}
    WHERE NOT EXISTS (SELECT 1 FROM "SizeGuideProductSyncLock" l
      WHERE l."shop" = ${input.shop} AND l."productId" = ${input.productId})`;
  if (!inserted) throw new Error("SIZE_GUIDE_PRODUCT_SYNC_LOCKED");
}

export async function listGuideAssignments(shop: string, guideId: string): Promise<SizeGuideAssignment[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT p.*, ${Prisma.raw(GUIDE_COLUMNS)}
    FROM "SizeGuideProduct" p JOIN "SizeGuide" g ON g."shop" = p."shop" AND g."id" = p."guideId"
    WHERE p."shop" = ${shop} AND p."guideId" = ${guideId} ORDER BY p."productTitle" ASC`;
  return rows.map(assignment);
}

export async function markGuideSynced(shop: string, assignmentId: string, guideVersion: Date, syncLockToken?: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const locks = await tx.$queryRaw<Array<{ productId: string; cleanupPending: boolean }>>`
      SELECT "productId", "cleanupPending" FROM "SizeGuideProductSyncLock" WHERE "shop" = ${shop}
        AND "token" = ${syncLockToken ?? ""} AND "state" = 'PUBLISHING' FOR UPDATE`;
    if (!locks[0] || locks[0].cleanupPending) return false;
    const count = await tx.$executeRaw`
      UPDATE "SizeGuideProduct" p SET "syncStatus" = 'SYNCED', "syncedGuideUpdatedAt" = ${guideVersion},
        "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      FROM "SizeGuide" g WHERE p."shop" = ${shop} AND p."id" = ${assignmentId}
        AND p."productId" = ${locks[0].productId} AND p."syncStatus" = 'SYNCING'
        AND g."shop" = p."shop" AND g."id" = p."guideId" AND g."updatedAt" = ${guideVersion}`;
    return count > 0;
  });
}

export async function beginGuideSync(shop: string, assignmentId: string): Promise<SizeGuideAssignment | null> {
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<Array<{ productId: string; productTitle: string }>>`
      SELECT "productId", "productTitle" FROM "SizeGuideProduct" WHERE "shop" = ${shop} AND "id" = ${assignmentId}
        AND "syncStatus" IN ('PENDING', 'SYNCED', 'FAILED')
        AND COALESCE("lastError", '') NOT LIKE ${`${ORPHAN_CLEANUP_MARKER}%`} FOR UPDATE`;
    if (!candidates[0]) return null;
    const token = crypto.randomUUID();
    const lock = await tx.$queryRaw<Array<{ token: string }>>`
      INSERT INTO "SizeGuideProductSyncLock" ("shop", "productId", "productTitle", "state", "token", "leaseUntil")
      VALUES (${shop}, ${candidates[0].productId}, ${candidates[0].productTitle}, 'PUBLISHING', ${token}, CURRENT_TIMESTAMP + ${SYNC_LOCK_LEASE})
      ON CONFLICT ("shop", "productId") DO UPDATE SET "productTitle" = EXCLUDED."productTitle",
        "state" = 'PUBLISHING', "token" = EXCLUDED."token", "leaseUntil" = EXCLUDED."leaseUntil",
        "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "SizeGuideProductSyncLock"."state" = 'PUBLISHING'
        AND "SizeGuideProductSyncLock"."leaseUntil" <= CURRENT_TIMESTAMP RETURNING "token"`;
    if (!lock[0]) return null;
    const changed = await tx.$executeRaw`
      UPDATE "SizeGuideProduct" SET "syncStatus" = 'SYNCING', "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "shop" = ${shop} AND "id" = ${assignmentId} AND "syncStatus" IN ('PENDING', 'SYNCED', 'FAILED')
        AND COALESCE("lastError", '') NOT LIKE ${`${ORPHAN_CLEANUP_MARKER}%`}`;
    if (!changed) {
      await tx.$executeRaw`DELETE FROM "SizeGuideProductSyncLock" WHERE "shop" = ${shop}
        AND "productId" = ${candidates[0].productId} AND "token" = ${token}`;
      return null;
    }
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT p.*, ${Prisma.raw(GUIDE_COLUMNS)}
      FROM "SizeGuideProduct" p JOIN "SizeGuide" g ON g."shop" = p."shop" AND g."id" = p."guideId"
      WHERE p."shop" = ${shop} AND p."id" = ${assignmentId} AND p."syncStatus" = 'SYNCING' LIMIT 1`;
    return rows[0] ? { ...assignment(rows[0]), syncLockToken: token } : null;
  });
}

export async function releaseGuideSyncLock(shop: string, productId: string, token: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const dirty = await tx.$queryRaw<Array<{ cleanupPending: boolean }>>`
      SELECT "cleanupPending" FROM "SizeGuideProductSyncLock" WHERE "shop" = ${shop} AND "productId" = ${productId}
        AND "state" = 'PUBLISHING' AND "token" = ${token} FOR UPDATE`;
    if (!dirty[0]) return;
    if (dirty[0].cleanupPending) {
      const cleanupToken = crypto.randomUUID();
      await tx.$executeRaw`
        UPDATE "SizeGuideProductSyncLock" SET "state" = 'CLEANUP', "token" = ${cleanupToken},
          "leaseUntil" = CURRENT_TIMESTAMP, "lastError" = ${"A late publish requires storefront cleanup and retry."},
          "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}
            AND "state" = 'PUBLISHING' AND "token" = ${token} AND "cleanupPending" = TRUE`;
      await tx.$executeRaw`
        UPDATE "SizeGuideProduct" SET "syncStatus" = 'FAILED', "lastError" = ${`${ORPHAN_CLEANUP_MARKER}${cleanupToken}`},
          "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}
            AND "syncStatus" IN ('PENDING', 'SYNCING', 'SYNCED', 'FAILED')`;
      return;
    }
    await tx.$executeRaw`
      DELETE FROM "SizeGuideProductSyncLock" WHERE "shop" = ${shop} AND "productId" = ${productId}
        AND "state" = 'PUBLISHING' AND "token" = ${token} AND "cleanupPending" = FALSE`;
  });
}

export {
  beginGuideCleanupPass,
  claimExpiredGuideCleanup,
  claimPendingGuideCleanup,
  finishGuideCleanup,
  promoteGuideSyncLockToCleanup,
  recordGuideCleanupFailure,
  requestOrphanGuideCleanup,
} from "./size-guide-cleanup-repository.server";

export async function resetGuideSync(shop: string, assignmentId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SizeGuideProduct" SET "syncStatus" = 'PENDING', "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "shop" = ${shop} AND "id" = ${assignmentId} AND "syncStatus" = 'SYNCING'`;
}

export async function markGuideSyncFailed(shop: string, assignmentId: string, message: string, syncLockToken?: string): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "SizeGuideProduct" SET "syncStatus" = 'FAILED', "lastError" = ${message.slice(0, 500)},
      "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "id" = ${assignmentId}
      AND "syncStatus" IN ('PENDING', 'SYNCING', 'SYNCED', 'FAILED')
      AND COALESCE("lastError", '') NOT LIKE ${`${ORPHAN_CLEANUP_MARKER}%`}
      AND NOT EXISTS (SELECT 1 FROM "SizeGuideProductSyncLock" l WHERE l."shop" = ${shop}
        AND l."productId" = "SizeGuideProduct"."productId" AND l."state" = 'CLEANUP')
      AND (${syncLockToken === undefined} OR EXISTS (SELECT 1 FROM "SizeGuideProductSyncLock" l
        WHERE l."shop" = ${shop} AND l."productId" = "SizeGuideProduct"."productId"
          AND l."state" = 'PUBLISHING' AND l."token" = ${syncLockToken ?? ""}))`;
  return count > 0;
}

export async function markGuideRemovalPending(shop: string, productId: string): Promise<{
  assignment: SizeGuideAssignment | null; deferred: boolean;
}> {
  const deferred = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ syncStatus: string; lockState: string | null }>>`
      SELECT p."syncStatus", l."state" AS "lockState" FROM "SizeGuideProduct" p
      LEFT JOIN "SizeGuideProductSyncLock" l ON l."shop" = p."shop" AND l."productId" = p."productId"
      WHERE p."shop" = ${shop} AND p."productId" = ${productId} FOR UPDATE OF p`;
    if (!rows[0]) return false;
    const waitingForSync = rows[0].syncStatus === "SYNCING" || rows[0].syncStatus === "REMOVE_WAITING_SYNC" || Boolean(rows[0].lockState);
    await tx.$executeRaw`
      UPDATE "SizeGuideProduct" SET "syncStatus" = ${waitingForSync ? "REMOVE_WAITING_SYNC" : "REMOVE_PENDING"},
        "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "productId" = ${productId}`;
    return waitingForSync;
  });
  return { assignment: await getSizeGuideAssignment(shop, productId), deferred };
}

export async function markGuideRemovalReady(shop: string, assignmentId: string): Promise<SizeGuideAssignment | null> {
  await prisma.$executeRaw`
    UPDATE "SizeGuideProduct" SET "syncStatus" = 'REMOVE_PENDING', "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "shop" = ${shop} AND "id" = ${assignmentId} AND "syncStatus" = 'REMOVE_WAITING_SYNC'`;
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT p.*, ${Prisma.raw(GUIDE_COLUMNS)}
    FROM "SizeGuideProduct" p JOIN "SizeGuide" g ON g."shop" = p."shop" AND g."id" = p."guideId"
    WHERE p."shop" = ${shop} AND p."id" = ${assignmentId} AND p."syncStatus" = 'REMOVE_PENDING' LIMIT 1`;
  return rows[0] ? assignment(rows[0]) : null;
}

export async function markGuideRemovalFailed(shop: string, assignmentId: string, message: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SizeGuideProduct" SET "syncStatus" = 'REMOVE_FAILED', "lastError" = ${message.slice(0, 500)},
      "updatedAt" = CURRENT_TIMESTAMP WHERE "shop" = ${shop} AND "id" = ${assignmentId}
      AND "syncStatus" IN ('REMOVE_PENDING', 'REMOVE_FAILED')`;
}

export async function deleteGuideAssignment(shop: string, assignmentId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "SizeGuideProduct" WHERE "shop" = ${shop} AND "id" = ${assignmentId}
      AND "syncStatus" IN ('REMOVE_PENDING', 'REMOVE_FAILED')`;
}

export async function deleteSizeGuide(shop: string, guideId: string): Promise<boolean> {
  const count = await prisma.$executeRaw`
    DELETE FROM "SizeGuide" g WHERE g."shop" = ${shop} AND g."id" = ${guideId}
      AND NOT EXISTS (SELECT 1 FROM "SizeGuideProduct" p WHERE p."shop" = g."shop" AND p."guideId" = g."id")`;
  return count > 0;
}

export { assignSizeGuideProducts } from "./size-guide-assignment-repository.server";
