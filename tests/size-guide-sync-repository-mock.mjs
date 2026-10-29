export function createSizeGuideRepositoryMockSource(globalStateName) {
  const stateExpression = `globalThis[${JSON.stringify(globalStateName)}]`;
  return `
    const state = ${stateExpression};
    const cleanupMarker = "ORPHAN_CLEANUP_PENDING:";
    const lockKey = (shop, productId) => shop + "\\u0000" + productId;
    const locks = () => state.locks ??= Object.create(null);
    const allAssignments = () => state.assignments ? Object.values(state.assignments) : state.assignment ? [state.assignment] : [];
    const byId = (id) => allAssignments().find((item) => item.id === id) ?? null;
    const byProduct = (shop, productId) => allAssignments().find((item) => item.shop === shop && item.productId === productId) ?? null;
    const copy = (item) => item ? structuredClone(item) : null;
    const copyAssignment = (item) => {
      if (!item) return null;
      const lock = locks()[lockKey(item.shop, item.productId)];
      return { ...copy(item), syncLockToken: lock?.state === "PUBLISHING" ? lock.token : undefined };
    };
    const putAssignment = (item) => {
      if (state.assignments) state.assignments[item.id] = item;
      else state.assignment = item;
    };
    const removeAssignment = (id) => {
      if (state.assignments) delete state.assignments[id];
      else if (state.assignment?.id === id) state.assignment = null;
    };
    const nextToken = (prefix) => prefix + "-" + (state.nextToken = (state.nextToken ?? 0) + 1);
    const lease = () => new Date(Date.now() + 600_000);

    export async function beginGuideSync(shop, id) {
      const item = byId(id);
      if (!item || item.shop !== shop || !["PENDING", "SYNCED", "FAILED"].includes(item.syncStatus) ||
          String(item.lastError ?? "").startsWith(cleanupMarker)) return null;
      const key = lockKey(shop, item.productId);
      const currentLock = locks()[key];
      if (currentLock && !(currentLock.state === "PUBLISHING" && currentLock.leaseUntil.getTime() <= Date.now())) return null;
      const token = nextToken("publish");
      locks()[key] = {
        shop, productId: item.productId, productTitle: item.productTitle, state: "PUBLISHING", token,
        leaseUntil: lease(), lastError: null, cleanupGeneration: "0", cleanupPending: false,
      };
      item.syncStatus = "SYNCING";
      item.lastError = null;
      return copyAssignment(item);
    }
    export async function markGuideSynced(shop, id, version, token) {
      const item = byId(id);
      if (id === "newer-assignment" && state.newerMarkGate && !state.newerMarkWasGated) {
        state.newerMarkWasGated = true;
        state.newerMarkStarted.resolve();
        await state.newerMarkGate.promise;
      }
      const lock = item && locks()[lockKey(shop, item.productId)];
      if (!item || item.shop !== shop || item.syncStatus !== "SYNCING" || lock?.state !== "PUBLISHING" || lock.token !== token ||
          item.guide.updatedAt.getTime() !== version.getTime()) return false;
      item.syncStatus = "SYNCED";
      item.syncedGuideUpdatedAt = version;
      item.lastError = null;
      return true;
    }
    export async function markGuideSyncFailed(shop, id, message, token) {
      const item = byId(id);
      if (!item || item.shop !== shop || !["PENDING", "SYNCING", "SYNCED", "FAILED"].includes(item.syncStatus) ||
          String(item.lastError ?? "").startsWith(cleanupMarker)) return false;
      const lock = locks()[lockKey(shop, item.productId)];
      if (lock?.state === "CLEANUP" || (token !== undefined && (lock?.state !== "PUBLISHING" || lock.token !== token))) return false;
      item.syncStatus = "FAILED";
      item.lastError = message;
      return true;
    }
    const markOrphanCleanup = (shop, productId, markerToken) => {
      const item = byProduct(shop, productId);
      if (item && ["PENDING", "SYNCING", "SYNCED", "FAILED"].includes(item.syncStatus)) {
        item.syncStatus = "FAILED";
        item.lastError = cleanupMarker + markerToken;
      }
    };
    const generation = (lock) => String(lock.cleanupGeneration ?? "0");
    const nextGeneration = (lock) => {
      lock.cleanupGeneration = String(BigInt(generation(lock)) + 1n);
      return lock.cleanupGeneration;
    };

    export async function promoteGuideSyncLockToCleanup(shop, productId, publishToken) {
      const key = lockKey(shop, productId);
      const lock = locks()[key];
      if (!lock || lock.state !== "PUBLISHING" || lock.token !== publishToken) return null;
      const token = nextToken("cleanup");
      lock.state = "CLEANUP";
      lock.token = token;
      lock.leaseUntil = lease();
      lock.lastError = "A previous publish is being reconciled.";
      nextGeneration(lock);
      lock.cleanupPending = true;
      markOrphanCleanup(shop, productId, token);
      return token;
    }
    export async function recordGuideCleanupFailure(shop, productId, token, message) {
      const lock = locks()[lockKey(shop, productId)];
      if (lock?.state === "CLEANUP" && lock.token === token) { lock.lastError = message; lock.leaseUntil = lease(); }
    }

    export async function requestOrphanGuideCleanup(shop, productId, publishToken, productTitle) {
      const key = lockKey(shop, productId);
      const lock = locks()[key];
      let ownerToken = null;
      let markerToken = lock?.token ?? nextToken("cleanup");
      if (!lock) {
        const token = markerToken;
        locks()[key] = {
          shop, productId, productTitle, state: "CLEANUP", token, leaseUntil: lease(),
          lastError: "A late publish completed after its prior cleanup lease was released.",
          cleanupGeneration: "1", cleanupPending: true,
        };
        ownerToken = token;
        markerToken = token;
      } else if ((lock.state === "PUBLISHING" && lock.token === publishToken) || lock.leaseUntil.getTime() <= Date.now()) {
        const token = nextToken("cleanup");
        lock.productTitle = productTitle;
        lock.state = "CLEANUP";
        lock.token = token;
        lock.leaseUntil = lease();
        lock.cleanupPending = true;
        nextGeneration(lock);
        lock.lastError = "A late publish completed after its prior cleanup lease was released.";
        ownerToken = token;
        markerToken = token;
      } else {
        nextGeneration(lock);
        lock.cleanupPending = true;
        lock.lastError = "A late publish is pending cleanup by the current product lock owner.";
      }
      markOrphanCleanup(shop, productId, markerToken);
      return ownerToken;
    }

    export async function claimPendingGuideCleanup(shop, productId, publishToken) {
      const lock = locks()[lockKey(shop, productId)];
      if (lock?.state !== "PUBLISHING" || lock.token !== publishToken || !lock.cleanupPending) return null;
      const token = nextToken("cleanup");
      lock.state = "CLEANUP";
      lock.token = token;
      lock.leaseUntil = lease();
      lock.lastError = "The active publisher is reconciling a late storefront write.";
      markOrphanCleanup(shop, productId, token);
      return token;
    }

    export async function beginGuideCleanupPass(shop, productId, cleanupToken) {
      const lock = locks()[lockKey(shop, productId)];
      if (lock?.state !== "CLEANUP" || lock.token !== cleanupToken) return null;
      lock.cleanupPending = false;
      lock.leaseUntil = lease();
      return generation(lock);
    }

    export async function finishGuideCleanup(shop, productId, token, coveredGeneration) {
      const key = lockKey(shop, productId);
      const lock = locks()[key];
      if (lock?.state !== "CLEANUP" || lock.token !== token || lock.cleanupPending || generation(lock) !== String(coveredGeneration)) return false;
      const item = byProduct(shop, productId);
      if (item?.lastError === cleanupMarker + token) {
        item.syncStatus = "FAILED";
        item.lastError = "A previous publish removed this chart. Retry to publish it.";
      }
      delete locks()[key];
      return true;
    }
    export async function claimExpiredGuideCleanup(shop, productId, token) {
      const key = lockKey(shop, productId);
      const lock = locks()[key];
      if (!lock || lock.leaseUntil.getTime() > Date.now() || !["PUBLISHING", "CLEANUP"].includes(lock.state)) return false;
      lock.state = "CLEANUP";
      lock.token = token;
      lock.leaseUntil = lease();
      lock.lastError = "Retrying interrupted size-guide cleanup.";
      nextGeneration(lock);
      lock.cleanupPending = true;
      markOrphanCleanup(shop, productId, token);
      return true;
    }
    export async function releaseGuideSyncLock(shop, productId, token) {
      const key = lockKey(shop, productId);
      const lock = locks()[key];
      if (lock?.state !== "PUBLISHING" || lock.token !== token) return;
      if (lock.cleanupPending) {
        const cleanupToken = nextToken("cleanup");
        lock.state = "CLEANUP";
        lock.token = cleanupToken;
        lock.leaseUntil = new Date();
        lock.lastError = "A late publish requires storefront cleanup and retry.";
        markOrphanCleanup(shop, productId, cleanupToken);
        return;
      }
      delete locks()[key];
    }
    export async function getSizeGuideProductSyncLock(shop, productId) {
      return copy(locks()[lockKey(shop, productId)]);
    }
    export async function listOrphanedSizeGuideSyncLocks(shop) {
      return Object.values(locks()).filter((lock) => lock.shop === shop && !byProduct(shop, lock.productId)).map(copy);
    }
    export async function createSizeGuideAssignment(input) {
      if (locks()[lockKey(input.shop, input.productId)]) throw new Error("SIZE_GUIDE_PRODUCT_SYNC_LOCKED");
      if (byProduct(input.shop, input.productId)) throw new Error("SIZE_GUIDE_PRODUCT_ALREADY_ASSIGNED");
      const item = input.assignment ?? null;
      if (!item) throw new Error("TEST_FIXTURE_ASSIGNMENT_REQUIRED");
      putAssignment(item);
    }
    export async function getSizeGuideAssignment(shop, requestedProductId) { return copyAssignment(byProduct(shop, requestedProductId)); }
    export async function deleteGuideAssignment(shop, id) {
      const item = byId(id);
      if (item?.shop === shop && ["REMOVE_PENDING", "REMOVE_FAILED"].includes(item.syncStatus)) removeAssignment(id);
    }
    export async function markGuideRemovalFailed(shop, id, message) {
      const item = byId(id);
      if (item?.shop === shop && ["REMOVE_PENDING", "REMOVE_FAILED"].includes(item.syncStatus)) { item.syncStatus = "REMOVE_FAILED"; item.lastError = message; }
    }
    export async function markGuideRemovalReady(shop, id) {
      const item = byId(id);
      if (item?.shop !== shop || item.syncStatus !== "REMOVE_WAITING_SYNC") return null;
      item.syncStatus = "REMOVE_PENDING";
      return copyAssignment(item);
    }
    export async function markGuideRemovalPending(shop, productId) {
      const item = byProduct(shop, productId);
      if (!item) return { assignment: null, deferred: false };
      const deferred = Boolean(locks()[lockKey(shop, productId)]) || ["SYNCING", "REMOVE_WAITING_SYNC"].includes(item.syncStatus);
      item.syncStatus = deferred ? "REMOVE_WAITING_SYNC" : "REMOVE_PENDING";
      return { assignment: copyAssignment(item), deferred };
    }
    export async function resetGuideSync(shop, id) {
      const item = byId(id);
      if (item?.shop === shop && item.syncStatus === "SYNCING") item.syncStatus = "PENDING";
    }
  `;
}
