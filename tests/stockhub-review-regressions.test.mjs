/* eslint-env node */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const routeUrl = (name) => new URL(`../app/routes/${name}`, import.meta.url);

async function source(name) {
  return readFile(routeUrl(name), "utf8");
}

function executableValidationGroup(route) {
  const start = route.indexOf("function validationGroup(");
  const end = route.indexOf("\n}\n\nfunction correctionHint", start);
  assert.ok(start >= 0 && end > start, "validationGroup helper must be present in the receipt route");
  const typedFunction = route.slice(start, end + 2);
  const javascriptFunction = typedFunction.replace(
    /function validationGroup\(line:\s*\{[\s\S]*?\}\)\s*\{/,
    "function validationGroup(line) {",
  );
  assert.notEqual(javascriptFunction, typedFunction, "validationGroup test adapter must remove its TypeScript-only parameter type");
  return vm.runInNewContext(`(${javascriptFunction})`);
}

test("receipt validation classifies a SUCCEEDED line as successful, not Error", async () => {
  const route = await source("app.imports.history.$batchId.tsx");
  const validationGroup = executableValidationGroup(route);

  assert.notEqual(validationGroup({
    status: "SUCCEEDED",
    operationType: "ADJUST",
    errorCode: null,
    errorDetail: null,
  }), "ERROR", "a successful line must not be counted or displayed in the Error group");
});

test("switching a dirty edit drawer to delete requires a discard decision", async () => {
  const route = await source("app.imports.history.$batchId.tsx");
  const deleteButton = route.match(/<button type="button" className="stockhub-delete-action"[\s\S]*?<\/button>/)?.[0] ?? "";
  const inlineGuard = /onClick=\{\(\)\s*=>\s*\{[\s\S]*?drawerDirty[\s\S]*?setDiscardConfirming\(true\)/.test(deleteButton);
  const handlerName = deleteButton.match(/onClick=\{([A-Za-z_$][\w$]*)\}/)?.[1];
  const namedHandler = handlerName
    ? route.match(new RegExp(`(?:const|function) ${handlerName}\\b[\\s\\S]*?(?:\\n\\s*};|\\n\\s*})`))?.[0] ?? ""
    : "";
  const namedGuard = /drawerDirty[\s\S]*?(?:setDiscardConfirming\(true\)|discardConfirming)/.test(namedHandler);

  assert.ok(deleteButton && (inlineGuard || namedGuard),
    "Delete draft row must preserve unsaved edits until the user explicitly chooses to discard them");
});

test("changing the CSV or Shopify location invalidates duplicate-import confirmation", async () => {
  const route = await source("app.imports._index.tsx");
  const formStart = route.indexOf('<Form method="post" encType="multipart/form-data" data-import-preview-form="true"');
  const formEnd = route.indexOf("</Form>", formStart);
  const form = formStart >= 0 && formEnd > formStart ? route.slice(formStart, formEnd) : "";
  const duplicateGuard = form.match(/\{([^{}]*)\? <input type="hidden" name="duplicateConfirmed" value="yes" \/> : null\}/)?.[1] ?? "";
  const confirmationState = /duplicateConfirmed|duplicateConfirmation|confirmationKey|selectedFile|locationId/i.test(duplicateGuard);
  const formChangeInvalidates = /onChange=\{[^}]*?(?:invalidate|reset|clear|set)\w*(?:duplicate|confirmation)|onChange=\{\([^)]*\)\s*=>\s*\{[^}]*?(?:duplicateConfirmed|duplicateConfirmation)/i.test(form);
  const droppedFileInvalidates = /onDrop=\{[\s\S]*?(?:invalidate|reset|clear|set)\w*(?:duplicate|confirmation)|onDrop=\{[\s\S]*?(?:duplicateConfirmed|duplicateConfirmation)/i.test(form);

  assert.ok(confirmationState && formChangeInvalidates && droppedFileInvalidates,
    "A new CSV or location must invalidate the prior duplicate confirmation, including CSVs selected by drag and drop");
});

test("test:postgres generates its dedicated Prisma client before running on a clean checkout", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const scripts = packageJson.scripts ?? {};
  const guard = await readFile(new URL("../scripts/postgres-test-guard.mjs", import.meta.url), "utf8");
  const prismaDirectory = new URL("../prisma/", import.meta.url);
  const prismaFiles = (await readdir(prismaDirectory)).filter((name) => name.endsWith(".prisma"));
  const prismaSources = await Promise.all(prismaFiles.map((name) => readFile(new URL(name, prismaDirectory), "utf8")));
  const entrypointSetup = [scripts["pretest:postgres"], scripts["test:postgres"], guard].filter(Boolean).join("\n");
  const generatesClient = /\bprisma\s+generate\b/.test(entrypointSetup)
    || /run\(prismaCli,\s*\[\s*["']generate["']/.test(guard);
  const targetsDedicatedClient = /stockhub-pg-test-client/.test(entrypointSetup + prismaSources.join("\n"));

  assert.ok(generatesClient && targetsDedicatedClient,
    "test:postgres must generate node_modules/.prisma/stockhub-pg-test-client from its clean-checkout entry point before launching PostgreSQL specs");
});
