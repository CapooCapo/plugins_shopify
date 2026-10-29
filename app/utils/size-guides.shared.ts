export type SizeGuideColumn = { name: string; kind: "label" | "measurement" };
export type SizeGuide = {
  id: string;
  title: string;
  unit: "cm" | "in" | "mm";
  columns: SizeGuideColumn[];
  rows: string[][];
  updatedAt: string;
};
export type SizeGuideDraft = Omit<SizeGuide, "id" | "updatedAt">;
export type SizeGuideValidation =
  | { ok: true; value: SizeGuideDraft }
  | { ok: false; errors: string[] };

const MAX_COLUMNS = 12;
const MAX_ROWS = 100;
const LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,49}$/u;
const MEASUREMENT_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function validateSizeGuideDraft(input: unknown): SizeGuideValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["Guide data is missing."] };
  const value = input as Record<string, unknown>;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!title || title.length > 120) errors.push("Enter a guide title between 1 and 120 characters.");
  const unit = value.unit;
  if (unit !== "cm" && unit !== "in" && unit !== "mm") errors.push("Choose cm, in, or mm as the measurement unit.");

  const columns: SizeGuideColumn[] = [];
  if (!Array.isArray(value.columns) || value.columns.length < 2 || value.columns.length > MAX_COLUMNS) {
    errors.push(`Add between 2 and ${MAX_COLUMNS} columns.`);
  } else {
    for (const column of value.columns) {
      if (!column || typeof column !== "object") {
        errors.push("Every column needs a name and type.");
        continue;
      }
      const record = column as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const kind = record.kind;
      if (!LABEL_PATTERN.test(name)) errors.push("Column names must be 1–50 letters, numbers, spaces, or . _ / - characters.");
      if (kind !== "label" && kind !== "measurement") errors.push("Every column must be a size label or a measurement.");
      if (name && (kind === "label" || kind === "measurement")) columns.push({ name, kind });
    }
    if (columns.filter((column) => column.kind === "label").length !== 1) {
      errors.push("Choose exactly one column for the size label.");
    }
    const names = columns.map((column) => column.name.toLocaleLowerCase());
    if (new Set(names).size !== names.length) errors.push("Column names must be unique.");
  }

  const rows: string[][] = [];
  if (!Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > MAX_ROWS) {
    errors.push(`Add between 1 and ${MAX_ROWS} size rows.`);
  } else {
    const labelIndex = columns.findIndex((column) => column.kind === "label");
    const labels = new Set<string>();
    for (const row of value.rows) {
      if (!Array.isArray(row) || row.length !== columns.length) {
        errors.push("Each row must have one value for every column.");
        continue;
      }
      const normalized = row.map((cell) => typeof cell === "string" ? cell.trim() : "");
      normalized.forEach((cell, index) => {
        if (columns[index]?.kind === "label") {
          if (!cell || cell.length > 50) errors.push("Each size label must be between 1 and 50 characters.");
          const key = cell.toLocaleLowerCase();
          if (cell && labels.has(key)) errors.push("Size labels must be unique.");
          labels.add(key);
        } else {
          const measurement = Number(cell);
          if (!cell || !MEASUREMENT_PATTERN.test(cell) || !Number.isFinite(measurement) || measurement <= 0) {
            errors.push("Measurements must be positive finite numbers.");
          }
        }
      });
      if (labelIndex < 0) errors.push("A size-label column is required.");
      rows.push(normalized);
    }
  }

  if (errors.length || (unit !== "cm" && unit !== "in" && unit !== "mm")) {
    return { ok: false, errors: [...new Set(errors)] };
  }
  return { ok: true, value: { title, unit, columns, rows } };
}

/** The only fields sent to the public storefront metafield. */
export function sizeGuideStorefrontProjection(guide: SizeGuideDraft): SizeGuideDraft {
  return {
    title: guide.title,
    unit: guide.unit,
    columns: guide.columns.map(({ name, kind }) => ({ name, kind })),
    rows: guide.rows.map((row) => [...row]),
  };
}
