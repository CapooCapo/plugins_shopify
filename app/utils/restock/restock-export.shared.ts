import type { RestockRecommendation } from "./restock.types";

type RestockCsvReport = {
  period?: number | null;
  periodStartDate?: string | null;
  periodEndDate?: string | null;
  analysisDays?: number | null;
  timeZone?: string | null;
  settings?: {
    leadTimeDays?: number | null;
    coverageDays?: number | null;
    safetyBufferDays?: number | null;
  };
};

function csvField(value: unknown) {
  let text = String(value ?? "");
  const firstNonWhitespace = text.trimStart()[0] ?? "";
  const startsWithControl = text.startsWith("\t") || text.startsWith("\r") || text.startsWith("\n");
  if (typeof value === "string" && (startsWithControl || "=+-@".includes(firstNonWhitespace))) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function reportValue(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "Unknown / unavailable" : value;
}

export function buildRestockCsv(
  rows: RestockRecommendation[],
  manualValues: Record<string, string>,
  report: RestockCsvReport = {},
) {
  const settings = report.settings ?? {};
  const lines: unknown[][] = [[
    "Product ID", "Variant ID", "Product", "Variant", "SKU", "Units sold", "Average daily units",
    "Available inventory", "Inventory status", "Estimated coverage days", "Target units", "Calculated quantity",
    "Manual planning quantity", "Quantity source", "Status", "Priority", "Reason", "Quality issues",
    "Sales period (days)", "Period start date", "Period end date", "Analysis days", "Time zone",
    "Lead time assumption (days)", "Coverage setting (days)", "Safety buffer assumption (days)",
  ]];
  for (const row of rows) {
    const raw = manualValues[row.variantId] ?? "";
    const validManual = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
    const source = raw && validManual === null ? "Invalid merchant input; not applied"
      : validManual !== null ? "Merchant-entered"
        : row.suggestedQuantity !== null ? "System-calculated" : "Not calculated";
    lines.push([
      row.productId, row.variantId, row.productTitle, row.variantTitle, row.sku, reportValue(row.unitsSold),
      reportValue(row.averageDailyUnits), reportValue(row.available), row.inventoryStatus,
      reportValue(row.coverageDays), reportValue(row.targetUnits),
      row.suggestedQuantity === null ? "Not calculated" : row.suggestedQuantity,
      raw === "" ? "Not set" : raw,
      source, row.status, row.priority, row.explanation, row.qualityIssues.join("; ") || "None",
      reportValue(report.period), reportValue(report.periodStartDate), reportValue(report.periodEndDate),
      reportValue(report.analysisDays), reportValue(report.timeZone), reportValue(settings.leadTimeDays),
      reportValue(settings.coverageDays), reportValue(settings.safetyBufferDays),
    ]);
  }
  return lines.map((line) => line.map(csvField).join(",")).join("\r\n");
}
