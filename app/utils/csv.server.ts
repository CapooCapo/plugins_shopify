import { MAX_CSV_ROWS, MAX_GRAPHQL_INT, MAX_SKU_LENGTH } from "./csv-limits.js";

export { MAX_CSV_BYTES, MAX_CSV_ROWS } from "./csv-limits.js";

export type CsvPreviewRow = {
  rowNumber: number;
  sku: string;
  title: string | null;
  description: string | null;
  price: string | null;
  quantity: number | null;
  image_url: string | null;
  errors: string[];
};

export type CsvMatchStatus =
  "matched" | "ambiguous" | "unmatched" | "unresolved";

export function resolveCsvMatch<T extends { inventoryQuantity: number | null }>(
  row: Pick<CsvPreviewRow, "title" | "quantity">,
  matches: T[],
  lookupIncomplete: boolean,
): {
  matchStatus: CsvMatchStatus;
  matches: T[];
  proposedAdjustment: number | null;
  missingFields: string[];
} {
  if (matches.length > 1) {
    return {
      matchStatus: "ambiguous",
      matches: matches.slice(0, 5),
      proposedAdjustment: null,
      missingFields: [],
    };
  }
  if (lookupIncomplete) {
    return {
      matchStatus: "unresolved",
      matches,
      proposedAdjustment: null,
      missingFields: [],
    };
  }
  if (matches.length === 1) {
    const match = matches[0]!;
    return {
      matchStatus: "matched",
      matches,
      proposedAdjustment:
        match.inventoryQuantity === null || row.quantity === null
          ? null
          : row.quantity - match.inventoryQuantity,
      missingFields: [],
    };
  }
  return {
    matchStatus: "unmatched",
    matches: [],
    proposedAdjustment: null,
    missingFields: row.title ? [] : ["title"],
  };
}

type CsvRecord = { fields: string[]; lineNumber: number };

export type ReceivingCsvField = "sku" | "quantity" | "productName" | "productGroup" | "size" | "color" | "price" | "barcode";
export type ReceivingCsvRow = {
  rowNumber: number;
  rawValues: Record<string, string>;
  sku: string | null;
  quantity: number | null;
  productName: string | null;
  productGroup: string | null;
  size: string | null;
  color: string | null;
  price: string | null;
  barcode: string | null;
  errors: string[];
  duplicateDecisionRequired: boolean;
  duplicateConflict: boolean;
};
export type ReceivingCsvPreview = {
  headers: string[];
  suggestedMapping: Partial<Record<ReceivingCsvField, string>>;
  mapping: Partial<Record<ReceivingCsvField, string>>;
  fileErrors: string[];
  rows: ReceivingCsvRow[];
};

const RECEIVING_HEADER_ALIASES: Record<ReceivingCsvField, string[]> = {
  sku: ["sku", "variant sku", "ma sku", "ma san pham", "ma sp", "sku san pham"],
  quantity: ["quantity", "qty", "so luong", "sl", "received quantity", "expected quantity"],
  productName: ["product name", "title", "ten san pham", "ten sp", "san pham"],
  productGroup: ["product group code", "product group", "group", "ma nhom", "nhom san pham"],
  size: ["size", "kich co", "co"],
  color: ["color", "colour", "mau", "mau sac"],
  price: ["price", "gia", "don gia"],
  barcode: ["barcode", "bar code", "ma vach"],
};

function normalizeHeader(value: string) {
  return value.trim().toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Flexible S2 parser kept separate from the legacy fixed-header import contract. */
export function parseReceivingCsv(source: string, overrides: Partial<Record<ReceivingCsvField, string>> = {}): ReceivingCsvPreview {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const records = parseRecords(normalized);
  if (!records.length) throw new CsvFormatError("The CSV file is empty.");
  const headers = records[0]!.fields.map((value) => value.trim());
  const fileErrors: string[] = [];
  if (headers.some((header) => !header)) fileErrors.push("CSV column names cannot be empty.");
  if (new Set(headers.map(normalizeHeader)).size !== headers.length) fileErrors.push("CSV column names must be unique.");
  const suggestedMapping: Partial<Record<ReceivingCsvField, string>> = {};
  for (const [field, aliases] of Object.entries(RECEIVING_HEADER_ALIASES) as [ReceivingCsvField, string[]][]) {
    const matches = headers.filter((header) => aliases.includes(normalizeHeader(header)));
    if (matches.length === 1) suggestedMapping[field] = matches[0];
    if (matches.length > 1 && !overrides[field]) fileErrors.push(`More than one column could map to ${field}; choose manually.`);
  }
  const mapping = { ...suggestedMapping, ...overrides };
  const mappedHeaders = Object.entries(mapping).filter((entry): entry is [string, string] => Boolean(entry[1]));
  const reusedHeader = mappedHeaders.find(([, header], index) => mappedHeaders.slice(0, index).some(([, prior]) => prior === header));
  if (reusedHeader) fileErrors.push(`Source column "${reusedHeader[1]}" is mapped to more than one field; choose a unique column for each field.`);
  if (!mapping.sku || !mapping.quantity) fileErrors.push("Map both SKU and Quantity before processing this file.");
  for (const [field, header] of Object.entries(mapping)) {
    if (header && !headers.includes(header)) fileErrors.push(`Mapped ${field} column is not present in this file.`);
  }
  const rows: ReceivingCsvRow[] = records.slice(1).map(({ fields, lineNumber }) => {
    const rawValues = Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? ""]));
    const errors: string[] = [];
    if (fields.length !== headers.length) {
      const message = `CSV row on line ${lineNumber} has ${fields.length} cells but the header has ${headers.length}; file-level structure is unreliable.`;
      errors.push(message);
      fileErrors.push(message);
    }
    const value = (field: ReceivingCsvField) => mapping[field] ? rawValues[mapping[field]!] ?? "" : "";
    const rawSku = value("sku");
    const sku = rawSku.trim() || null;
    if (!sku) errors.push("SKU is required.");
    if (sku && sku.length > MAX_SKU_LENGTH) errors.push(`SKU must be ${MAX_SKU_LENGTH} characters or fewer.`);
    const rawQuantity = value("quantity").trim();
    const quantity = /^\d+$/.test(rawQuantity) && Number(rawQuantity) > 0 && Number(rawQuantity) <= MAX_GRAPHQL_INT ? Number(rawQuantity) : null;
    if (quantity === null) errors.push("Quantity must be a positive whole number.");
    const price = value("price").trim() || null;
    if (price !== null && (!/^\d+(?:\.\d+)?$/.test(price) || !Number.isFinite(Number(price)))) errors.push("Price must be a non-negative decimal number.");
    return { rowNumber: lineNumber, rawValues, sku, quantity, productName: value("productName").trim() || null, productGroup: value("productGroup").trim() || null, size: value("size").trim() || null, color: value("color").trim() || null, price, barcode: value("barcode").trim() || null, errors, duplicateDecisionRequired: false, duplicateConflict: false };
  });
  const bySku = new Map<string, ReceivingCsvRow[]>();
  for (const row of rows) if (row.sku) bySku.set(row.sku, [...(bySku.get(row.sku) ?? []), row]);
  for (const sameSku of bySku.values()) {
    if (sameSku.length < 2) continue;
    const signatures = new Set(sameSku.map((row) => JSON.stringify([row.productName, row.productGroup, row.size, row.color, row.price, row.barcode])));
    const conflict = signatures.size > 1;
    for (const row of sameSku) {
      row.duplicateDecisionRequired = true;
      row.duplicateConflict = conflict;
      if (conflict) row.errors.push("Duplicate SKU rows contain conflicting product data; automatic merge is blocked.");
    }
  }
  if (!rows.length) fileErrors.push("The CSV file has no product rows.");
  if (rows.length > MAX_CSV_ROWS) fileErrors.push(`The CSV exceeds the ${MAX_CSV_ROWS}-row limit.`);
  return { headers, suggestedMapping, mapping, fileErrors, rows };
}

export type ReceivingMatchOutcome = "EXISTING_VARIANT" | "NEW_VARIANT" | "NEW_PRODUCT" | "NEEDS_REVIEW" | "BLOCKED";
export function classifyReceivingMatch(input: { variants: Array<{ productId: string; variantId: string; sku: string | null; options?: Record<string, string> }>; lookupComplete: boolean; productName?: string | null; productGroup?: string | null; size?: string | null; color?: string | null; optionCombinationExists?: boolean; duplicateConflict?: boolean }): { outcome: ReceivingMatchOutcome; candidateVariantId: string | null; requiresConfirmation: boolean } {
  if (input.duplicateConflict) return { outcome: "BLOCKED", candidateVariantId: null, requiresConfirmation: true };
  if (!input.lookupComplete) return { outcome: "NEEDS_REVIEW", candidateVariantId: null, requiresConfirmation: true };
  if (input.variants.length > 1) return { outcome: "NEEDS_REVIEW", candidateVariantId: null, requiresConfirmation: true };
  if (input.variants.length === 1) return { outcome: "EXISTING_VARIANT", candidateVariantId: input.variants[0]!.variantId, requiresConfirmation: false };
  if (input.productGroup && input.productName && (input.size || input.color)) {
    return { outcome: input.optionCombinationExists ? "NEEDS_REVIEW" : "NEW_VARIANT", candidateVariantId: null, requiresConfirmation: true };
  }
  if (input.productName) return { outcome: "NEW_PRODUCT", candidateVariantId: null, requiresConfirmation: true };
  return { outcome: "BLOCKED", candidateVariantId: null, requiresConfirmation: true };
}

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvFormatError";
  }
}

function parseRecords(source: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let lineNumber = 1;
  let recordLineNumber = 1;
  let inQuotes = false;
  let quoteClosed = false;
  let recordStarted = false;

  const finishField = () => {
    fields.push(field);
    field = "";
    quoteClosed = false;
    recordStarted = true;
  };

  const finishRecord = () => {
    finishField();
    if (fields.some((value) => value.trim() !== "")) {
      records.push({ fields, lineNumber: recordLineNumber });
      if (records.length > MAX_CSV_ROWS + 1) {
        throw new CsvFormatError(
          `The CSV exceeds the ${MAX_CSV_ROWS}-row limit. Split it into smaller files.`,
        );
      }
    }
    fields = [];
    recordStarted = false;
    recordLineNumber = lineNumber + 1;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;

    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        field += character;
        if (character === "\n") lineNumber += 1;
        if (character === "\r") {
          if (source[index + 1] === "\n") {
            field += "\n";
            index += 1;
          }
          lineNumber += 1;
        }
      }
      continue;
    }

    if (quoteClosed) {
      if (character === ",") {
        finishField();
        continue;
      }
      if (character === "\n" || character === "\r") {
        finishRecord();
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        lineNumber += 1;
        recordLineNumber = lineNumber;
        continue;
      }
      throw new CsvFormatError(
        `Unexpected character after a closing quote on line ${lineNumber}.`,
      );
    }

    if (character === '"') {
      if (field.length !== 0) {
        throw new CsvFormatError(
          `Unexpected quote in an unquoted field on line ${lineNumber}.`,
        );
      }
      inQuotes = true;
      recordStarted = true;
      continue;
    }
    if (character === ",") {
      finishField();
      continue;
    }
    if (character === "\n" || character === "\r") {
      finishRecord();
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      lineNumber += 1;
      recordLineNumber = lineNumber;
      continue;
    }

    field += character;
    recordStarted = true;
  }

  if (inQuotes) {
    throw new CsvFormatError(
      `Unclosed quoted field starting on line ${recordLineNumber}.`,
    );
  }
  if (recordStarted || fields.length > 0 || field.length > 0 || quoteClosed) {
    finishRecord();
  }

  return records;
}

export function parseCsvPreview(source: string): CsvPreviewRow[] {
  const normalizedSource = source.startsWith("\uFEFF")
    ? source.slice(1)
    : source;
  const records = parseRecords(normalizedSource);

  if (records.length === 0) {
    throw new CsvFormatError("The CSV file is empty.");
  }

  const [headerRecord, ...dataRecords] = records;
  const headers = headerRecord!.fields.map((value) =>
    value.trim().toLowerCase(),
  );
  const headerSet = new Set(headers);

  if (headers.some((header) => header.length === 0)) {
    throw new CsvFormatError("CSV column names cannot be empty.");
  }
  if (headerSet.size !== headers.length) {
    throw new CsvFormatError("CSV column names must be unique.");
  }

  const allowedHeaders = new Set([
    "sku",
    "title",
    "description",
    "price",
    "quantity",
    "image_url",
  ]);
  const unknownHeader = headers.find((header) => !allowedHeaders.has(header));
  if (unknownHeader) {
    throw new CsvFormatError(`Unknown CSV column: ${unknownHeader}.`);
  }
  for (const requiredHeader of ["sku", "quantity"]) {
    if (!headerSet.has(requiredHeader)) {
      throw new CsvFormatError(
        `Required CSV column "${requiredHeader}" is missing.`,
      );
    }
  }
  if (dataRecords.length === 0) {
    throw new CsvFormatError("The CSV file has no product rows.");
  }
  if (dataRecords.length > MAX_CSV_ROWS) {
    throw new CsvFormatError(
      `The CSV exceeds the ${MAX_CSV_ROWS}-row limit. Split it into smaller files.`,
    );
  }

  const columnIndex = (name: string) => headers.indexOf(name);
  const rows = dataRecords.map(({ fields, lineNumber }): CsvPreviewRow => {
    const errors: string[] = [];
    if (fields.length !== headers.length) {
      errors.push(
        `Expected ${headers.length} columns but found ${fields.length}.`,
      );
    }

    const rawSku = fields[columnIndex("sku")] ?? "";
    const sku = rawSku.trim();
    if (!sku) errors.push("SKU is required.");
    if (sku.length > MAX_SKU_LENGTH) {
      errors.push(`SKU must be ${MAX_SKU_LENGTH} characters or fewer.`);
    }

    const rawQuantity = (fields[columnIndex("quantity")] ?? "").trim();
    let quantity: number | null = null;
    if (!/^\d+$/.test(rawQuantity) || Number(rawQuantity) <= 0) {
      errors.push("Quantity must be a positive whole number.");
    } else if (Number(rawQuantity) > MAX_GRAPHQL_INT) {
      errors.push(
        `Quantity must not exceed ${MAX_GRAPHQL_INT.toLocaleString()} (Shopify GraphQL Int limit).`,
      );
    } else {
      quantity = Number(rawQuantity);
      if (!Number.isSafeInteger(quantity)) {
        quantity = null;
        errors.push("Quantity is too large to validate safely.");
      }
    }

    const rawPrice =
      columnIndex("price") < 0
        ? ""
        : (fields[columnIndex("price")] ?? "").trim();
    let price: string | null = rawPrice || null;
    if (
      price !== null &&
      (!/^\d+(?:\.\d+)?$/.test(price) || !Number.isFinite(Number(price)))
    ) {
      errors.push("Price must be a non-negative decimal number.");
      price = null;
    }

    const rawTitle =
      columnIndex("title") < 0
        ? ""
        : (fields[columnIndex("title")] ?? "").trim();
    const rawDescription =
      columnIndex("description") < 0
        ? ""
        : (fields[columnIndex("description")] ?? "");
    const rawImageUrl =
      columnIndex("image_url") < 0
        ? ""
        : (fields[columnIndex("image_url")] ?? "");

    return {
      rowNumber: lineNumber,
      sku,
      title: rawTitle || null,
      description: rawDescription.trim() ? rawDescription : null,
      price,
      quantity,
      image_url: rawImageUrl.trim() ? rawImageUrl : null,
      errors,
    };
  });

  const rowsBySku = new Map<string, CsvPreviewRow[]>();
  for (const row of rows) {
    if (!row.sku) continue;
    const sameSkuRows = rowsBySku.get(row.sku) ?? [];
    sameSkuRows.push(row);
    rowsBySku.set(row.sku, sameSkuRows);
  }
  for (const [sku, sameSkuRows] of rowsBySku) {
    if (sameSkuRows.length > 1) {
      for (const row of sameSkuRows) {
        row.errors.push(`SKU "${sku}" appears more than once in this file.`);
      }
    }
  }

  return rows;
}
