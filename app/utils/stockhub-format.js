/**
 * Formats server-supplied timestamps deterministically for SSR and hydration.
 * Do not use the browser locale or timezone in UI rendered during hydration.
 */
export function formatStockhubDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";

  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/**
 * Product prices are also rendered during SSR, so their locale must be fixed.
 */
export function formatStockhubMoney(amount, currencyCode) {
  const value = Number(amount);
  if (!Number.isFinite(value) || !currencyCode) return `${amount} ${currencyCode ?? ""}`.trim();

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
      currencyDisplay: "code",
    }).format(value);
  } catch {
    return `${amount} ${currencyCode}`;
  }
}
