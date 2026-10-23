/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatStockhubDateTime, formatStockhubMoney } from "../app/utils/stockhub-format.js";

const timestamp = "2026-10-22T08:00:00.000Z";

test("SSR-visible timestamp text is timezone independent", () => {
  assert.equal(formatStockhubDateTime(timestamp), "2026-10-22 08:00 UTC");

  const originalTimezone = process.env.TZ;
  try {
    for (const timezone of ["UTC", "Asia/Ho_Chi_Minh", "America/New_York"]) {
      process.env.TZ = timezone;
      assert.equal(formatStockhubDateTime(timestamp), "2026-10-22 08:00 UTC", timezone);
    }
  } finally {
    process.env.TZ = originalTimezone;
  }
});

test("SSR-visible price text uses a fixed locale", () => {
  assert.equal(formatStockhubMoney("429", "USD"), "USD 429.00");
});

test("route renderers do not use runtime locale formatting", async () => {
  const files = [
    "app/components/OverviewDashboard.tsx",
    "app/components/ProductsCatalog.tsx",
    "app/routes/app.stores.tsx",
    "app/routes/app.imports.history._index.tsx",
    "app/routes/app.imports.history.$batchId.tsx",
  ];
  const source = await Promise.all(files.map((file) => readFile(file, "utf8")));
  assert.equal(source.some((text) => /\.toLocaleString\(|Intl\.NumberFormat\(undefined/.test(text)), false);
});
