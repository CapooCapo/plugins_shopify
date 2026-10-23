/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const helperUrl = new URL("../app/utils/privacy-webhooks.server.ts", import.meta.url);
const [helperSource, dataRequestRoute, customerRedactRoute, shopRedactRoute, appConfig] = await Promise.all([
  readFile(helperUrl, "utf8"),
  readFile(new URL("../app/routes/webhooks.customers.data_request.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/routes/webhooks.customers.redact.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/routes/webhooks.shop.redact.tsx", import.meta.url), "utf8"),
  readFile(new URL("../shopify.app.toml", import.meta.url), "utf8"),
]);
const { outputText } = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const helperUrlAsData = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
const { acknowledgeCustomerDataRequest, redactCustomerData, redactShopData } = await import(helperUrlAsData);

const validCustomerPayload = { shop_id: 987654321, customer: { id: 123456789, email: "customer@example.test" } };

test("privacy routes authenticate through Shopify SDK before processing request payloads", () => {
  for (const route of [dataRequestRoute, customerRedactRoute, shopRedactRoute]) {
    assert.match(route, /await authenticate\.webhook\(request\)/);
  }
  assert.match(dataRequestRoute, /authenticate\.webhook\(request\)[\s\S]*acknowledgeCustomerDataRequest/);
  assert.match(customerRedactRoute, /authenticate\.webhook\(request\)[\s\S]*redactCustomerData/);
  assert.match(shopRedactRoute, /authenticate\.webhook\(request\)[\s\S]*redactShopData/);
  assert.match(appConfig, /compliance_topics\s*=\s*\[\s*"customers\/data_request"\s*\]/);
  assert.match(appConfig, /compliance_topics\s*=\s*\[\s*"customers\/redact"\s*\]/);
  assert.match(appConfig, /compliance_topics\s*=\s*\[\s*"shop\/redact"\s*\]/);
});

test("customer privacy requests validate IDs and do not erase merchant-owned history or sessions", () => {
  assert.doesNotThrow(() => acknowledgeCustomerDataRequest(validCustomerPayload));
  assert.doesNotThrow(() => redactCustomerData({ ...validCustomerPayload, orders_to_redact: [] }));
  for (const handler of [acknowledgeCustomerDataRequest, redactCustomerData]) {
    assert.throws(() => handler({ shop_id: 987654321, customer: { id: "not-an-id" } }), { status: 400 });
    assert.throws(() => handler({}), { status: 400 });
  }
  assert.match(helperSource, /no Customer model or customer[\s\S]*identifier on ImportBatch\/ImportLine/);
  assert.match(helperSource, /must not be mistaken for customer records/);
});

test("shop redaction atomically erases scoped history, receipt counters, and sessions", async () => {
  const calls = [];
  const tx = Object.fromEntries(["activityLog", "importBatch", "importReceiptCounter", "session"].map((model) => [model, {
    async deleteMany({ where }) {
      calls.push({ model, where });
      return { count: 1 };
    },
  }]));
  let transactions = 0;
  const prisma = {
    async $transaction(callback) {
      transactions += 1;
      return callback(tx);
    },
  };

  await redactShopData(prisma, "demo.myshopify.com", { shop_id: 987654321 });
  assert.equal(transactions, 1);
  assert.deepEqual(calls, [
    { model: "activityLog", where: { shop: "demo.myshopify.com" } },
    { model: "importBatch", where: { shop: "demo.myshopify.com" } },
    { model: "importReceiptCounter", where: { shop: "demo.myshopify.com" } },
    { model: "session", where: { shop: "demo.myshopify.com" } },
  ]);
  await assert.rejects(redactShopData(prisma, "demo.myshopify.com", { shop_id: "invalid" }), { status: 400 });
  await assert.rejects(redactShopData(prisma, " bad-shop.myshopify.com", { shop_id: 987654321 }), { status: 400 });
  assert.equal(transactions, 1, "invalid payload/shop must not start a destructive transaction");
});

test("repeated shop redaction is idempotent and never targets another shop", async () => {
  const calls = [];
  let transactions = 0;
  let remaining = { activityLog: 1, importBatch: 1, importReceiptCounter: 1, session: 1 };
  const prisma = {
    async $transaction(callback) {
      transactions += 1;
      const tx = Object.fromEntries(Object.keys(remaining).map((model) => [model, {
        async deleteMany({ where }) {
          calls.push({ model, where });
          const count = remaining[model];
          remaining[model] = 0;
          return { count };
        },
      }]));
      return callback(tx);
    },
  };

  await redactShopData(prisma, "shop-a.myshopify.com", { shop_id: 987654321 });
  await redactShopData(prisma, "shop-a.myshopify.com", { shop_id: 987654321 });

  assert.equal(transactions, 2);
  assert.deepEqual(remaining, { activityLog: 0, importBatch: 0, importReceiptCounter: 0, session: 0 });
  assert.equal(calls.length, 8);
  assert.ok(calls.every(({ where }) => where.shop === "shop-a.myshopify.com"));
  assert.ok(calls.every(({ where }) => Object.keys(where).length === 1), "delete filters must not broaden beyond the authenticated shop");
});
