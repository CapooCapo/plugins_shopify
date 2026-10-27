/** Deterministic, non-persistent grouping proposals for catalog import drafts. */

export type CatalogGroupingLine = {
  id: string;
  shop: string;
  batchId: string;
  productName?: string | null;
  sku?: string | null;
  productGroupCode?: string | null;
  size?: string | null;
  color?: string | null;
  vendor?: string | null;
  productType?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  status?: string;
  errors?: unknown;
  sourceRowNumber?: number | null;
  sourceValues?: unknown;
  [field: string]: unknown;
};

export type GroupingIssue = {
  code:
    | "DUPLICATE_SKU"
    | "DUPLICATE_OPTION_COMBINATION"
    | "MISSING_OPTION_VALUE"
    | "PRODUCT_FIELD_CONFLICT"
    | "GROUPING_KEY_CONFLICT"
    | "SOURCE_ROW_ERROR"
    | "MISSING_PRODUCT_NAME"
    | "MISSING_SKU";
  message: string;
  lineIds: string[];
  field?: string;
};

export type CatalogProductGroupProposal = {
  id: string;
  shop: string;
  batchId: string;
  source: "productGroupCode" | "productName";
  normalizedValue: string;
  reason: string;
  confirmed: false;
  lines: CatalogGroupingLine[];
  issues: GroupingIssue[];
  lineIssues: Record<string, GroupingIssue[]>;
  optionMode: "single" | "size" | "color" | "sizeColor";
  valid: boolean;
};

/** NFKC, trim, collapse whitespace, lowercase. Accents and punctuation are preserved. */
export function normalizeCatalogGroupingValue(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

const PRODUCT_FIELDS = ["productName", "vendor", "productType", "description", "imageUrl"] as const;

function lineOrder(a: CatalogGroupingLine, b: CatalogGroupingLine) {
  const rowA = a.sourceRowNumber ?? Number.MAX_SAFE_INTEGER;
  const rowB = b.sourceRowNumber ?? Number.MAX_SAFE_INTEGER;
  return rowA - rowB || a.id.localeCompare(b.id);
}

function valueOf(line: CatalogGroupingLine, field: string) {
  const value = line[field];
  return typeof value === "string" ? value.trim() : "";
}

function addIssue(
  issues: GroupingIssue[],
  lineIssues: Record<string, GroupingIssue[]>,
  issue: GroupingIssue,
) {
  issues.push(issue);
  for (const id of issue.lineIds) (lineIssues[id] ??= []).push(issue);
}

function groupKey(line: CatalogGroupingLine) {
  const code = normalizeCatalogGroupingValue(line.productGroupCode);
  if (code) return { source: "productGroupCode" as const, value: code };
  return { source: "productName" as const, value: normalizeCatalogGroupingValue(line.productName) };
}

function optionModeFor(lines: CatalogGroupingLine[]): CatalogProductGroupProposal["optionMode"] {
  if (lines.length < 2) return "single";
  const hasSize = lines.some((line) => Boolean(normalizeCatalogGroupingValue(line.size)));
  const hasColor = lines.some((line) => Boolean(normalizeCatalogGroupingValue(line.color)));
  if (hasSize && hasColor) return "sizeColor";
  if (hasSize) return "size";
  if (hasColor) return "color";
  return "single";
}

/** Validate option completeness and unique option combinations for one merchant-reviewed group. */
export function validateCatalogVariantOptions(lines: readonly CatalogGroupingLine[]): GroupingIssue[] {
  if (lines.length < 2) return [];
  const usesSize = lines.some((line) => Boolean(normalizeCatalogGroupingValue(line.size)));
  const usesColor = lines.some((line) => Boolean(normalizeCatalogGroupingValue(line.color)));
  if (!usesSize && !usesColor) {
    return [{ code: "MISSING_OPTION_VALUE", message: "Multiple rows need Size and/or Color values to form distinct variants.", lineIds: lines.map((line) => line.id), field: "size" }];
  }
  const issues: GroupingIssue[] = [];
  const combos = new Map<string, CatalogGroupingLine[]>();
  for (const line of lines) {
    const size = normalizeCatalogGroupingValue(line.size);
    const color = normalizeCatalogGroupingValue(line.color);
    if ((usesSize && !size) || (usesColor && !color)) {
      const missing = [usesSize && !size ? "Size" : "", usesColor && !color ? "Color" : ""].filter(Boolean).join(" and ");
      issues.push({ code: "MISSING_OPTION_VALUE", message: `${missing} is required consistently for every variant in this group.`, lineIds: [line.id], field: usesSize && !size ? "size" : "color" });
      continue;
    }
    const combination = JSON.stringify([usesSize ? size : "", usesColor ? color : ""]);
    combos.set(combination, [...(combos.get(combination) ?? []), line]);
  }
  for (const duplicateRows of combos.values()) if (duplicateRows.length > 1) {
    issues.push({ code: "DUPLICATE_OPTION_COMBINATION", message: "Two or more rows have the same variant option combination.", lineIds: duplicateRows.map((line) => line.id), field: usesSize && usesColor ? "size/color" : usesSize ? "size" : "color" });
  }
  return issues;
}

/**
 * Propose groups within each (shop, batch) only. This function never confirms a
 * group and never infers grouping codes/options from SKU values.
 */
export function proposeCatalogProductGroups(input: readonly CatalogGroupingLine[]): CatalogProductGroupProposal[] {
  const scopes = new Map<string, CatalogGroupingLine[]>();
  for (const original of input) {
    const line = { ...original };
    const scope = JSON.stringify([line.shop, line.batchId]);
    const bucket = scopes.get(scope) ?? [];
    bucket.push(line);
    scopes.set(scope, bucket);
  }

  const proposals: CatalogProductGroupProposal[] = [];
  for (const [scope, scopeLines] of scopes) {
    const sortedScopeLines = [...scopeLines].sort(lineOrder);
    const skuRows = new Map<string, CatalogGroupingLine[]>();
    for (const line of sortedScopeLines) {
      const sku = normalizeCatalogGroupingValue(line.sku);
      if (sku) skuRows.set(sku, [...(skuRows.get(sku) ?? []), line]);
    }

    const grouped = new Map<string, { source: "productGroupCode" | "productName"; value: string; missingName: boolean; lines: CatalogGroupingLine[] }>();
    for (const line of sortedScopeLines) {
      const { source, value } = groupKey(line);
      // Keep missing-name rows isolated with a separate marker; no user value
      // can collide with the marker because it is not encoded into `value`.
      const missingName = source === "productName" && !value;
      const key = `${source}:${JSON.stringify([value, missingName ? line.id : null])}`;
      const entry = grouped.get(key) ?? { source, value, missingName, lines: [] };
      entry.lines.push(line);
      grouped.set(key, entry);
    }

    for (const [key, entry] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const lines = [...entry.lines].sort(lineOrder);
      const issues: GroupingIssue[] = [];
      const lineIssues: Record<string, GroupingIssue[]> = {};
      if (entry.missingName) {
        const line = lines[0]!;
        addIssue(issues, lineIssues, { code: "MISSING_PRODUCT_NAME", message: "Product Name is required before a grouping suggestion can be made.", lineIds: [line.id], field: "productName" });
      }
      for (const line of lines) {
        if (!normalizeCatalogGroupingValue(line.sku)) {
          addIssue(issues, lineIssues, { code: "MISSING_SKU", message: "SKU is required for each variant.", lineIds: [line.id], field: "sku" });
        }
      }
      for (const duplicateRows of skuRows.values()) {
        const inGroup = duplicateRows.filter((line) => lines.some((member) => member.id === line.id));
        if (duplicateRows.length > 1 && inGroup.length) {
          addIssue(issues, lineIssues, { code: "DUPLICATE_SKU", message: `SKU “${valueOf(duplicateRows[0]!, "sku") }” appears more than once in this batch.`, lineIds: duplicateRows.map((line) => line.id), field: "sku" });
        }
      }

      for (const field of PRODUCT_FIELDS) {
        const values = new Map<string, CatalogGroupingLine[]>();
        for (const line of lines) {
          const display = valueOf(line, field);
          const normalized = normalizeCatalogGroupingValue(display);
          if (normalized) values.set(normalized, [...(values.get(normalized) ?? []), line]);
        }
        if (values.size > 1) {
          addIssue(issues, lineIssues, {
            code: "PRODUCT_FIELD_CONFLICT",
            message: `Rows in this suggested group disagree on ${field}; choose the product-level value before confirming.`,
            lineIds: lines.filter((line) => Boolean(valueOf(line, field))).map((line) => line.id),
            field,
          });
        }
      }

      const optionMode = optionModeFor(lines);
      if (lines.length > 1) {
        if (optionMode === "single") {
          addIssue(issues, lineIssues, { code: "MISSING_OPTION_VALUE", message: "Multiple rows need Size and/or Color values to form distinct variants.", lineIds: lines.map((line) => line.id), field: "size" });
        } else {
          const usesSize = optionMode === "size" || optionMode === "sizeColor";
          const usesColor = optionMode === "color" || optionMode === "sizeColor";
          for (const line of lines) {
            if ((usesSize && !normalizeCatalogGroupingValue(line.size)) || (usesColor && !normalizeCatalogGroupingValue(line.color))) {
              const missing = [usesSize && !normalizeCatalogGroupingValue(line.size) ? "Size" : "", usesColor && !normalizeCatalogGroupingValue(line.color) ? "Color" : ""].filter(Boolean).join(" and ");
              addIssue(issues, lineIssues, { code: "MISSING_OPTION_VALUE", message: `${missing} is required consistently for every variant in this group.`, lineIds: [line.id], field: usesSize && !normalizeCatalogGroupingValue(line.size) ? "size" : "color" });
            }
          }
          const combos = new Map<string, CatalogGroupingLine[]>();
          for (const line of lines) {
            const size = usesSize ? normalizeCatalogGroupingValue(line.size) : "";
            const color = usesColor ? normalizeCatalogGroupingValue(line.color) : "";
            if ((usesSize && !size) || (usesColor && !color)) continue;
            const combo = JSON.stringify([size, color]);
            combos.set(combo, [...(combos.get(combo) ?? []), line]);
          }
          for (const duplicateRows of combos.values()) if (duplicateRows.length > 1) {
            addIssue(issues, lineIssues, { code: "DUPLICATE_OPTION_COMBINATION", message: "Two or more rows have the same variant option combination.", lineIds: duplicateRows.map((line) => line.id), field: usesSize && usesColor ? "size/color" : usesSize ? "size" : "color" });
          }
        }
      }

      const first = lines[0]!;
      proposals.push({
        id: `${scope}:${key}`,
        shop: first.shop,
        batchId: first.batchId,
        source: entry.source,
        normalizedValue: entry.value,
        reason: entry.missingName
          ? "Product Name is missing. Add a name before confirming a product group."
          : entry.source === "productGroupCode"
          ? `Suggested because Product Group Code matches “${valueOf(first, "productGroupCode") }”. Review the rows and explicitly accept this group.`
          : `Suggested because normalized Product Name matches “${valueOf(first, "productName") }”. Review the rows and explicitly accept this group.`,
        confirmed: false,
        lines,
        issues,
        lineIssues,
        optionMode,
        valid: issues.length === 0,
      });
    }
  }
  return proposals.sort((a, b) => a.shop.localeCompare(b.shop) || a.batchId.localeCompare(b.batchId) || a.id.localeCompare(b.id));
}
