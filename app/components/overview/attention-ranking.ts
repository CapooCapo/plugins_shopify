import type { InventoryAggregation, InventoryVariantSummary, SalesAggregation } from "../../utils/overview-analytics.shared";

type AttentionItem = InventoryVariantSummary & { salesUnits: number | null; severity: "out" | "low" };

export function rankInventoryAttention(inventory: InventoryAggregation, sales: SalesAggregation | null, trustSales: boolean) {
  const demand = new Map((trustSales ? sales?.variantDemand ?? [] : []).map((variant) => [variant.id, variant.units]));
  const rows: AttentionItem[] = [
    ...inventory.outOfStockVariants.map((variant) => ({ ...variant, severity: "out" as const })),
    ...inventory.lowStockVariants.map((variant) => ({ ...variant, severity: "low" as const })),
  ].map((variant) => ({ ...variant, salesUnits: trustSales ? (demand.get(variant.id) ?? 0) : null }));
  return rows.sort((left, right) => {
    if (trustSales) {
      const leftKnown = left.salesUnits !== null;
      const rightKnown = right.salesUnits !== null;
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      if (left.salesUnits !== right.salesUnits) return (right.salesUnits ?? 0) - (left.salesUnits ?? 0);
    }
    if (left.severity !== right.severity) return left.severity === "out" ? -1 : 1;
    return left.available - right.available || left.product.title.localeCompare(right.product.title) || left.title.localeCompare(right.title);
  }).slice(0, 3);
}
