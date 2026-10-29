import { aggregateInventoryVariants, type InventoryVariantInput, type InventoryAggregation } from "./overview-analytics.shared";
import { appendPartialReasons, connection, queryData, OverviewAnalyticsReadError, record, INVENTORY_VARIANTS_QUERY, INVENTORY_LEVELS_QUERY, type AdminGraphQL } from "./overview-analytics-graphql.server";

const CONTINUATION_PAGE_SIZE = 100;
const VARIANTS_PER_PAGE = 20;
const INVENTORY_LEVELS_PER_PAGE = 10;
const MAX_VARIANT_PAGES = 50;
const MAX_INVENTORY_LEVEL_PAGES = 25;
const MAX_VARIANTS = VARIANTS_PER_PAGE * MAX_VARIANT_PAGES;
const MAX_INVENTORY_LEVELS_PER_VARIANT = INVENTORY_LEVELS_PER_PAGE + (MAX_INVENTORY_LEVEL_PAGES - 1) * CONTINUATION_PAGE_SIZE;
type PageReadResult<T> = { values: T[]; complete: boolean; reason?: string };

function parseInventoryLevel(value: unknown) {
  if (!record(value)) return null;
  const location = record(value.location) ? value.location : null;
  if (typeof value.isActive !== "boolean" || typeof location?.isActive !== "boolean" || !Array.isArray(value.quantities)) return null;
  const available = Array.isArray(value.quantities)
    ? value.quantities.find((quantity) => record(quantity) && quantity.name === "available")
    : null;
  return {
    isActive: value.isActive === true && location?.isActive === true,
    available: record(available) && typeof available.quantity === "number" && Number.isFinite(available.quantity)
      ? available.quantity : null,
  };
}

async function readAllInventoryLevels(
  admin: AdminGraphQL,
  inventoryItem: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<PageReadResult<{ isActive: boolean; available: number | null }>> {
  const first = connection<unknown>(inventoryItem.inventoryLevels);
  if (!first) return { values: [], complete: false, reason: "Inventory-level data did not include valid pagination information." };
  const firstLevels = first.nodes.map(parseInventoryLevel);
  const levels = firstLevels.filter((level): level is NonNullable<typeof level> => level !== null);
  let complete = firstLevels.every((level) => level !== null);
  const reasons: string[] = [];
  if (!complete) reasons.push("Some inventory-level rows were incomplete and were excluded from stock totals.");
  let hasNext = first.hasNextPage;
  let cursor = first.endCursor;
  let pages = 1;
  const itemId = typeof inventoryItem.id === "string" ? inventoryItem.id : null;
  while (hasNext && pages < MAX_INVENTORY_LEVEL_PAGES) {
    if (!itemId || !cursor) {
      reasons.push("Inventory locations could not be fully read because Shopify returned no inventory-item ID or end cursor.");
      return { values: levels, complete: false, reason: reasons.join(" ") };
    }
    let data: { inventoryItem?: { inventoryLevels?: unknown } | null };
    try {
      data = await queryData(admin, INVENTORY_LEVELS_QUERY, { id: itemId, first: CONTINUATION_PAGE_SIZE, after: cursor }, signal);
    } catch {
      reasons.push("Some inventory-location pages could not be loaded; affected stock totals remain unknown.");
      return { values: levels, complete: false, reason: reasons.join(" ") };
    }
    const page = connection<unknown>(data.inventoryItem?.inventoryLevels);
    if (!page) {
      reasons.push("Shopify returned incomplete inventory-location pagination data; affected stock totals remain unknown.");
      return { values: levels, complete: false, reason: reasons.join(" ") };
    }
    const parsed = page.nodes.map(parseInventoryLevel);
    levels.push(...parsed.filter((level): level is NonNullable<typeof level> => level !== null));
    if (parsed.some((level) => level === null)) {
      complete = false;
      reasons.push("Some inventory-level rows were incomplete and were excluded from stock totals.");
    }
    if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) {
      complete = false;
      reasons.push("Shopify did not advance an inventory-location cursor; remaining locations were not read.");
      return { values: levels, complete, reason: [...new Set(reasons)].join(" ") };
    }
    hasNext = page.hasNextPage;
    cursor = page.endCursor;
    pages += 1;
  }
  if (hasNext && pages >= MAX_INVENTORY_LEVEL_PAGES) {
    complete = false;
    reasons.push(`A variant exceeded the ${MAX_INVENTORY_LEVELS_PER_VARIANT.toLocaleString()} inventory-level safety cap; remaining locations were not read, so its total is unknown.`);
  }
  return { values: levels, complete: complete && !hasNext, ...(reasons.length ? { reason: [...new Set(reasons)].join(" ") } : {}) };
}

export async function readInventoryVariants(admin: AdminGraphQL, signal?: AbortSignal): Promise<InventoryAggregation> {
  const variants: InventoryVariantInput[] = [];
  let cursor: string | null = null;
  let hasNext = true;
  let pages = 0;
  let partial = false;
  const partialReasons: string[] = [];
  const seen = new Set<string>();

  while (hasNext && pages < MAX_VARIANT_PAGES) {
    let data: { productVariants?: unknown };
    try {
      data = await queryData(admin, INVENTORY_VARIANTS_QUERY, {
        first: VARIANTS_PER_PAGE,
        after: cursor,
        levelsFirst: INVENTORY_LEVELS_PER_PAGE,
      }, signal);
    } catch {
      if (pages === 0) throw new OverviewAnalyticsReadError("Shopify inventory data could not be loaded. Try again shortly.");
      partial = true;
      partialReasons.push("Some product-variant pages could not be loaded; inventory totals include only the pages already read.");
      break;
    }
    const page = connection<Record<string, unknown>>(data.productVariants);
    if (!page) {
      if (pages === 0) throw new OverviewAnalyticsReadError("Shopify returned incomplete inventory data.");
      partial = true;
      partialReasons.push("Shopify returned an incomplete product-variant page; inventory totals include only the pages already read.");
      break;
    }
    for (const row of page.nodes) {
      if (typeof row.id !== "string" || seen.has(row.id)) continue;
      seen.add(row.id);
      const product = record(row.product) ? row.product : null;
      if (!product || typeof product.id !== "string" || typeof product.title !== "string") {
        partial = true;
        partialReasons.push("Some variants were missing product identity and were excluded from inventory detail.");
        continue;
      }
      const inventoryItem = record(row.inventoryItem) ? row.inventoryItem : null;
      let levels: Array<{ isActive: boolean; available: number | null }> = [];
      let levelsComplete = false;
      if (inventoryItem) {
        const read = await readAllInventoryLevels(admin, inventoryItem, signal);
        levels = read.values;
        levelsComplete = read.complete;
        if (!read.complete) {
          partial = true;
          if (read.reason) partialReasons.push(read.reason);
        }
      } else {
        partial = true;
        partialReasons.push("Some variants were missing Shopify inventory-item data and remain unknown.");
      }
      variants.push({
        id: row.id,
        title: typeof row.title === "string" ? row.title : "Variant",
        sku: typeof row.sku === "string" ? row.sku : null,
        product: {
          id: product.id,
          title: product.title,
          giftCard: product.isGiftCard === true,
          legacyResourceId: typeof product.legacyResourceId === "string" || typeof product.legacyResourceId === "number"
            ? product.legacyResourceId : null,
          imageUrl: record(product.featuredImage) && typeof product.featuredImage.url === "string" ? product.featuredImage.url : null,
        },
        tracked: inventoryItem && typeof inventoryItem.tracked === "boolean" ? inventoryItem.tracked : null,
        levels,
        levelsComplete,
      });
    }
    if (page.hasNextPage && (!page.endCursor || page.endCursor === cursor)) {
      hasNext = true;
      partial = true;
      partialReasons.push("Shopify did not advance the product-variant cursor; remaining variants were not read.");
      break;
    }
    cursor = page.endCursor;
    hasNext = page.hasNextPage;
    pages += 1;
  }
  if (hasNext) {
    partial = true;
    if (pages >= MAX_VARIANT_PAGES) {
      partialReasons.push(`Only the first ${MAX_VARIANTS.toLocaleString()} product variants were read because the Overview safety cap was reached. Inventory totals are partial; review the full catalog in Shopify Admin.`);
    } else if (!partialReasons.some((reason) => reason.includes("cursor"))) {
      partialReasons.push("Shopify returned no usable next-variant cursor; remaining variants were not read.");
    }
  }
  const aggregation = aggregateInventoryVariants(variants, { lowStockThreshold: 5, partial });
  return appendPartialReasons(aggregation, partialReasons);
}
