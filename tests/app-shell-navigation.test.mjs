/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/routes/app.tsx", import.meta.url), "utf8");

test("Shopify app shell exposes the app home and primary routes in App Bridge navigation", () => {
  assert.match(source, /<NavMenu>/);
  assert.match(source, /<a href="\/app" rel="home">[\s\S]*?StockHub home[\s\S]*?<\/a>/,
    "the app-name destination remains explicitly bound to /app");
  for (const [label, path] of [
    ["Overview", "/app"],
    ["Stores", "/app/stores"],
    ["Products", "/app/products"],
    ["Size Guides", "/app/size-guides"],
    ["Imports", "/app/imports"],
    ["Inventory Alerts", "/app/inventory-alerts"],
  ]) {
    assert.match(source, new RegExp(`<a href="${path.replaceAll("/", "\\/")}"(?: rel="home")?>\\s*${label}\\s*<\\/a>`),
      `${label} must have a direct route in the top-level app navigation`);
  }
  assert.equal((source.match(/<NavMenu>/g) ?? []).length, 1,
    "the app must keep one flat Shopify Admin navigation menu");
});
