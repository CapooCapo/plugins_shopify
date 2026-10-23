import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const [target] = await (await fetch("http://127.0.0.1:9223/json/list")).json();
if (!target?.webSocketDebuggerUrl) throw new Error("No Chrome DevTools page is available");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const consoleErrors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push({ kind: "exception", text: message.params.exceptionDetails.text });
  }
  if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    consoleErrors.push({ kind: "log", text: message.params.entry.text });
  }
  if (!message.id) return;
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
  else callback.resolve(message.result);
});

function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const output = new URL("./screenshots/", import.meta.url);
await mkdir(output, { recursive: true });
const snapshots = [];
await command("Log.enable");
await command("Runtime.enable");
for (const width of [1280, 390]) {
  await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
  consoleErrors.length = 0;
  await command("Page.navigate", { url: "http://127.0.0.1:3001/" });
  for (const [name, delay] of [["initial", 500], ["3s", 2500], ["10s", 7000]]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const inspection = await command("Runtime.evaluate", {
      expression: `JSON.stringify({
        viewport: { width: innerWidth, height: innerHeight },
        documentChildren: [...document.documentElement.children].map((node) => node.tagName),
        headChildren: [...document.head.children].map((node) => ({ tag: node.tagName, rel: node.getAttribute("rel"), href: node.getAttribute("href") })),
        stockhubStylesheet: [...document.styleSheets].some((sheet) => sheet.href?.includes("root-")),
        appBodyPresent: Boolean(document.body?.querySelector("form")),
      })`,
      returnByValue: true,
    });
    const state = JSON.parse(inspection.result.value);
    const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(new URL(`production-login-${width}-${name}.png`, output), Buffer.from(screenshot.data, "base64"));
    snapshots.push({ width, name, state, consoleErrors: [...consoleErrors] });
  }
}

await writeFile(new URL("production-login-hydration.json", output), JSON.stringify(snapshots, null, 2));
socket.close();

for (const snapshot of snapshots) {
  assert.equal(snapshot.state.viewport.width, snapshot.width, `${snapshot.name}: unexpected viewport`);
  assert.deepEqual(snapshot.state.documentChildren, ["HEAD", "BODY"], `${snapshot.name}: document shell changed`);
  assert.equal(snapshot.state.stockhubStylesheet, true, `${snapshot.name}: StockHub stylesheet is missing`);
  assert.equal(snapshot.state.appBodyPresent, true, `${snapshot.name}: route content was replaced`);
}
assert.equal(consoleErrors.length, 0, `console errors: ${JSON.stringify(consoleErrors)}`);
