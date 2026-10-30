import { getGraphQLData } from "./shopify-graphql.server";
import { sizeGuideStorefrontProjection } from "./size-guides.shared";
import {
  beginGuideSync,
  deleteGuideAssignment,
  getSizeGuideAssignment,
  markGuideRemovalFailed,
  markGuideRemovalReady,
  markGuideRemovalPending,
  markGuideSyncFailed,
  markGuideSynced,
  resetGuideSync,
  type SizeGuideAssignment,
} from "./size-guide-repository.server";
import * as sizeGuideRepository from "./size-guide-repository.server";

export const SIZE_GUIDE_NAMESPACE = "$app:size_guide";
export const SIZE_GUIDE_KEY = "chart";
type AdminGraphql = { graphql: (query: string, options: { variables: Record<string, unknown> }) => Promise<Response> };
type MutationErrors = { userErrors?: Array<{ message?: string }> };
const activeSyncs = new Map<string, number>();
const ORPHAN_CLEANUP_MARKER = "ORPHAN_CLEANUP_PENDING:";

function syncKey(shop: string, productId: string) {
  return `${shop}\u0000${productId}`;
}

function hasActiveSync(shop: string, productId: string) {
  return (activeSyncs.get(syncKey(shop, productId)) ?? 0) > 0;
}

async function runMutation<T>(admin: AdminGraphql, query: string, variables: Record<string, unknown>): Promise<T> {
  const data = await getGraphQLData<T>(await admin.graphql(query, { variables }));
  const payload = Object.values(data as Record<string, unknown>)[0] as MutationErrors | undefined;
  const errors = payload?.userErrors?.map((item) => item.message).filter(Boolean);
  if (errors?.length) throw new Error(errors.join("; ").slice(0, 500));
  return data;
}

async function writeStorefrontGuide(admin: AdminGraphql, assignment: SizeGuideAssignment) {
  await runMutation(admin, `#graphql
    mutation StockHubSetSizeGuide($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`, {
    metafields: [{
      ownerId: assignment.productId,
      namespace: SIZE_GUIDE_NAMESPACE,
      key: SIZE_GUIDE_KEY,
      type: "json",
      value: JSON.stringify(sizeGuideStorefrontProjection(assignment.guide)),
    }],
  });
}

async function deleteStorefrontGuide(admin: AdminGraphql, productId: string) {
  await runMutation(admin, `#graphql
    mutation StockHubDeleteSizeGuide($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) { userErrors { field message } }
    }`, {
    metafields: [{ ownerId: productId, namespace: SIZE_GUIDE_NAMESPACE, key: SIZE_GUIDE_KEY }],
  });
}

async function finishRemoval(admin: AdminGraphql, assignment: SizeGuideAssignment): Promise<"removed" | "failed"> {
  try {
    await deleteStorefrontGuide(admin, assignment.productId);
    await deleteGuideAssignment(assignment.shop, assignment.id);
    return "removed";
  } catch {
    await markGuideRemovalFailed(assignment.shop, assignment.id, "Shopify could not remove the size-guide metafield. Retry removal.");
    return "failed";
  }
}

async function finishDeferredRemoval(admin: AdminGraphql, shop: string, assignmentId: string, productId: string): Promise<"removed" | "failed" | "pending"> {
  const ready = await markGuideRemovalReady(shop, assignmentId);
  if (ready) return finishRemoval(admin, ready);
  const latest = await getSizeGuideAssignment(shop, productId);
  if (latest && (latest.syncStatus === "REMOVE_PENDING" || latest.syncStatus === "REMOVE_FAILED")) {
    return finishRemoval(admin, latest);
  }
  return "pending";
}

async function finishCleanupAndRepublish(admin: AdminGraphql, shop: string, productId: string, cleanupToken: string): Promise<boolean> {
  for (let pass = 0; pass < 4; pass += 1) {
    const generation = await sizeGuideRepository.beginGuideCleanupPass?.(shop, productId, cleanupToken);
    if (generation === undefined || generation === null) return false;
    try {
      await deleteStorefrontGuide(admin, productId);
    } catch (error) {
      await sizeGuideRepository.recordGuideCleanupFailure?.(shop, productId, cleanupToken,
        "Shopify may have applied the orphan cleanup. Retry after the recovery lease expires.");
      throw error;
    }
    if (await sizeGuideRepository.finishGuideCleanup?.(shop, productId, cleanupToken, generation)) {
      const latest = await getSizeGuideAssignment(shop, productId);
      if (latest?.syncStatus === "REMOVE_WAITING_SYNC") await finishDeferredRemoval(admin, shop, latest.id, productId);
      else if (latest?.syncStatus === "REMOVE_PENDING" || latest?.syncStatus === "REMOVE_FAILED") await finishRemoval(admin, latest);
      const current = await getSizeGuideAssignment(shop, productId);
      if (current && !current.syncStatus.startsWith("REMOVE_")) await syncSizeGuideAssignment(admin, shop, current.id);
      return true;
    }
  }
  await sizeGuideRepository.recordGuideCleanupFailure?.(shop, productId, cleanupToken,
    "A late storefront write arrived during cleanup. Retry after the recovery lease expires.");
  return false;
}

async function reconcileOrphanedPublish(admin: AdminGraphql, shop: string, productId: string, assignmentId: string, publishToken: string) {
  const latest = await getSizeGuideAssignment(shop, productId);
  if (latest?.id === assignmentId) return false;

  // A completed stale request must record cleanup even if another worker
  // already released the lease that originally fenced its publish.
  const cleanupToken = await sizeGuideRepository.requestOrphanGuideCleanup?.(
    shop, productId, publishToken, latest?.productTitle ?? productId,
  );
  if (!cleanupToken) return true;
  await finishCleanupAndRepublish(admin, shop, productId, cleanupToken);
  return true;
}

async function syncSizeGuideAssignmentInternal(admin: AdminGraphql, shop: string, assignmentId: string) {
  let current = await beginGuideSync(shop, assignmentId);
  if (!current) return { status: "unchanged" as const };
  const productId = current.productId;
  const syncLockToken = current.syncLockToken ?? "";
  const key = syncKey(shop, productId);
  activeSyncs.set(key, (activeSyncs.get(key) ?? 0) + 1);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
    const version = current.guide.updatedAt;
    try {
      await writeStorefrontGuide(admin, current);
    } catch {
      const latest = await getSizeGuideAssignment(shop, productId);
      if (!latest || latest.id !== assignmentId) {
        await reconcileOrphanedPublish(admin, shop, productId, assignmentId, syncLockToken);
        return { status: "unchanged" as const };
      }
      if (latest.lastError?.startsWith(ORPHAN_CLEANUP_MARKER)) {
        const cleanupToken = await sizeGuideRepository.claimPendingGuideCleanup?.(shop, productId, syncLockToken);
        if (cleanupToken) await finishCleanupAndRepublish(admin, shop, productId, cleanupToken);
        return { status: "unchanged" as const };
      }
      if (latest?.syncStatus === "REMOVE_WAITING_SYNC") {
        return { status: await finishDeferredRemoval(admin, shop, assignmentId, productId) };
      }
      if (latest?.syncStatus === "REMOVE_PENDING" || latest?.syncStatus === "REMOVE_FAILED") {
        return { status: await finishRemoval(admin, latest) };
      }
      await markGuideSyncFailed(shop, assignmentId, "Shopify could not publish this chart. Canonical guide data is safe; retry sync.", syncLockToken);
      return { status: "failed" as const };
    }

    const latest = await getSizeGuideAssignment(shop, productId);
    if (!latest || latest.id !== assignmentId) {
      await reconcileOrphanedPublish(admin, shop, productId, assignmentId, syncLockToken);
      return { status: "unchanged" as const };
    }
    if (latest.syncStatus === "REMOVE_WAITING_SYNC") {
      return { status: await finishDeferredRemoval(admin, shop, assignmentId, productId) };
    }
    if (latest.syncStatus === "REMOVE_PENDING" || latest.syncStatus === "REMOVE_FAILED") {
      return { status: await finishRemoval(admin, latest) };
    }
    if (latest.guide.updatedAt.getTime() !== version.getTime()) {
      if (latest.syncStatus !== "SYNCING") {
        const restarted = await beginGuideSync(shop, assignmentId);
        if (!restarted) return { status: "unchanged" as const };
        current = restarted;
      } else current = latest;
      continue;
    }
    if (await markGuideSynced(shop, assignmentId, version, syncLockToken)) {
      return { status: "synced" as const };
    }
    const afterMark = await getSizeGuideAssignment(shop, productId);
    if (!afterMark || afterMark.id !== assignmentId) {
      await reconcileOrphanedPublish(admin, shop, productId, assignmentId, syncLockToken);
      return { status: "unchanged" as const };
    }
    if (afterMark.syncStatus === "REMOVE_WAITING_SYNC") {
      return { status: await finishDeferredRemoval(admin, shop, assignmentId, productId) };
    }
    if (afterMark.syncStatus.startsWith("REMOVE_")) {
      return { status: await finishRemoval(admin, afterMark) };
    }
    if (afterMark.lastError?.startsWith(ORPHAN_CLEANUP_MARKER)) {
      const cleanupToken = await sizeGuideRepository.claimPendingGuideCleanup?.(shop, productId, syncLockToken);
      if (cleanupToken) await finishCleanupAndRepublish(admin, shop, productId, cleanupToken);
      return { status: "unchanged" as const };
    }
    if (afterMark.guide.updatedAt.getTime() !== version.getTime()) {
      if (afterMark.syncStatus !== "SYNCING") {
        const restarted = await beginGuideSync(shop, assignmentId);
        if (!restarted) return { status: "unchanged" as const };
        current = restarted;
      } else current = afterMark;
      continue;
    }
    if (afterMark.syncStatus !== "SYNCING") {
      const restarted = await beginGuideSync(shop, assignmentId);
      if (restarted) {
        // A restarted sync must write the storefront projection again before
        // it can be marked SYNCED; the previous write may have been deleted.
        current = restarted;
        continue;
      }
    }
    return { status: "unchanged" as const };
    }
    await markGuideSyncFailed(shop, assignmentId, "The guide changed during synchronization. Retry to publish the latest version.", syncLockToken);
    return { status: "failed" as const };
  } finally {
    if (syncLockToken) await sizeGuideRepository.releaseGuideSyncLock?.(shop, productId, syncLockToken);
    const remaining = (activeSyncs.get(key) ?? 1) - 1;
    if (remaining <= 0) activeSyncs.delete(key);
    else activeSyncs.set(key, remaining);
  }
}

export async function syncSizeGuideAssignment(admin: AdminGraphql, shop: string, assignmentId: string) {
  return syncSizeGuideAssignmentInternal(admin, shop, assignmentId);
}

export async function removeSizeGuideAssignment(admin: AdminGraphql, shop: string, productId: string) {
  const marked = await markGuideRemovalPending(shop, productId);
  if (!marked.assignment) return { status: "unchanged" as const };
  if (marked.deferred) return { status: "pending" as const };
  return { status: await finishRemoval(admin, marked.assignment) };
}

export async function retrySizeGuideRemoval(admin: AdminGraphql, assignment: SizeGuideAssignment) {
  const current = await getSizeGuideAssignment(assignment.shop, assignment.productId);
  if (!current) return { status: "unchanged" as const };
  const lock = await sizeGuideRepository.getSizeGuideProductSyncLock?.(current.shop, current.productId);
  if (lock) {
    if (lock.leaseUntil.getTime() <= Date.now()) return retryOrphanedSizeGuideCleanup(admin, current.shop, current.productId);
    return { status: "pending" as const };
  }
  if (current.syncStatus === "REMOVE_WAITING_SYNC") {
    if (hasActiveSync(current.shop, current.productId)) return { status: "pending" as const };
    const ready = await markGuideRemovalReady(current.shop, current.id);
    if (ready) return { status: await finishRemoval(admin, ready) };
    const latest = await getSizeGuideAssignment(current.shop, current.productId);
    if (!latest) return { status: "unchanged" as const };
    if (latest.syncStatus === "REMOVE_WAITING_SYNC") return { status: "pending" as const };
    if (latest.syncStatus === "REMOVE_PENDING" || latest.syncStatus === "REMOVE_FAILED") {
      return { status: await finishRemoval(admin, latest) };
    }
    return { status: "unchanged" as const };
  }
  if (current.syncStatus !== "REMOVE_PENDING" && current.syncStatus !== "REMOVE_FAILED") {
    return { status: "unchanged" as const };
  }
  return { status: await finishRemoval(admin, current) };
}

export async function retrySizeGuideSync(admin: AdminGraphql, shop: string, assignmentId: string, productId: string) {
  const current = await getSizeGuideAssignment(shop, productId);
  if (current?.lastError?.startsWith(ORPHAN_CLEANUP_MARKER)) return retryOrphanedSizeGuideCleanup(admin, shop, productId);
  const lock = await sizeGuideRepository.getSizeGuideProductSyncLock?.(shop, productId);
  if (lock) {
    if (lock.state === "CLEANUP") {
      return lock.leaseUntil.getTime() <= Date.now()
        ? retryOrphanedSizeGuideCleanup(admin, shop, productId)
        : { status: "pending" as const };
    }
    if (lock.leaseUntil.getTime() > Date.now()) return { status: "pending" as const };
  }
  await resetGuideSync(shop, assignmentId);
  return syncSizeGuideAssignment(admin, shop, assignmentId);
}

export async function retryOrphanedSizeGuideCleanup(admin: AdminGraphql, shop: string, productId: string) {
  const cleanupToken = crypto.randomUUID();
  const claimed = await sizeGuideRepository.claimExpiredGuideCleanup?.(shop, productId, cleanupToken);
  if (!claimed) return { status: "pending" as const };
  try {
    const completed = await finishCleanupAndRepublish(admin, shop, productId, cleanupToken);
    return completed ? { status: "removed" as const } : { status: "pending" as const };
  } catch {
    return { status: "failed" as const };
  }
}
