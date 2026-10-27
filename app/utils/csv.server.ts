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
