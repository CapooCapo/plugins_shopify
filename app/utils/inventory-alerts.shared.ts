export type InventoryAlertStatus = "OUT_OF_STOCK" | "LOW_STOCK" | "IN_STOCK" | "UNKNOWN" | "UNTRACKED" | "PARTIAL_DATA";
export type InventoryAlertReadStatus = "ready" | "partial" | "permission_required" | "unavailable" | "unverified";
export type InventoryAlertOption = { name: string; value: string };
export type InventoryAlertRow = {
  productId: string;
  variantId: string;
  inventoryItemId: string | null;
  productName: string;
  productType: string | null;
  sku: string | null;
  color: string | null;
  size: string | null;
  selectedOptions?: InventoryAlertOption[];
  availableQuantity: number | null;
  status: InventoryAlertStatus;
  tracked: boolean | null;
  complete: boolean;
};
export type InventoryAlertFilters = {
  status: "ALL" | InventoryAlertStatus | string;
  productType: string;
  color: string;
  size: string;
  search: string;
};

function normalizedOptionName(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function findOption(options: InventoryAlertOption[], aliases: string[]) {
  const normalizedAliases = aliases.map(normalizedOptionName);
  return options.find((option) => {
    const name = normalizedOptionName(option.name);
    return normalizedAliases.some((alias) => name === alias || name.startsWith(alias));
  })?.value ?? null;
}

export function extractInventoryAlertColorAndSize(options: InventoryAlertOption[]) {
  return {
    color: findOption(options, ["color", "colour", "mau"]),
    size: findOption(options, ["size", "kich thuoc"]),
  };
}

export function classifyInventoryAlert(input: {
  tracked: boolean | null;
  availableQuantity: number | null;
  complete: boolean;
}): InventoryAlertStatus {
  if (input.tracked === false) return "UNTRACKED";
  if (input.tracked !== true) return "UNKNOWN";
  if (!input.complete) return "PARTIAL_DATA";
  if (typeof input.availableQuantity !== "number" || !Number.isFinite(input.availableQuantity)) return "UNKNOWN";
  if (input.availableQuantity <= 0) return "OUT_OF_STOCK";
  if (input.availableQuantity < 5) return "LOW_STOCK";
  return "IN_STOCK";
}

function matches(value: string | null | undefined, filter: string) {
  return !filter || value?.trim().toLocaleLowerCase() === filter.trim().toLocaleLowerCase();
}

function searchableValues(row: InventoryAlertRow) {
  return [row.productName, row.productType, row.sku, row.color, row.size, row.productId, row.variantId,
    row.inventoryItemId, ...(row.selectedOptions ?? []).flatMap((option) => [option.name, option.value])];
}

export function filterInventoryAlertRows(rows: InventoryAlertRow[], filters: InventoryAlertFilters): InventoryAlertRow[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (filters.status !== "ALL" && row.status !== filters.status) return false;
    if (!matches(row.productType, filters.productType) || !matches(row.color, filters.color) || !matches(row.size, filters.size)) return false;
    return !query || searchableValues(row).some((value) => value?.toLocaleLowerCase().includes(query));
  });
}

export function paginateInventoryAlertRows<T>(rows: T[], input: { page: number; pageSize: number }) {
  const pageSize = Number.isFinite(input.pageSize) ? Math.min(100, Math.max(1, Math.floor(input.pageSize))) : 25;
  const pageCount = Math.ceil(rows.length / pageSize);
  const page = pageCount ? Math.min(pageCount, Math.max(1, Math.floor(input.page) || 1)) : 1;
  const start = (page - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), page, pageSize, pageCount, total: rows.length };
}

export function handleInventoryAlertsTableArrowKey(input: {
  key: string;
  currentTarget: { scrollLeft: number; scrollWidth: number; clientWidth: number };
  preventDefault: () => void;
}) {
  if (input.key !== "ArrowLeft" && input.key !== "ArrowRight") return false;
  const region = input.currentTarget;
  const maxScroll = Math.max(0, region.scrollWidth - region.clientWidth);
  if (maxScroll === 0) return false;
  const step = Math.max(40, Math.round(region.clientWidth * 0.2));
  const direction = input.key === "ArrowRight" ? 1 : -1;
  const nextScroll = Math.min(maxScroll, Math.max(0, region.scrollLeft + direction * step));
  if (nextScroll === region.scrollLeft) return false;
  region.scrollLeft = nextScroll;
  input.preventDefault();
  return true;
}

export function selectInventoryAlertExportRows(rows: InventoryAlertRow[], filters: InventoryAlertFilters): InventoryAlertRow[] {
  return filterInventoryAlertRows(rows, filters).filter((row) =>
    (row.status === "OUT_OF_STOCK" || row.status === "LOW_STOCK")
    && row.tracked === true && row.complete && typeof row.availableQuantity === "number" && Number.isFinite(row.availableQuantity));
}

type InventoryAlertExportState = {
  catalogComplete: boolean;
  checkedAt: string | null;
  readStatus: InventoryAlertReadStatus;
  source: "live" | "sample";
  rows: InventoryAlertRow[];
};

export function canExportInventoryAlertRows(input: InventoryAlertExportState) {
  return inventoryAlertExportBlockReason(input) === null;
}

export function inventoryAlertExportBlockReason(input: InventoryAlertExportState): string | null {
  if (!input.catalogComplete) return "Export unavailable: Shopify’s product-variant catalog read is incomplete.";
  if (input.source === "live" && input.rows.some((row) => row.complete === false && row.tracked !== false)) {
    return "Export unavailable: at least one variant has incomplete inventory identity or active-location data.";
  }
  if (!input.checkedAt) return "Export unavailable: no successful inventory read timestamp is available.";
  if (input.readStatus !== "ready" && input.readStatus !== "partial") {
    return "Export unavailable: live inventory could not be verified.";
  }
  return null;
}

function safeText(value: string | null | undefined) {
  const text = value ?? "";
  return ["=", "+", "@", "-"].includes(text.trimStart()[0] ?? "") ? `'${text}` : text;
}

function cell(value: string | number | null | undefined, isText = true) {
  const text = value == null ? "" : String(value);
  const safe = isText ? safeText(text) : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function buildInventoryAlertsCsv(rows: InventoryAlertRow[], options: {
  locationScope: string;
  checkedAt: string;
  dataSource: "LIVE" | "SAMPLE";
}): string {
  const headers = ["product_id", "variant_id", "inventory_item_id", "product_name", "product_type", "sku", "color", "size",
    "available_quantity", "status", "data_source", "location_scope", "checked_at"];
  const eligible = rows.filter((row) => (row.status === "OUT_OF_STOCK" || row.status === "LOW_STOCK")
    && row.tracked === true && row.complete && typeof row.availableQuantity === "number" && Number.isFinite(row.availableQuantity));
  const records = eligible.map((row) => [
    cell(row.productId), cell(row.variantId), cell(row.inventoryItemId), cell(row.productName), cell(row.productType),
    cell(row.sku), cell(row.color), cell(row.size), cell(row.availableQuantity, false), cell(row.status),
    cell(options.dataSource), cell(options.locationScope), cell(options.checkedAt),
  ]);
  return [headers.map((header) => cell(header)).join(","), ...records.map((record) => record.join(","))].join("\r\n");
}
