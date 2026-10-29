import type { InventoryAggregation, InventoryAggregationOptions, InventoryVariantInput, InventoryVariantSummary, RestockInventoryVariant } from "./overview-analytics.types";

function resourceId(value: string | number | null | undefined) {
  return value == null ? undefined : String(value);
}

/**
 * Inventory available is summed only for known active locations. Missing,
 * untracked, or incomplete levels stay unknown and never become zero stock.
 * Duplicate nonempty SKUs are summed across their variants; if any member is
 * unknown or untracked, that SKU is excluded from low/out-of-stock totals.
 */
export function aggregateInventoryVariants(
  variants: InventoryVariantInput[],
  options: InventoryAggregationOptions & { includeRestockVariants?: boolean; catalogComplete?: boolean } = {},
): InventoryAggregation {
  const threshold = options.lowStockThreshold ?? 5;
  const lowStockVariants: InventoryVariantSummary[] = [];
  const outOfStockVariants: InventoryVariantSummary[] = [];
  let unknownCount = 0;
  let untrackedCount = 0;
  let nonPhysicalCount = 0;
  let totalTrackedKnown = 0;
  const skuAvailability = new Map<string, { available: number; unknown: boolean }>();
  const knownVariantsBySku = new Map<string, InventoryVariantSummary[]>();
  const restockVariants: RestockInventoryVariant[] = [];

  for (const variant of variants) {
    const identity = {
      id: variant.id,
      title: variant.title,
      sku: variant.sku ?? null,
      createdAt: variant.createdAt ?? null,
      product: {
        id: variant.product.id,
        title: variant.product.title,
        ...(resourceId(variant.product.legacyResourceId) ? { legacyResourceId: resourceId(variant.product.legacyResourceId) } : {}),
        ...(variant.product.imageUrl ? { imageUrl: variant.product.imageUrl } : {}),
      },
    };
    if (variant.product.giftCard === true) {
      nonPhysicalCount += 1;
      if (options.includeRestockVariants) restockVariants.push({ ...identity, inventoryStatus: "non_physical", available: null });
      continue;
    }
    const sku = variant.sku?.trim();
    if (variant.tracked === false) {
      untrackedCount += 1;
      if (options.includeRestockVariants) restockVariants.push({ ...identity, inventoryStatus: "untracked", available: null });
      if (sku) {
        const current = skuAvailability.get(sku) ?? { available: 0, unknown: false };
        current.unknown = true;
        skuAvailability.set(sku, current);
      }
      continue;
    }
    if (variant.tracked !== true || variant.levelsComplete === false) {
      unknownCount += 1;
      if (options.includeRestockVariants) restockVariants.push({ ...identity, inventoryStatus: "unknown", available: null });
      if (sku) {
        const current = skuAvailability.get(sku) ?? { available: 0, unknown: false };
        current.unknown = true;
        skuAvailability.set(sku, current);
      }
      continue;
    }
    const activeLevels = variant.levels.filter((level) => level.isActive);
    if (!activeLevels.length || activeLevels.some((level) => !Number.isFinite(level.available))) {
      unknownCount += 1;
      if (options.includeRestockVariants) restockVariants.push({ ...identity, inventoryStatus: "unknown", available: null });
      if (sku) {
        const current = skuAvailability.get(sku) ?? { available: 0, unknown: false };
        current.unknown = true;
        skuAvailability.set(sku, current);
      }
      continue;
    }
    const available = activeLevels.reduce((total, level) => total + (level.available as number), 0);
    if (options.includeRestockVariants) restockVariants.push({ ...identity, inventoryStatus: "known", available });
    totalTrackedKnown += available;
    if (sku) {
      const current = skuAvailability.get(sku) ?? { available: 0, unknown: false };
      current.available += available;
      skuAvailability.set(sku, current);
    }
    const summary: InventoryVariantSummary = {
      id: variant.id,
      title: variant.title,
      sku: variant.sku ?? null,
      product: {
        id: variant.product.id,
        title: variant.product.title,
        ...(resourceId(variant.product.legacyResourceId) ? { legacyResourceId: resourceId(variant.product.legacyResourceId) } : {}),
        ...(variant.product.imageUrl ? { imageUrl: variant.product.imageUrl } : {}),
      },
      available,
    };
    if (sku) {
      knownVariantsBySku.set(sku, [...(knownVariantsBySku.get(sku) ?? []), summary]);
    } else if (available <= 0) {
      outOfStockVariants.push(summary);
    } else if (available <= threshold) {
      lowStockVariants.push(summary);
    }
  }

  for (const [sku, availability] of skuAvailability) {
    if (availability.unknown) continue;
    const members = knownVariantsBySku.get(sku) ?? [];
    const first = members[0];
    if (!first) continue;
    const summary: InventoryVariantSummary = {
      ...first,
      available: availability.available,
      ...(members.length > 1 ? { variantCount: members.length } : {}),
    };
    if (availability.available <= 0) outOfStockVariants.push(summary);
    else if (availability.available <= threshold) lowStockVariants.push(summary);
  }

  const sortVariants = (left: InventoryVariantSummary, right: InventoryVariantSummary) =>
    left.available - right.available || left.product.title.localeCompare(right.product.title) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  lowStockVariants.sort(sortVariants);
  outOfStockVariants.sort(sortVariants);
  const partial = options.partial === true || unknownCount > 0 || untrackedCount > 0;
  const knownSkuGroups = [...skuAvailability.values()].filter((sku) => !sku.unknown);

  return {
    status: partial ? "partial" : "ready",
    ...(partial ? { reason: "Some inventory is unknown, untracked, or could not be fully read; totals include only variants with complete active-location availability." } : {}),
    threshold,
    lowStockSkuCount: knownSkuGroups.filter((sku) => sku.available > 0 && sku.available <= threshold).length,
    outOfStockSkuCount: knownSkuGroups.filter((sku) => sku.available <= 0).length,
    lowStockVariants,
    outOfStockVariants,
    unknownCount,
    untrackedCount,
    nonPhysicalCount,
    totalTrackedKnown,
    ...(options.includeRestockVariants ? { restockVariants } : {}),
    ...(options.catalogComplete === false ? { catalogComplete: false } : {}),
  };
}
