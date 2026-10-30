/* eslint-env node */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"]);

async function sourceFiles(directory) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(relative);
    const extension = relative.slice(relative.lastIndexOf("."));
    return sourceExtensions.has(extension) ? [relative] : [];
  }));
  return paths.flat();
}

test("all Overview implementation, analytics, styling, and harness source files stay within 400 lines", async () => {
  const files = [
    "app/routes/app._index.tsx",
    "app/components/OverviewDashboard.tsx",
    "app/utils/overview-types.ts",
    "app/utils/overview-imports-demo.ts",
    "app/utils/overview-imports.server.ts",
    "app/utils/overview-store.server.ts",
    "app/utils/overview-import-status.ts",
    ...(await sourceFiles("app/components/overview")),
    ...(await sourceFiles("app/styles/stockhub")),
    "app/styles/stockhub.css",
    ...(await (async () => {
      const all = await readdir(resolve(root, "app/utils"));
      return all.filter((name) => name.startsWith("overview-analytics") && name.endsWith(".ts")).map((name) => `app/utils/${name}`);
    })()),
    "tests/overview-analytics.test.mjs",
    "tests/overview-import-status.test.mjs",
    "tests/overview-analytics-service.test.mjs",
    "tests/overview-analytics-service-pagination.test.mjs",
    "tests/overview-regressions.test.mjs",
    "tests/overview-source-lines.test.mjs",
    "tests/import-ux-regressions.test.mjs",
    "tests/receipt-summary-table.test.mjs",
    "tests/receipt-recovery-guidance.test.mjs",
    "tests/reviewer-safety-regressions.test.mjs",
    ...(await sourceFiles("tests/visual-harness")),
  ];
  const unique = [...new Set(files)].sort();
  const counts = await Promise.all(unique.map(async (path) => {
    const content = await readFile(resolve(root, path), "utf8");
    const lines = content.length === 0 ? 0 : content.split(/\r\n|\n|\r/).length - (/(?:\r\n|\n|\r)$/.test(content) ? 1 : 0);
    return [path, lines];
  }));
  assert.deepEqual(counts.filter(([, lines]) => lines > 400), [], "source file exceeds the 400-line maximum");
});
