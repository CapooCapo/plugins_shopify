/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";

const viewportWidth = 390;
const fixtureUrl = "http://127.0.0.1:4179/size-guide-visual.html?fixture=picker&picker=selected";

test("Size Guides fits a 390px mobile viewport without page-level horizontal overflow", async () => {
  let pages;
  try {
    pages = await (await fetch("http://127.0.0.1:9223/json/list")).json();
  } catch (error) {
    throw new Error(`Chrome DevTools is unavailable at 127.0.0.1:9223; start the visual-harness browser first: ${error.message}`);
  }
  const page = pages.find((item) => item.type === "page");
  assert.ok(page, "Chrome must expose a page target");

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, label) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await evaluate(expression);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  try {
    await command("Emulation.setDeviceMetricsOverride", {
      width: viewportWidth,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await command("Page.navigate", { url: fixtureUrl });
    await waitFor("Boolean(document.querySelector('.stockhub-size-guide-layout'))", "the Size Guides fixture");
    await evaluate("localStorage.removeItem('stockhub-size-guide-visual-fixture-v1')");
    await command("Page.navigate", { url: fixtureUrl });
    await waitFor("Boolean(document.querySelector('.stockhub-size-guide-layout'))", "the reset Size Guides fixture");

    // Match the saved mobile fixture state: select products and confirm the occupied-product replacement.
    await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Assign products')?.click()`);
    await waitFor("Boolean(document.querySelector('.stockhub-size-guide-picker-form'))", "the selected-product form");
    await evaluate("document.querySelector('input[name=replaceProductIds]')?.click()");
    await waitFor("Boolean(document.querySelector('input[name=confirmReplacements]'))", "replacement confirmation");

    const metrics = await evaluate(`(() => {
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const name = element.tagName.toLowerCase();
        const id = element.getAttribute('id');
        const identity = id ? '#' + id : '';
        const classes = typeof element.className === 'string' ? '.' + element.className.trim().split(/\\s+/).filter(Boolean).join('.') : '';
        return {
          selector: name + identity + classes,
          left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width),
          cssWidth: style.width, minWidth: style.minWidth, display: style.display, overflowX: style.overflowX,
        };
      };
      const viewport = Math.round(window.visualViewport?.width ?? document.documentElement.clientWidth);
      const overflowing = [...document.querySelectorAll('body *')]
        .map(describe)
        .filter((item) => (item.right > viewport && item.right <= viewport + 50) || item.left < 0)
        .sort((left, right) => right.right - left.right)
        .slice(0, 20);
      return {
        viewport,
        layoutViewport: innerWidth,
        clientWidth: document.documentElement.clientWidth,
        screenWidth: screen.width,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        overflowPx: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - viewport,
        overflowing,
      };
    })()`);

    assert.equal(metrics.viewport, viewportWidth, "mobile emulation uses the requested viewport width");
    assert.ok(
      metrics.documentWidth <= viewportWidth && metrics.bodyWidth <= viewportWidth,
      `Size Guides page overflows at ${viewportWidth}px: ${JSON.stringify(metrics, null, 2)}`,
    );
  } finally {
    socket.close();
  }
});
