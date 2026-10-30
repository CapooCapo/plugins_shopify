import { Prisma } from "@prisma/client";
import prisma from "../db.server";

const ORPHAN_CLEANUP_MARKER = "ORPHAN_CLEANUP_PENDING:";
const LOCKED_STATES = new Set(["SYNCING", "REMOVE_WAITING_SYNC", "REMOVE_PENDING", "REMOVE_FAILED"]);

type ProductInput = { id: string; title: string };
type AssignmentInput = {
  shop: string;
  guideId: string;
  products: ProductInput[];
  replaceProductIds: string[];
  confirmReplacements: boolean;
};
type AssignmentResult =
  | { status: "assigned"; assignmentIds: string[]; unchangedProductIds: string[] }
  | { status: "replacement_confirmation_required"; conflicts: Array<{ productId: string; currentGuideId: string }> }
  | { status: "locked"; productIds: string[] }
  | { status: "guide_not_found" };
type ExistingAssignment = { id: string; productId: string; guideId: string; syncStatus: string; lastError: string | null };
type ProductLock = { productId: string };

/** Persist an atomic product-to-guide batch without weakening the sync/cleanup fences. */
export async function assignSizeGuideProducts(input: AssignmentInput): Promise<AssignmentResult> {
  const products = [...new Map(input.products.map((product) => [product.id, product])).values()];
  const productIds = products.map((product) => product.id).sort();
  const replaceProductIds = new Set(input.replaceProductIds);

  const persistBatch = () => prisma.$transaction(async (tx) => {
    const guide = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "SizeGuide" WHERE "shop" = ${input.shop} AND "id" = ${input.guideId} FOR KEY SHARE`;
    if (!guide[0]) return { status: "guide_not_found" as const };

    // Serialize this app's writers for each product, including the not-yet-assigned case.
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtext(${input.shop}), hashtext(product_id))
      FROM unnest(ARRAY[${Prisma.join(productIds)}]::text[]) AS selected(product_id)
      ORDER BY product_id`;

    const assignments = await tx.$queryRaw<ExistingAssignment[]>`
      SELECT "id", "productId", "guideId", "syncStatus", "lastError"
      FROM "SizeGuideProduct" WHERE "shop" = ${input.shop} AND "productId" IN (${Prisma.join(productIds)})
      FOR UPDATE`;
    const locks = await tx.$queryRaw<ProductLock[]>`
      SELECT "productId" FROM "SizeGuideProductSyncLock" WHERE "shop" = ${input.shop}
        AND "productId" IN (${Prisma.join(productIds)}) FOR UPDATE`;
    const byProductId = new Map(assignments.map((row) => [row.productId, row]));
    const lockedIds = new Set(locks.map((row) => row.productId));
    for (const row of assignments) {
      if (LOCKED_STATES.has(row.syncStatus) || row.syncStatus.startsWith("REMOVE_") ||
        row.lastError?.startsWith(ORPHAN_CLEANUP_MARKER)) lockedIds.add(row.productId);
    }
    if (lockedIds.size) return { status: "locked" as const, productIds: productIds.filter((id) => lockedIds.has(id)) };

    const conflicts = products.flatMap((product) => {
      const row = byProductId.get(product.id);
      return row && row.guideId !== input.guideId ? [{ productId: row.productId, currentGuideId: row.guideId }] : [];
    });
    const missingConfirmation = conflicts.some((item) => !replaceProductIds.has(item.productId));
    if (conflicts.length && (!input.confirmReplacements || missingConfirmation)) {
      return { status: "replacement_confirmation_required" as const, conflicts };
    }

    const assignmentIds: string[] = [];
    const unchangedProductIds: string[] = [];
    for (const product of products) {
      const existing = byProductId.get(product.id);
      if (existing?.guideId === input.guideId) {
        assignmentIds.push(existing.id);
        if (existing.syncStatus === "SYNCED") unchangedProductIds.push(product.id);
      } else if (existing) {
        await tx.$executeRaw`
          UPDATE "SizeGuideProduct" SET "guideId" = ${input.guideId}, "productTitle" = ${product.title},
            "syncStatus" = 'PENDING', "syncedGuideUpdatedAt" = NULL, "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "shop" = ${input.shop} AND "id" = ${existing.id} AND "productId" = ${product.id}`;
        assignmentIds.push(existing.id);
      } else {
        const id = crypto.randomUUID();
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "SizeGuideProduct" ("id", "shop", "guideId", "productId", "productTitle")
          VALUES (${id}, ${input.shop}, ${input.guideId}, ${product.id}, ${product.title})
          ON CONFLICT ("shop", "productId") DO NOTHING RETURNING "id"`;
        if (!inserted[0]) throw new Error("SIZE_GUIDE_ASSIGNMENT_RACE");
        assignmentIds.push(inserted[0].id);
      }
    }
    return { status: "assigned" as const, assignmentIds, unchangedProductIds };
  });

  try {
    return await persistBatch();
  } catch (error) {
    if (String(error).includes("SIZE_GUIDE_ASSIGNMENT_RACE")) return persistBatch();
    throw error;
  }
}
