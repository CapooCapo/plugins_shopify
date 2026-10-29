export function datePartsInZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  if (!values.year || !values.month || !values.day) {
    throw new Error("Could not read the shop-local calendar date.");
  }
  return `${values.year}-${values.month}-${values.day}`;
}

function addCalendarDays(date: string, amount: number) {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + amount));
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, "0")}-${String(result.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Finds the first UTC millisecond belonging to a shop-local calendar date. A
 * lower-bound search handles 23/25-hour DST days and zones that shift at midnight.
 */
function localDateStartUtc(date: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const estimate = Date.UTC(year, month - 1, day);
  let low = estimate - 48 * 60 * 60 * 1000;
  let high = estimate + 48 * 60 * 60 * 1000;

  if (datePartsInZone(new Date(low), timeZone) >= date || datePartsInZone(new Date(high), timeZone) < date) {
    throw new Error("Could not resolve the shop-local day boundary.");
  }

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (datePartsInZone(new Date(middle), timeZone) >= date) high = middle;
    else low = middle;
  }
  return new Date(high).toISOString();
}

/** A half-open UTC range for the last N shop-local calendar days, including today. */
export function computeShopLocalDateWindow(
  now: Date | string,
  dayCount: 7 | 30,
  timeZone: string,
): { startUtc: string; endExclusiveUtc: string; dates: string[] } {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error("A valid current time is required.");
  if (dayCount !== 7 && dayCount !== 30) throw new Error("The date range must be 7 or 30 days.");

  const today = datePartsInZone(instant, timeZone);
  const dates = Array.from({ length: dayCount }, (_, index) => addCalendarDays(today, index - dayCount + 1));
  return {
    startUtc: localDateStartUtc(dates[0], timeZone),
    endExclusiveUtc: localDateStartUtc(addCalendarDays(today, 1), timeZone),
    dates,
  };
}
