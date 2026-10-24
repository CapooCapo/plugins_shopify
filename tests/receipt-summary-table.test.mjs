/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detailRoute = new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url);
const stylesheet = new URL("../app/styles/stockhub.css", import.meta.url);

test("receipt progress summary presents every persisted count in an accessible colored table", async () => {
  const [source, css] = await Promise.all([
    readFile(detailRoute, "utf8"),
    readFile(stylesheet, "utf8"),
  ]);
  const summary = source.match(/<table className="stockhub-receipt-summary">([\s\S]*?)<\/table>/)?.[1];

  assert.ok(summary, "receipt progress summary must be a semantic table");
  assert.match(summary, /<caption>Import progress summary<\/caption>/,
    "the table must have an accessible caption");
  assert.match(summary, /<th scope="col">Metric<\/th>[\s\S]*?<th scope="col">Count<\/th>/,
    "the table must identify its metric and count columns");

  const expectedRows = [
    ["Draft products created", "confirmedProductsCreated", "success", "neutral"],
    ["Unresolved Draft product creation", "uncertainProductCreations", "warning", "neutral"],
    ["Inventory activated", "confirmedInventoryActivated", "success", "neutral"],
    ["Import lines completed", "successful", "success", "neutral"],
    ["Failed", "failed", "error", "success"],
    ["Blocked", "blocked", "warning", "success"],
    ["Uncertain", "uncertain", "warning", "success"],
  ];
  for (const [label, count, positiveTone, zeroTone] of expectedRows) {
    const row = summary.match(new RegExp(`<tr><th scope="row">${label}<\\/th>([\\s\\S]*?)<\\/tr>`))?.[1];
    assert.ok(row, `${label} must have its own table row`);
    assert.ok(row.includes(`{${count}}`), `${label} must retain its existing persisted count`);
    assert.match(row, new RegExp(`${count}\\s*>\\s*0\\s*\\?\\s*"stockhub-receipt-summary-count--${positiveTone}"\\s*:\\s*"stockhub-receipt-summary-count--${zeroTone}"`),
      `${label} must use ${positiveTone} for a positive count and ${zeroTone} for zero`);
  }

  assert.match(css, /\.stockhub-receipt-summary-wrap[\s\S]*?overflow-x:\s*auto/,
    "the table wrapper must not force a narrow viewport to overflow");
  assert.match(css, /\.stockhub-receipt-summary-count--success[\s\S]*?--stockhub-success/);
  assert.match(css, /\.stockhub-receipt-summary-count--warning[\s\S]*?--stockhub-warning/);
  assert.match(css, /\.stockhub-receipt-summary-count--error[\s\S]*?--stockhub-error/);
  assert.match(css, /\.stockhub-receipt-summary-count--neutral[\s\S]*?--stockhub-muted/);
});
