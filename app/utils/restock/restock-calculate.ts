import type { PlanningSettings, RestockRecommendation, RestockRowInput } from "./restock.types";
import { validatePlanningSettings } from "./restock-settings";

type CalculationContext = {
  periodStartUtc: string | null;
  timeZone: string | null;
  analysisDays: number;
  settings: PlanningSettings;
  salesComplete: boolean;
};

function sortPriority(left: RestockRecommendation, right: RestockRecommendation) {
  const order = { urgent: 0, high: 1, normal: 2, review: 3, excluded: 4 } as const;
  return order[left.priority] - order[right.priority]
    || (right.unitsSold ?? -1) - (left.unitsSold ?? -1)
    || left.productTitle.localeCompare(right.productTitle)
    || left.variantTitle.localeCompare(right.variantTitle)
    || left.variantId.localeCompare(right.variantId);
}

export function calculateRestockRecommendations(
  rows: RestockRowInput[],
  context: CalculationContext,
): RestockRecommendation[] {
  const settingsResult = validatePlanningSettings(context.settings);
  return rows.map((row): RestockRecommendation => {
    const qualityIssues: string[] = [];
    const settingsIssue = settingsResult.valid ? null : settingsResult.message;
    const unitsSold = row.unitsSold;
    const averageDailyUnits = unitsSold !== null && context.analysisDays > 0
      ? unitsSold / context.analysisDays : null;
    const coverageDays = row.available !== null && averageDailyUnits !== null && averageDailyUnits > 0
      ? row.available / averageDailyUnits : null;

    if (row.inventoryStatus === "non_physical") {
      return {
        ...row, averageDailyUnits, coverageDays, targetUnits: null, suggestedQuantity: null,
        status: "excluded", priority: "excluded", qualityIssues: ["Non-physical Gift Card; replenishment is not applicable."],
        explanation: "Gift Cards are excluded from physical restock recommendations.",
      };
    }
    if (row.inventoryStatus === "untracked") {
      qualityIssues.push("Inventory is untracked; it is not treated as zero.");
    } else if (row.inventoryStatus === "unknown" || row.available === null) {
      qualityIssues.push("Available inventory is unknown or incomplete across active locations.");
    }
    if (!context.salesComplete) qualityIssues.push("Sales pages are incomplete; observed units are not a reliable demand total.");
    if (unitsSold === null) qualityIssues.push("Sales data is unavailable for this variant.");
    if (unitsSold !== null && unitsSold < 0) qualityIssues.push("Net units sold is invalid and was withheld.");
    if (row.createdAt && context.periodStartUtc && context.timeZone) {
      try {
        const createdAtMs = new Date(row.createdAt).getTime();
        if (!Number.isFinite(createdAtMs)) {
          qualityIssues.push("Variant creation date could not be validated; sales history is insufficient.");
        } else if (createdAtMs > new Date(context.periodStartUtc).getTime()) {
          qualityIssues.push("Variant was created during the selected period; sales history is insufficient for a full-period rate.");
        }
      } catch {
        qualityIssues.push("Variant creation date could not be validated; sales history is insufficient.");
      }
    } else {
      qualityIssues.push("Variant age is unavailable; sufficient sales history cannot be confirmed.");
    }
    if (row.available !== null && row.available <= 0 && (unitsSold ?? 0) > 0) {
      qualityIssues.push("Possible stockout bias: current available stock is zero or below despite sales in this period.");
    }
    if (row.available !== null && row.available < 0) {
      qualityIssues.push("Available inventory is negative; the calculation uses the reported negative quantity explicitly.");
    }
    if (settingsIssue) qualityIssues.push(settingsIssue);

    const mustWithhold = row.inventoryStatus !== "known"
      || row.available === null
      || !context.salesComplete
      || unitsSold === null
      || unitsSold < 0
      || !row.createdAt
      || !context.periodStartUtc
      || !context.timeZone
      || qualityIssues.some((issue) => issue.includes("insufficient") || issue.includes("stockout bias"))
      || !settingsResult.valid;
    if (mustWithhold) {
      const excludedFromSummary = row.inventoryStatus === "untracked";
      const hasDataQualityIssue = qualityIssues.some((issue) => issue !== settingsIssue);
      return {
        ...row, averageDailyUnits, coverageDays, targetUnits: null, suggestedQuantity: null,
        status: excludedFromSummary || hasDataQualityIssue ? "needs_review" : "settings_required",
        priority: excludedFromSummary ? "review" : "review", qualityIssues,
        explanation: qualityIssues.join(" "),
      };
    }

    const settings = settingsResult.settings;
    const targetUnits = Math.ceil((averageDailyUnits ?? 0)
      * (settings.leadTimeDays + settings.coverageDays + settings.safetyBufferDays));
    const suggestedQuantity = Math.max(0, targetUnits - row.available!);
    const priority = suggestedQuantity > 0 && row.available! <= settings.leadTimeDays * (averageDailyUnits ?? 0)
      ? "urgent" : suggestedQuantity > 0 ? "high" : "normal";
    const incomingNote = "No incoming stock is deducted because the existing app has no complete, confirmed incoming-inventory source.";
    const negativeNote = row.available! < 0 ? " Reported negative availability is included in the subtraction." : "";
    return {
      ...row, averageDailyUnits, coverageDays, targetUnits, suggestedQuantity,
      status: "calculated", priority, qualityIssues,
      explanation: `ceil((${unitsSold} net units ÷ ${context.analysisDays} complete days) × (${settings.leadTimeDays} lead + ${settings.coverageDays} coverage + ${settings.safetyBufferDays} safety buffer)) = ${targetUnits} target units; max(0, ${targetUnits} − ${row.available} available) = ${suggestedQuantity} suggested.${negativeNote} ${incomingNote}`,
    };
  }).sort(sortPriority);
}

export function summarizeRestock(recommendations: RestockRecommendation[]) {
  const reliable = recommendations.filter((row) => row.status === "calculated");
  return {
    recommendedVariants: reliable.filter((row) => (row.suggestedQuantity ?? 0) > 0).length,
    suggestedUnits: reliable.reduce((total, row) => total + (row.suggestedQuantity ?? 0), 0),
    urgentVariants: reliable.filter((row) => row.priority === "urgent" && (row.suggestedQuantity ?? 0) > 0).length,
    manualReviewVariants: recommendations.filter((row) => row.status === "needs_review").length,
  };
}
