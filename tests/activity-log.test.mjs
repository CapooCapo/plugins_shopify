/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { DatabaseSync } from "node:sqlite";

const source = await readFile(new URL("../app/utils/activity-log.server.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const { actorFromShopifySession, activityCreateData } = await import(moduleUrl);
const migration = await readFile(new URL("../prisma/migrations-sqlite-backup/20261023210000_activity_history/migration.sql", import.meta.url), "utf8");

test("actor identity is attributed only from an online Shopify user session", () => {
  assert.deepEqual(actorFromShopifySession({ isOnline: true, userId: 998877n }), {
    actorType: "SHOPIFY_USER", actorId: "998877",
  });
  assert.deepEqual(actorFromShopifySession({ isOnline: false, userId: 998877n }), {
    actorType: "UNKNOWN", actorId: null,
  });
  assert.deepEqual(actorFromShopifySession({ isOnline: true, userId: null }), {
    actorType: "UNKNOWN", actorId: null,
  });
});

test("activity rows are bounded, append-only event records without credential fields", () => {
  const row = activityCreateData({
    shop: "demo.myshopify.com",
    eventType: "IMPORT_PREVIEWED",
    outcome: "SUCCEEDED",
    actor: actorFromShopifySession({ isOnline: true, userId: 998877n }),
    importBatchId: "batch-1",
    receiptCode: "IMP-20261024-000001",
    summary: "CSV preview saved.",
    metadata: { rowCount: 4, blockedRows: 0 },
    sourceKey: "batch:batch-1:preview",
  });
  assert.equal(row.shop, "demo.myshopify.com");
  assert.equal(row.actorId, "998877");
  assert.equal(row.sourceKey, "batch:batch-1:preview");
  assert.deepEqual(JSON.parse(row.metadataJson), { rowCount: 4, blockedRows: 0 });
  assert.equal("accessToken" in row, false);
  assert.throws(() => activityCreateData({
    shop: "demo.myshopify.com", eventType: "TEST", outcome: "SUCCEEDED",
    actor: { actorType: "UNKNOWN", actorId: null }, summary: "too much metadata",
    metadata: { value: "x".repeat(3000) },
  }), /bounded event size/);
});

test("ActivityLog migration enforces shop ownership and cascades with its import batch", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`CREATE TABLE ImportBatch (id TEXT PRIMARY KEY, shop TEXT NOT NULL)`);
    db.exec(migration);
    db.prepare("INSERT INTO ImportBatch (id, shop) VALUES (?, ?)").run("batch-a", "shop-a");
    const insert = db.prepare(`INSERT INTO ActivityLog
      (id, shop, eventType, outcome, actorType, importBatchId, summary, sourceKey)
      VALUES (?, ?, 'IMPORT_PREVIEWED', 'SUCCEEDED', 'UNKNOWN', ?, 'Preview saved', ?)`);
    insert.run("event-a", "shop-a", "batch-a", "key-a");
    assert.throws(() => insert.run("event-b", "shop-b", "batch-a", "key-b"), /FOREIGN KEY/);
    assert.throws(() => insert.run("event-c", "shop-a", "batch-a", "key-a"), /UNIQUE/);
    db.prepare("DELETE FROM ImportBatch WHERE id = ? AND shop = ?").run("batch-a", "shop-a");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ActivityLog").get().n, 0);
  } finally {
    db.close();
  }
});
