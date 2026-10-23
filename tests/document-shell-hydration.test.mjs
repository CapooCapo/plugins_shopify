/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootPath = new URL("../app/root.tsx", import.meta.url);

test("the root route keeps one stable React Router document Layout", async () => {
  const source = await readFile(rootPath, "utf8");
  const layout = source.match(/export function Layout\([\s\S]*?\n}\n\nexport default function App/s)?.[0] ?? "";
  const app = source.match(/export default function App\(\)[\s\S]*?\n}/)?.[0] ?? "";

  assert.match(layout, /<html lang="en">/);
  assert.match(layout, /<head>[\s\S]*?<Meta\s*\/>[\s\S]*?<Links\s*\/>[\s\S]*?<\/head>/);
  assert.doesNotMatch(layout, /<link\b/);
  assert.match(layout, /<body className="stockhub-app-frame">[\s\S]*?\{children\}[\s\S]*?<ScrollRestoration\s*\/>[\s\S]*?<Scripts\s*\/>[\s\S]*?<\/body>/);
  assert.match(app, /return <Outlet\s*\/>;/);
  assert.doesNotMatch(app, /<(?:html|head|body|link)\b/);
});
