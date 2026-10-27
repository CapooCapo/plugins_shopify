import { normalizeCatalogGroupingValue, validateCatalogVariantOptions, type CatalogGroupingLine, type GroupingIssue } from "./catalog-grouping.shared";

export const SHOPIFY_MAX_PRODUCT_VARIANTS = 2048;
export const SHOPIFY_MAX_PRODUCT_OPTIONS = 3;
export type CatalogQualityState = "READY" | "WARNING" | "ERROR";
export type CatalogQualitySeverity = "WARNING" | "ERROR";

export type CatalogQualityIssue = {
  code: string;
  severity: CatalogQualitySeverity;
  field: string | null;
  rowId: string | null;
  rowNumber: number | null;
  groupId: string | null;
  message: string;
  suggestion: string;
};

export type CatalogQualityRow = CatalogGroupingLine & {
  price?: unknown;
  priceZeroConfirmed?: boolean;
  groupId?: string | null;
};
export type CatalogQualityGroup = {
  id: string;
  lines: CatalogQualityRow[];
  issues?: GroupingIssue[];
  selections?: unknown;
  confirmedAt?: Date | string | null;
  /** Future/custom option dimensions; current catalog contract exposes Size and Color. */
  optionDimensions?: readonly string[];
};

export type CatalogQualityOptions = { warnMissingImage?: boolean };
export type CatalogQualityResult = {
  rows: Array<{ id: string; state: CatalogQualityState; issues: CatalogQualityIssue[] }>;
  groups: Array<{ id: string; state: CatalogQualityState; issues: CatalogQualityIssue[]; lineCount: number }>;
  counts: { ready: number; warning: number; error: number; totalRows: number; totalGroups: number; totalIssues: number };
  issues: CatalogQualityIssue[];
};

function priceText(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}
function decimalIsValid(value: string) {
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(value)) return false;
  return true;
}
function isZero(value: string) { return /^0(?:\.0{1,6})?$/.test(value); }
function stateFor(issues: CatalogQualityIssue[]): CatalogQualityState {
  if (issues.some((issue) => issue.severity === "ERROR")) return "ERROR";
  if (issues.length) return "WARNING";
  return "READY";
}

/**
 * Derive catalog quality without mutating draft data. Price confirmation and
 * group confirmation remain distinct from quality; accepted groups can still
 * have quality warnings/errors and must be rechecked when read.
 */
export function evaluateCatalogQuality(
  inputRows: readonly CatalogQualityRow[],
  inputGroups: readonly CatalogQualityGroup[] = [],
  options: CatalogQualityOptions = {},
): CatalogQualityResult {
  const rows = [...inputRows].sort((a, b) => (a.sourceRowNumber ?? Number.MAX_SAFE_INTEGER) - (b.sourceRowNumber ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  const issues: CatalogQualityIssue[] = [];
  const rowIssues = new Map<string, CatalogQualityIssue[]>();
  const groupIssues = new Map<string, CatalogQualityIssue[]>();
  const add = (issue: CatalogQualityIssue) => {
    issues.push(issue);
    if (issue.rowId) (rowIssues.get(issue.rowId) ?? (rowIssues.set(issue.rowId, []), rowIssues.get(issue.rowId)!)).push(issue);
    if (issue.groupId) (groupIssues.get(issue.groupId) ?? (groupIssues.set(issue.groupId, []), groupIssues.get(issue.groupId)!)).push(issue);
  };
  const rowIssue = (row: CatalogQualityRow, code: string, severity: CatalogQualitySeverity, field: string, message: string, suggestion: string, groupId: string | null = null) => add({ code, severity, field, rowId: row.id, rowNumber: row.sourceRowNumber ?? null, groupId, message, suggestion });

  for (const row of rows) {
    const sourceErrors = Array.isArray(row.errors) ? row.errors.filter((item): item is string => typeof item === "string") : [];
    const sourcePriceError = sourceErrors.find((error) => /price must be a non-negative decimal/i.test(error));
    if (!String(row.productName ?? "").trim()) rowIssue(row, "MISSING_PRODUCT_NAME", "ERROR", "productName", "Product Name is required.", "Add a clear product title.");
    if (!String(row.sku ?? "").trim()) rowIssue(row, "MISSING_SKU", "ERROR", "sku", "SKU is required.", "Enter a unique SKU for this variant.");
    const price = priceText(row.price);
    if (sourcePriceError) rowIssue(row, "INVALID_PRICE", "ERROR", "price", sourcePriceError, "Correct the invalid source price; a missing price is not treated as zero.");
    else if (!price) rowIssue(row, "MISSING_PRICE", "WARNING", "price", "Price is missing; a future product creation will require a valid price.", "Add a price before creating this product. Updates may preserve the existing Shopify price.");
    else if (!decimalIsValid(price)) rowIssue(row, "INVALID_PRICE", "ERROR", "price", "Price must be a non-negative decimal with up to 14 integer digits and 6 fractional digits.", "Enter a valid non-negative decimal price.");
    else if (isZero(price) && !row.priceZeroConfirmed) rowIssue(row, "ZERO_PRICE_UNCONFIRMED", "WARNING", "price", "Zero price has not been confirmed as intentional.", "Confirm zero is intentional, or enter the correct price.");
    if (options.warnMissingImage && !String(row.imageUrl ?? "").trim()) rowIssue(row, "MISSING_IMAGE", "WARNING", "imageUrl", "No product image URL is provided.", "Add a valid image URL if this product should have an image.");
    for (const error of sourceErrors) {
      if (/product name is required/i.test(error) || /sku is required/i.test(error) || /price must be a non-negative decimal/i.test(error) || /confirm that zero price is intentional/i.test(error)) continue;
      rowIssue(row, "SOURCE_ROW_ERROR", "ERROR", "sourceValues", error, "Correct the malformed source row or remove it from this draft.", row.groupId ?? null);
    }
  }

  const bySku = new Map<string, CatalogQualityRow[]>();
  for (const row of rows) {
    const key = normalizeCatalogGroupingValue(String(row.sku ?? ""));
    if (key) bySku.set(key, [...(bySku.get(key) ?? []), row]);
  }
  for (const duplicates of bySku.values()) if (duplicates.length > 1) {
    for (const row of duplicates) rowIssue(row, "DUPLICATE_SKU", "ERROR", "sku", "This SKU appears more than once in the draft.", "Give each variant a unique SKU or remove the unintended duplicate.", typeof row.groupId === "string" ? row.groupId : null);
  }

  const activeGroups = [...inputGroups].sort((a, b) => a.id.localeCompare(b.id));
  const memberGroupByRow = new Map<string, string>();
  for (const group of activeGroups) for (const line of group.lines) memberGroupByRow.set(line.id, group.id);
  for (const row of rows) {
    const groupId = row.groupId ?? memberGroupByRow.get(row.id);
    if (!groupId) continue;
    for (const issue of rowIssues.get(row.id) ?? []) if (!issue.groupId) issue.groupId = groupId;
  }

  for (const group of activeGroups) {
    const groupLines = group.lines;
    const known = new Set<string>();
    const structural: GroupingIssue[] = [];
    for (const issue of [...(group.issues ?? []), ...validateCatalogVariantOptions(groupLines)]) {
      const signature = `${issue.code}:${issue.field ?? ""}:${issue.lineIds.slice().sort().join(",")}`;
      if (!known.has(signature)) { known.add(signature); structural.push(issue); }
    }
    for (const source of structural) {
      // Batch-wide SKU and row-data issues are represented once per affected
      // row below; copying them again from legacy group validation would inflate
      // issue totals and duplicate correction guidance.
      if (["DUPLICATE_SKU", "MISSING_SKU", "MISSING_PRODUCT_NAME", "SOURCE_ROW_ERROR"].includes(source.code)) continue;
      // Validation severity is structural; map stable domain codes to actionable copy.
      const matching = groupLines.filter((row) => source.lineIds.includes(row.id));
      const severity: CatalogQualitySeverity = "ERROR";
      const message = source.message;
      const suggestion = source.code === "PRODUCT_FIELD_CONFLICT" ? "Select the intended product-level value from a source row." :
        source.code === "DUPLICATE_SKU" ? "Assign a unique SKU to each variant." :
        source.code === "DUPLICATE_OPTION_COMBINATION" ? "Change Size/Color so each variant combination is unique." :
        source.code === "MISSING_OPTION_VALUE" ? "Provide consistent option values, or split unrelated rows into separate products." :
        source.code === "MISSING_SKU" ? "Enter a unique SKU for this row." :
        source.code === "MISSING_PRODUCT_NAME" ? "Add a product title." :
        source.code === "GROUPING_KEY_CONFLICT" ? "Split this group or review its membership." : "Review and correct the source row.";
      add({ code: source.code, severity, field: source.field ?? null, rowId: matching.length === 1 ? matching[0]!.id : null, rowNumber: matching.length === 1 ? matching[0]!.sourceRowNumber ?? null : null, groupId: group.id, message, suggestion });
    }
    if (groupLines.length > SHOPIFY_MAX_PRODUCT_VARIANTS) {
      add({ code: "VARIANT_LIMIT_EXCEEDED", severity: "ERROR", field: null, rowId: null, rowNumber: null, groupId: group.id, message: `This proposed product has ${groupLines.length} variants; Shopify supports up to ${SHOPIFY_MAX_PRODUCT_VARIANTS}.`, suggestion: "Split this proposal into smaller products." });
    }
    if ((group.optionDimensions?.length ?? 0) > SHOPIFY_MAX_PRODUCT_OPTIONS) {
      add({ code: "OPTION_LIMIT_EXCEEDED", severity: "ERROR", field: null, rowId: null, rowNumber: null, groupId: group.id, message: `This proposal uses more than Shopify's ${SHOPIFY_MAX_PRODUCT_OPTIONS}-option limit.`, suggestion: "Reduce the product to at most three option dimensions." });
    }
  }

  const rowResults = rows.map((row) => ({ id: row.id, state: stateFor(rowIssues.get(row.id) ?? []), issues: rowIssues.get(row.id) ?? [] }));
  // Group summaries inherit member-row quality without adding duplicate issues
  // to the global issue list. This keeps group readiness from masking a bad row.
  for (const row of rows) {
    if (!row.groupId) continue;
    for (const issue of rowIssues.get(row.id) ?? []) {
      if (issue.groupId !== row.groupId) continue;
      const target = groupIssues.get(row.groupId) ?? [];
      if (!target.includes(issue)) target.push(issue);
      groupIssues.set(row.groupId, target);
    }
  }
  const groupResults = activeGroups.map((group) => ({ id: group.id, state: stateFor(groupIssues.get(group.id) ?? []), issues: groupIssues.get(group.id) ?? [], lineCount: group.lines.length }));
  const counts = { ready: 0, warning: 0, error: 0, totalRows: rowResults.length, totalGroups: groupResults.length, totalIssues: issues.length };
  for (const row of rowResults) counts[row.state.toLowerCase() as keyof typeof counts]++;
  return { rows: rowResults, groups: groupResults, counts, issues };
}
