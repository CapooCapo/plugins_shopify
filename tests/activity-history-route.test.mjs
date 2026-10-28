/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../app/routes/${name}`, import.meta.url), "utf8");

test("Activity History is a URL-backed Imports route alongside existing import pages", async () => {
  const [route, importsLayout, routeConfig, appShell] = await Promise.all([
    source("app.imports.activity.tsx"),
    source("app.imports.tsx"),
    readFile(new URL("../app/routes.ts", import.meta.url), "utf8"),
    source("app.tsx"),
  ]);

  assert.match(routeConfig, /flatRoutes\(\)/,
    "the Activity route must be discovered from its URL-backed route module");
  assert.match(route, /export const loader = async[\s\S]*?authenticate\.admin\(request\)/,
    "the direct Activity URL remains behind Shopify Admin authentication");
  assert.match(importsLayout, /href="\/app\/imports\/activity"[\s\S]*?navigate\("\/app\/imports\/activity"\)/,
    "Activity History tab navigates to its dedicated URL");
  assert.match(importsLayout, /href="\/app\/imports"[\s\S]*?navigate\("\/app\/imports"\)/,
    "the existing New Import URL remains available");
  assert.match(importsLayout, /href="\/app\/imports\/history"[\s\S]*?navigate\("\/app\/imports\/history"\)/,
    "the existing Import History URL remains available");
  assert.match(importsLayout, /const activityActive = location\.pathname === "\/app\/imports\/activity"/,
    "Activity tab state is derived from its own URL");
  assert.match(importsLayout, /const newImportActive = !historyActive && location\.pathname === "\/app\/imports"/,
    "New Import is current only on its own URL");
  const newImportTab = importsLayout.match(/<s-button\s+href="\/app\/imports"[\s\S]*?<\/s-button>/)?.[0] ?? "";
  const activityTab = importsLayout.match(/<s-button\s+href="\/app\/imports\/activity"[\s\S]*?<\/s-button>/)?.[0] ?? "";
  assert.match(newImportTab, /accessibilityLabel=\{newImportActive \?/);
  assert.match(newImportTab, /variant=\{newImportActive \?/);
  assert.doesNotMatch(newImportTab, /!historyActive/,
    "Activity History must not mark New Import as the current tab");
  assert.match(activityTab, /accessibilityLabel=\{activityActive \?/);
  assert.match(activityTab, /variant=\{activityActive \?/);
  assert.match(appShell, /<a href="\/app\/imports">\s*Imports\s*<\/a>/,
    "Activity History remains nested below the existing primary Imports navigation");
});

test("Activity History renders scoped filters, recorded actors, outcomes, and receipt links", async () => {
  const route = await source("app.imports.activity.tsx");

  assert.match(route, /export const loader[\s\S]*authenticate\.admin\(request\)/,
    "the history must remain behind Shopify Admin authentication");
  assert.match(route, /shop:\s*session\.shop/,
    "all activity queries must be scoped to the authenticated Shopify store");
  assert.match(route, /prisma\.activityLog\.findMany/);
  assert.match(route, /take:\s*PAGE_SIZE\s*\+\s*1/,
    "history reads must be bounded");
  assert.match(route, /SHOPIFY_USER.*actorId/s);
  assert.match(route, /entry\.summary/);
  assert.match(route, /entry\.receiptCode.*entry\.importBatchId/);
  assert.match(route, /\{EVENT_TYPES\.map/);
  assert.match(route, /\{OUTCOMES\.map/);
});

test("Activity logging records preview, merge attempt/result, per-line result and read-only verification", async () => {
  const [route, receiptStore, schema, migration] = await Promise.all([
    source("app.imports._index.tsx"),
    readFile(new URL("../app/utils/import-receipts.server.ts", import.meta.url), "utf8"),
    readFile(new URL("../prisma/schema.prisma", import.meta.url), "utf8"),
    readFile(new URL("../prisma/migrations-sqlite-backup/20261023210000_activity_history/migration.sql", import.meta.url), "utf8"),
  ]);
  assert.match(receiptStore, /eventType:\s*"IMPORT_PREVIEWED"/);
  assert.match(receiptStore, /transaction\.activityLog\.create/,
    "preview and its activity event must be committed together");
  assert.match(route, /eventType:\s*"SHOPIFY_STATE_VERIFIED"/);
  assert.match(route, /outcome:\s*"ATTEMPTED"/);
  assert.match(route, /eventType:\s*isResume\s*\?\s*"IMPORT_RESUME"\s*:\s*"IMPORT_MERGE_CHUNK"/,
    "Merge and Resume attempts are recorded with distinct operation types");
  assert.match(route, /eventType:\s*"IMPORT_MERGE_CHUNK_RESULT"/,
    "each bounded execution chunk persists a result event");
  assert.match(route, /eventType:\s*"IMPORT_LINE_RESULT"/);
  assert.match(schema, /model ActivityLog/);
  assert.match(schema, /@@unique\(\[shop, sourceKey\]\)/);
  assert.match(migration, /FOREIGN KEY \("shop", "importBatchId"\)/);
  const eventMetadata = receiptStore.match(/metadata:\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.ok(eventMetadata, "preview activity metadata should be explicit and allowlisted");
  assert.doesNotMatch(eventMetadata, /fileName|csv|token|cookie|email/i,
    "preview activity should not copy CSV filenames or contents into event metadata");
});
