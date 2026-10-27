import { createHash } from "node:crypto";
import { MAX_CSV_BYTES, MAX_CSV_ROWS } from "./csv-limits.js";
import { CATALOG_FIELDS, type CatalogField } from "./catalog-import.shared";
export { CATALOG_FIELDS } from "./catalog-import.shared";
export type { CatalogField } from "./catalog-import.shared";
export type CatalogMapping = Record<number, CatalogField | null>;
export type ParsedCatalogCsv = { headers: string[]; rows: Array<{ rowNumber: number; values: string[]; sourceErrors: string[] }> };

export function parseCatalogCsv(text: string): ParsedCatalogCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  // A UTF-8 BOM is an encoding marker, not part of the first CSV cell. Ignore
  // it for parsing so a BOM-prefixed quoted header still starts with `"`.
  // The caller persists and checksums the untouched original text separately.
  const firstCharacter = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let i = firstCharacter; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else cell += char;
    } else if (closedQuote && char !== "," && char !== "\n" && char !== "\r") {
      throw new Error(`Malformed CSV: unexpected character after a quoted field near character ${i + 1}.`);
    } else if (char === '"') {
      if (cell.length) throw new Error(`Malformed CSV quoting near character ${i + 1}.`);
      quoted = true;
    } else if (char === ",") { row.push(cell); cell = ""; closedQuote = false; }
    else if (char === "\n" || char === "\r") {
      row.push(cell); cell = "";
      if (char === "\r" && text[i + 1] === "\n") i++;
      rows.push(row); row = [];
      closedQuote = false;
    } else cell += char;
  }
  if (quoted) throw new Error("Malformed CSV: an opening quote is not closed.");
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  while (rows.length && rows.at(-1)!.every((value) => value === "")) rows.pop();
  if (!rows.length) throw new Error("The CSV file is empty.");
  const headers = rows.shift()!;
  if (!headers.length || headers.every((header) => !header.trim())) throw new Error("The CSV needs a header row.");
  const data = rows.map((values, index) => ({
    rowNumber: index + 2,
    values,
    sourceErrors: values.length === headers.length ? [] : [`CSV row ${index + 2} has ${values.length} cells; expected ${headers.length}.`],
  }));
  if (data.length > MAX_CSV_ROWS) throw new Error(`Catalog CSVs are limited to ${MAX_CSV_ROWS} data rows.`);
  return { headers, rows: data };
}

export function validateCatalogMapping(headers: string[], input: unknown): CatalogMapping {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose a mapping for each source column.");
  const source = input as Record<string, unknown>;
  const mapping: CatalogMapping = {};
  const assigned = new Set<CatalogField>();
  for (let i = 0; i < headers.length; i++) {
    const value = source[String(i)];
    if (value === null || value === "" || value === undefined) { mapping[i] = null; continue; }
    if (typeof value !== "string" || !CATALOG_FIELDS.includes(value as CatalogField)) throw new Error(`Invalid field mapping for source column ${i + 1}.`);
    if (assigned.has(value as CatalogField)) throw new Error(`${value} is mapped more than once. Each catalog field can be mapped from one source column.`);
    assigned.add(value as CatalogField);
    mapping[i] = value as CatalogField;
  }
  for (const required of ["productName", "sku"] as const) {
    if (!assigned.has(required)) throw new Error(`Map a source column to ${required === "productName" ? "Product Name" : "SKU"} before continuing.`);
  }
  return mapping;
}

export function normalizeCatalogRows(csv: ParsedCatalogCsv, mapping: CatalogMapping) {
  return csv.rows.map(({ rowNumber, values, sourceErrors }) => {
    const normalized: Partial<Record<CatalogField, string>> = {};
    for (const [column, field] of Object.entries(mapping)) if (field) normalized[field] = values[Number(column)] ?? "";
    const errors: string[] = [...sourceErrors];
    if (!normalized.productName?.trim()) errors.push("Product Name is required.");
    if (!normalized.sku?.trim()) errors.push("SKU is required.");
    const price = normalized.price?.trim() || null;
    if (price !== null && !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(price)) errors.push("Price must be a non-negative decimal with up to 14 integer digits and 6 fractional digits.");
    if (price !== null && /^0(?:\.0{1,6})?$/.test(price)) errors.push("Confirm that zero price is intentional before saving this row.");
    return {
      rowNumber, sourceValues: values, normalized, price,
      status: errors.length ? "ERROR" : "READY", errors,
    };
  });
}

export function checksumCatalogCsv(text: string) { return createHash("sha256").update(text, "utf8").digest("hex"); }

export function validateCatalogUpload(name: string, text: string) {
  if (Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES) throw new Error(`Catalog CSVs are limited to ${MAX_CSV_BYTES.toLocaleString()} bytes.`);
  if (!name.toLocaleLowerCase().endsWith(".csv")) throw new Error("Upload a .csv file.");
  return parseCatalogCsv(text);
}
