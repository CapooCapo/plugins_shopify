import type { RestockRecommendation } from "./restock.types";

function csvField(value: unknown) {
  let text = String(value ?? "");
  const firstNonWhitespace = text.trimStart()[0] ?? "";
  const startsWithControl = text.startsWith("\t") || text.startsWith("\r") || text.startsWith("\n");
  if (typeof value === "string" && (startsWithControl || "=+-@".includes(firstNonWhitespace))) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildRestockCsv(rows: RestockRecommendation[], manualValues: Record<string, string>) {
  const lines: unknown[][] = [["Product", "Variant", "SKU", "Units sold", "Average daily units", "Available", "Coverage days", "Suggested quantity", "Export quantity", "Quantity source", "Priority", "Explanation"]];
  for (const row of rows) {
    if (row.status === "excluded") continue;
    const raw = manualValues[row.variantId] ?? "";
    const validManual = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
    const quantity = validManual ?? row.suggestedQuantity;
    const source = validManual !== null ? "Merchant-entered" : row.suggestedQuantity !== null ? "System-calculated" : "Not calculated";
    lines.push([row.productTitle, row.variantTitle, row.sku, row.unitsSold, row.averageDailyUnits, row.available, row.coverageDays, row.suggestedQuantity, quantity, source, row.priority, row.explanation]);
  }
  return lines.map((line) => line.map(csvField).join(",")).join("\r\n");
}
