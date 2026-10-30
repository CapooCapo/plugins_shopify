import { formatStockhubDateTime, formatStockhubMoney } from "../../utils/stockhub-format.js";

export function numberLabel(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function currencyLabel(value: number | null | undefined, currencyCode: string | null) {
  if (value == null || !currencyCode) return "Unavailable";
  return formatStockhubMoney(value, currencyCode);
}

export function dateLabel(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(value);
}

export function dateTimeLabel(value: Date | string) {
  return formatStockhubDateTime(value);
}

export function productAdminUrl(domain: string | undefined, resourceId: string | undefined, productId?: string) {
  if (!domain) return undefined;
  const id = resourceId ?? productId?.match(/\/Product\/(\d+)$/)?.[1];
  return id ? `https://${domain}/admin/products/${encodeURIComponent(id)}` : undefined;
}

export function importStatusLabel(status: string, kind: "inventory" | "catalog") {
  if (kind === "catalog") {
    if (status === "CATALOG_MAPPING" || status === "MAPPING") return "Mapping columns";
    if (status === "CATALOG_DRAFT" || status === "DRAFT") return "Draft";
    if (status === "CATALOG_IN_PROGRESS") return "In progress";
    if (status === "CATALOG_UNCERTAIN") return "Outcome uncertain";
    if (status === "CATALOG_ATTENTION") return "Needs attention";
    if (status === "CATALOG_EXECUTION_COMPLETE") return "Catalog execution complete";
    return `Catalog status · ${status}`;
  }
  return status === "COMPLETED" ? "Completed" : status === "PARTIAL" ? "Partially completed"
    : status === "UNCERTAIN" ? "Outcome uncertain" : status === "FAILED" ? "Failed"
      : status === "BLOCKED" ? "Blocked" : status === "RUNNING" ? "In progress"
        : status === "PROCESSING" ? "Processing" : status === "PREVIEWED" ? "Previewed" : status;
}

export function importStatusClass(status: string) {
  if (status === "COMPLETED" || status === "CATALOG_EXECUTION_COMPLETE") return "stockhub-status--success";
  if (status === "FAILED" || status === "BLOCKED") return "stockhub-status--error";
  if (status === "PARTIAL" || status === "UNCERTAIN" || status === "CATALOG_UNCERTAIN" || status === "CATALOG_ATTENTION") return "stockhub-status--warning";
  return "stockhub-status--info";
}
