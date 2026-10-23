/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const historyRoute = new URL("../app/routes/app.imports.history._index.tsx", import.meta.url);

async function readHistoryRoute() {
  return readFile(historyRoute, "utf8");
}

test("receipt detail navigation uses React Router client-side navigation", async () => {
  const source = await readHistoryRoute();
  const receiptCell = source.match(/<s-table-cell>\s*([\s\S]*?)\s*<\/s-table-cell>/g)
    ?.find((cell) => cell.includes("historyDetailHref(batch.id")) ?? "";

  assert.match(source, /import\s*\{[^}]*\bLink\b[^}]*\}\s*from\s*["']react-router["']/,
    "receipt details should use React Router's Link for same-app navigation");
  assert.match(receiptCell, /<Link\s+to=\{historyDetailHref\(batch\.id,/,
    "receipt detail navigation must use a React Router Link, not a full-document anchor");
  assert.doesNotMatch(receiptCell, /<a\s+href=/,
    "receipt detail navigation must not trigger a document request through a plain anchor");
});

test("Import History keeps its Shopify authentication and response boundary", async () => {
  const source = await readHistoryRoute();

  assert.match(source, /import\s*\{\s*boundary\s*\}\s*from\s*["']@shopify\/shopify-app-react-router\/server["']/,
    "the Shopify response boundary import must remain present");
  assert.match(source, /await\s+authenticate\.admin\(request\)/,
    "the history loader must still authenticate requests");
  assert.match(source, /export\s+const\s+headers\s*:[\s\S]*?boundary\.headers\(/,
    "the route must keep delegating response headers to Shopify's boundary");
});
