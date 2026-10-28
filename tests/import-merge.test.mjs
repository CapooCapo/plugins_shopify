/* eslint-env node */
import assert from "node:assert/strict";
import test from "node:test";

import { mergeImportBatch } from "../app/utils/import-merge.server.ts";

const SHOP = "demo-app-d0c6tdk6.myshopify.com";
const LOCATION_ID = "gid://shopify/Location/10";
const REPLACED_LOCATION_ID = "gid://shopify/Location/11";
const fixedNow = () => new Date("2026-10-22T04:30:00.000Z");

function makeBatch({ id = "batch-1", shop = SHOP, lines, status = "PREVIEWED" } = {}) {
  const now = fixedNow();
  return {
    id,
    shop,
    receiptCode: "IMP-20261022-000001",
    fileChecksum: "sha256-example",
    fileName: "delivery.csv",
    locationId: LOCATION_ID,
    locationName: "Main warehouse",
    currencyCode: "VND",
    status,
    revision: 0,
    actor: "merchant@example.test",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    lines,
  };
}

function makeLine({
  id = "line-1",
  batchId = "batch-1",
  rowNumber = 2,
  sku = "SKU-1",
  title = "Example product",
  description = "New item description",
  price = "250000",
  quantity = 5,
  operationType = "ADJUST",
  status = "PREVIEWED",
  stage = "PREPARED",
  expectedQuantity = operationType === "ADJUST" ? 11 : null,
} = {}) {
  const now = fixedNow();
  return {
    id,
    batchId,
    rowNumber,
    sku,
    title,
    description,
    price,
    quantity,
    operationType,
    status,
    stage,
    operationId: `operation-${id}`,
    idempotencyKey: `stockhub-${id}-stable-key`,
    productId: operationType === "ADJUST" ? "gid://shopify/Product/30" : null,
    variantId: operationType === "ADJUST" ? "gid://shopify/ProductVariant/20" : null,
    inventoryItemId: operationType === "ADJUST" ? "gid://shopify/InventoryItem/40" : null,
    expectedQuantity,
    matchedProductTitle: null,
    matchedVariantTitle: null,
    errorCode: null,
    errorDetail: null,
    shopifyProductUrl: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function matchesWhere(record, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return condition.some((entry) => matchesWhere(record, entry));
    if (key === "AND") return condition.every((entry) => matchesWhere(record, entry));
    if (key === "batch" && condition && typeof condition === "object" && "is" in condition) {
      return matchesWhere(record.batch, condition.is);
    }

    const actual = record[key];
    if (actual instanceof Date && condition instanceof Date) {
      return actual.getTime() === condition.getTime();
    }
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if ("in" in condition) return condition.in.includes(actual);
      if ("notIn" in condition) return !condition.notIn.includes(actual);
      if ("lt" in condition) return actual < condition.lt;
      if ("lte" in condition) return actual <= condition.lte;
      if ("gt" in condition) return actual > condition.gt;
      if ("gte" in condition) return actual >= condition.gte;
      if ("equals" in condition) return actual === condition.equals;
    }
    return actual === condition;
  });
}

function makePrisma({ batch, lines = batch.lines, beforeClaim, failSucceededLineUpdateOnce = false } = {}) {
  const state = {
    batch: structuredClone({ ...batch, lines: undefined }),
    lines: structuredClone(lines),
    approvals: [],
  };
  let claimHookRun = false;

  const sortRows = (rows, orderBy) => {
    if (orderBy?.rowNumber === "asc") return rows.sort((a, b) => a.rowNumber - b.rowNumber);
    if (orderBy?.rowNumber === "desc") return rows.sort((a, b) => b.rowNumber - a.rowNumber);
    return rows;
  };

  const prisma = {
    importBatch: {
      async findFirst({ where }) {
        if (!matchesWhere(state.batch, where)) return null;
        return structuredClone({ ...state.batch, lines: sortRows(state.lines, { rowNumber: "asc" }) });
      },
      async updateMany({ where, data }) {
        if (data.status === "RUNNING" && !claimHookRun) {
          claimHookRun = true;
          beforeClaim?.(state);
        }
        if (!matchesWhere(state.batch, where)) return { count: 0 };
        Object.assign(state.batch, structuredClone(data));
        return { count: 1 };
      },
      async update({ where, data }) {
        if (state.batch.id !== where.id) throw new Error("ImportBatch not found");
        Object.assign(state.batch, structuredClone(data));
        return structuredClone(state.batch);
      },
    },
    importLine: {
      async findMany({ where, orderBy }) {
        const rows = state.lines.filter((line) => matchesWhere(line, where));
        return structuredClone(sortRows(rows, orderBy));
      },
      async update({ where, data }) {
        const line = state.lines.find((candidate) => candidate.id === where.id);
        if (!line) throw new Error("ImportLine not found");
        if (failSucceededLineUpdateOnce && data.status === "SUCCEEDED") {
          failSucceededLineUpdateOnce = false;
          throw new Error("simulated Prisma write failure after Shopify accepted mutation");
        }
        Object.assign(line, structuredClone(data));
        return structuredClone(line);
      },
      async updateMany({ where, data }) {
        const selected = state.lines.filter((line) => matchesWhere({ ...line, batch: state.batch }, where));
        if (selected.length && failSucceededLineUpdateOnce && data.status === "SUCCEEDED") {
          failSucceededLineUpdateOnce = false;
          throw new Error("simulated Prisma write failure after Shopify accepted mutation");
        }
        for (const line of selected) Object.assign(line, structuredClone(data));
        return { count: selected.length };
      },
      async findUniqueOrThrow({ where }) {
        const line = state.lines.find((candidate) => matchesWhere(candidate, where));
        if (!line) throw new Error("ImportLine not found");
        return structuredClone(line);
      },
    },
    importMergeApproval: {
      async findFirst({ where }) {
        const approval = state.approvals.find((candidate) => matchesWhere(candidate, where));
        return approval ? structuredClone(approval) : null;
      },
      async create({ data }) {
        if (state.approvals.some((candidate) => candidate.id === data.id)) {
          throw new Error("ImportMergeApproval id already exists");
        }
        const approval = structuredClone(data);
        state.approvals.push(approval);
        return structuredClone(approval);
      },
      async updateMany({ where, data }) {
        const selected = state.approvals.filter((candidate) => matchesWhere(candidate, where));
        for (const approval of selected) {
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === "object" && "increment" in value) {
              approval[key] = Number(approval[key] ?? 0) + Number(value.increment);
            } else {
              approval[key] = structuredClone(value);
            }
          }
        }
        return { count: selected.length };
      },
    },
    async $transaction(callback) {
      return callback(prisma);
    },
  };

  return { prisma, state };
}

function graphQLResponse(data, { status = 200, errors } = {}) {
  return new Response(JSON.stringify({ data, ...(errors ? { errors } : {}) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAdmin({ skuResults = [], handlers = {} } = {}) {
  const calls = [];
  const admin = {
    async graphql(query, { variables }) {
      const operationName = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
      const call = { operationName, query, variables };
      calls.push(call);
      if (handlers[operationName]) return handlers[operationName](call, calls.length);

      switch (operationName) {
        case "StockHubValidateLocation":
          return graphQLResponse({
            locations: {
              nodes: [{ id: LOCATION_ID, name: "Main warehouse", isActive: true }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          });
        case "StockHubRecheckSku": {
          const nodes = typeof skuResults === "function" ? skuResults(call) : skuResults;
          return graphQLResponse({
            productVariants: {
              edges: nodes.map((node) => ({ node })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          });
        }
        case "StockHubFindDraftMarker":
          return graphQLResponse({
            productByIdentifier: null,
          });
        case "StockHubCreateDraft":
          return graphQLResponse({
            productCreate: {
              product: draftProduct(),
              userErrors: [],
            },
          });
        case "StockHubUpdateDraftInventoryItem":
          return graphQLResponse({
            inventoryItemUpdate: {
              inventoryItem: { id: "gid://shopify/InventoryItem/400", sku: "SKU-1", tracked: true },
              userErrors: [],
            },
          });
        case "StockHubSetDraftPrice":
          return graphQLResponse({
            productVariantsBulkUpdate: {
              productVariants: [{ id: "gid://shopify/ProductVariant/200", price: "250000.00" }],
              userErrors: [],
            },
          });
        case "StockHubActivateDraftInventory":
          return graphQLResponse({
            inventoryActivate: {
              inventoryLevel: { id: "gid://shopify/InventoryLevel/101" },
              userErrors: [],
            },
          });
        case "StockHubAdjustIncoming":
          return graphQLResponse({
            inventoryAdjustQuantities: {
              inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/100" },
              userErrors: [],
            },
          });
        default:
          throw new Error(`Unexpected Shopify GraphQL operation: ${operationName}`);
      }
    },
  };
  return { admin, calls };
}

function existingVariant({ sku = "SKU-1", tracked = true, stocked = true } = {}) {
  return {
    id: "gid://shopify/ProductVariant/20",
    sku,
    title: "Default Title",
    product: {
      id: "gid://shopify/Product/30",
      title: "Existing title remains unchanged",
      status: "ACTIVE",
    },
    inventoryItem: {
      id: "gid://shopify/InventoryItem/40",
      tracked,
      inventoryLevel: stocked
        ? { quantities: [{ name: "available", quantity: 11 }] }
        : null,
    },
  };
}

function draftProduct(operationId = "operation-line-1", handle = "stockhub-operation-line-1") {
  return {
    id: "gid://shopify/Product/300",
    handle,
    title: "Example product",
    status: "DRAFT",
    metafield: { value: operationId },
    variants: {
      nodes: [
        {
          id: "gid://shopify/ProductVariant/200",
          sku: "",
          price: "0.00",
          inventoryItem: { id: "gid://shopify/InventoryItem/400", tracked: false },
        },
      ],
    },
  };
}

function run(batch, admin, prisma, shop = SHOP, confirmedLineIds = batch.lines.map((line) => line.id), intent = "resume", expectedRevision = batch.revision, approvalId) {
  return mergeImportBatch({ shop, batchId: batch.id, admin, prisma, now: fixedNow, confirmedLineIds, intent, expectedRevision, approvalId });
}

test("existing SKU gets one positive incoming-stock adjustment and completed replay is a no-op", async () => {
  const line = makeLine({ quantity: 5 });
  const batch = makeBatch({ lines: [line] });
  const { prisma, state } = makePrisma({ batch });
  const { admin, calls } = makeAdmin({ skuResults: [existingVariant()] });

  const first = await run(batch, admin, prisma);
  const second = await run(batch, admin, prisma);

  const adjustments = calls.filter((call) => call.operationName === "StockHubAdjustIncoming");
  assert.equal(first.status, "COMPLETED");
  assert.equal(second.status, "COMPLETED");
  assert.equal(first.lines[0].status, "SUCCEEDED");
  assert.equal(state.lines[0].stage, "COMPLETED");
  assert.equal(adjustments.length, 1, "successful lines must never execute again");
  assert.match(adjustments[0].query, /inventoryAdjustQuantities[\s\S]*@idempotent\(key:\s*\$key\)/);
  assert.equal(adjustments[0].variables.key, line.idempotencyKey);
  assert.equal(adjustments[0].variables.input.changes[0].delta, 5);
  assert.equal(adjustments[0].variables.input.changes[0].changeFromQuantity, 11);
  assert.equal(adjustments[0].variables.input.changes[0].locationId, LOCATION_ID);
  assert.equal(adjustments[0].variables.input.changes[0].inventoryItemId, "gid://shopify/InventoryItem/40");
  assert.equal(calls.some((call) => call.operationName === "StockHubCreateDraft"), false);
  assert.equal(calls.some((call) => call.operationName === "StockHubUpdateDraftInventoryItem"), false);
  assert.equal(adjustments[0].variables.input.changes[0].delta, 5);
  assert.equal(
    JSON.stringify(adjustments[0].variables).includes("Existing title remains unchanged"),
    false,
    "existing title/description/price/status must not be sent to a mutation",
  );
  assert.equal(first.lines[0].shopifyProductUrl, `https://${SHOP}/admin/products/30`);
});

test("an exact SKU retargeted to a different variant after preview cannot adjust another inventory item", async () => {
  const line = makeLine({ quantity: 5 });
  line.productId = "gid://shopify/Product/30";
  line.variantId = "gid://shopify/ProductVariant/20";
  line.inventoryItemId = "gid://shopify/InventoryItem/40";
  const batch = makeBatch({ lines: [line] });
  const { prisma } = makePrisma({ batch });
  const replacement = {
    ...existingVariant(),
    id: "gid://shopify/ProductVariant/99",
    product: { id: "gid://shopify/Product/99", title: "Different product", status: "ACTIVE" },
    inventoryItem: {
      id: "gid://shopify/InventoryItem/99",
      tracked: true,
      inventoryLevel: { quantities: [{ name: "available", quantity: 11 }] },
    },
  };
  const { admin, calls } = makeAdmin({ skuResults: [replacement] });

  const result = await run(batch, admin, prisma);

  assert.equal(result.status, "FAILED");
  assert.equal(result.lines[0].status, "BLOCKED");
  assert.equal(result.lines[0].errorCode, "SKU_TARGET_CHANGED");
  assert.equal(calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length, 0);
});

test("new SKU is created as Draft, configured, and activated at the selected location", async () => {
  const line = makeLine({ operationType: "CREATE_DRAFT", quantity: 7 });
  const batch = makeBatch({ lines: [line] });
  const { prisma, state } = makePrisma({ batch });
  const { admin, calls } = makeAdmin();

  const result = await run(batch, admin, prisma);
  const create = calls.find((call) => call.operationName === "StockHubCreateDraft");
  const inventoryItemUpdate = calls.find((call) => call.operationName === "StockHubUpdateDraftInventoryItem");
  const priceUpdate = calls.find((call) => call.operationName === "StockHubSetDraftPrice");
  const activate = calls.find((call) => call.operationName === "StockHubActivateDraftInventory");

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.lines[0].status, "SUCCEEDED");
  assert.equal(state.lines[0].productId, "gid://shopify/Product/300");
  assert.equal(state.lines[0].variantId, "gid://shopify/ProductVariant/200");
  assert.equal(state.lines[0].inventoryItemId, "gid://shopify/InventoryItem/400");
  assert.equal(state.lines[0].shopifyProductUrl, `https://${SHOP}/admin/products/300`);
  assert.equal(create.variables.product.status, "DRAFT");
  assert.equal(create.variables.product.title, line.title);
  assert.equal(create.variables.product.handle, "stockhub-operation-line-1");
  assert.deepEqual(create.variables.product.metafields, [{
    namespace: "$app",
    key: "stockhub_import_operation",
    type: "single_line_text_field",
    value: line.operationId,
  }]);
  assert.match(create.query, /productCreate/);
  assert.doesNotMatch(create.query, /publishablePublish/);
  assert.equal(inventoryItemUpdate.variables.id, "gid://shopify/InventoryItem/400");
  assert.deepEqual(inventoryItemUpdate.variables.input, { sku: line.sku, tracked: true });
  assert.equal(priceUpdate.variables.productId, "gid://shopify/Product/300");
  assert.equal(priceUpdate.variables.variantId, "gid://shopify/ProductVariant/200");
  assert.equal(priceUpdate.variables.price, line.price);
  assert.equal(activate.variables.inventoryItemId, "gid://shopify/InventoryItem/400");
  assert.equal(activate.variables.locationId, LOCATION_ID);
  assert.equal(activate.variables.quantity, line.quantity);
  assert.match(activate.query, /inventoryActivate[\s\S]*@idempotent\(key:\s*\$key\)/);
  assert.match(activate.query, /available:\s*\$quantity/);
  assert.doesNotMatch(activate.query, /onHand\s*:/, "activation must set available only; onHand is derived and must not be set too");
});

test("ambiguous exact SKU is blocked without an inventory mutation", async () => {
  const batch = makeBatch({ lines: [makeLine()] });
  const { prisma, state } = makePrisma({ batch });
  const { admin, calls } = makeAdmin({ skuResults: [existingVariant(), { ...existingVariant(), id: "gid://shopify/ProductVariant/21" }] });

  const result = await run(batch, admin, prisma);

  assert.equal(result.lines[0].status, "BLOCKED");
  assert.equal(result.lines[0].errorCode, "SKU_MATCH_CHANGED");
  assert.equal(state.lines[0].status, "BLOCKED");
  assert.equal(calls.some((call) => call.operationName === "StockHubAdjustIncoming"), false);
});

test("untracked existing SKU and unauthorized location are safely blocked", async (t) => {
  await t.test("untracked inventory", async () => {
    const batch = makeBatch({ lines: [makeLine()] });
    const { prisma } = makePrisma({ batch });
    const { admin, calls } = makeAdmin({ skuResults: [existingVariant({ tracked: false })] });

    const result = await run(batch, admin, prisma);

    assert.equal(result.lines[0].status, "BLOCKED");
    assert.equal(result.lines[0].errorCode, "INVENTORY_NOT_TRACKED");
    assert.equal(calls.some((call) => call.operationName === "StockHubAdjustIncoming"), false);
  });

  await t.test("unstocked inventory is not activated implicitly", async () => {
    const batch = makeBatch({ lines: [makeLine()] });
    const { prisma } = makePrisma({ batch });
    const { admin, calls } = makeAdmin({ skuResults: [existingVariant({ stocked: false })] });

    const result = await run(batch, admin, prisma);

    assert.equal(result.lines[0].status, "BLOCKED");
    assert.equal(result.lines[0].errorCode, "LOCATION_NOT_STOCKED");
    assert.equal(calls.some((call) => call.operationName === "StockHubAdjustIncoming"), false);
    assert.equal(calls.some((call) => call.operationName === "StockHubActivateDraftInventory"), false);
  });

  await t.test("location belongs to another or inactive scope", async () => {
    const batch = makeBatch({ lines: [makeLine()] });
    const { prisma, state } = makePrisma({ batch });
    const { admin, calls } = makeAdmin({
      handlers: {
        StockHubValidateLocation: () => graphQLResponse({
          locations: {
            nodes: [{ id: "gid://shopify/Location/other", name: "Other store", isActive: true }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      },
    });

    const result = await run(batch, admin, prisma);

    assert.equal(result.status, "FAILED");
    assert.equal(result.lines[0].status, "BLOCKED");
    assert.equal(result.lines[0].errorCode, "LOCATION_NOT_AUTHORIZED");
    assert.equal(state.lines[0].status, "BLOCKED");
    assert.equal(calls.some((call) => call.operationName === "StockHubRecheckSku"), false);
  });
});

test("wrong authenticated store cannot execute another store's batch", async () => {
  const batch = makeBatch({ lines: [makeLine()] });
  const { prisma } = makePrisma({ batch });
  const { admin, calls } = makeAdmin();

  await assert.rejects(
    run(batch, admin, prisma, "other-shop.myshopify.com"),
    (error) => error.code === "BATCH_NOT_FOUND",
  );
  assert.equal(calls.length, 0);
});

test("network timeout is uncertain and a manual retry reuses the persisted idempotency key", async () => {
  const line = makeLine({ quantity: 3 });
  const batch = makeBatch({ lines: [line] });
  const { prisma, state } = makePrisma({ batch });
  let adjustmentAttempts = 0;
  const { admin, calls } = makeAdmin({
    skuResults: [existingVariant()],
    handlers: {
      StockHubAdjustIncoming() {
        adjustmentAttempts += 1;
        if (adjustmentAttempts === 1) throw new Error("socket timed out after request send");
        return graphQLResponse({
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/101" },
            userErrors: [],
          },
        });
      },
    },
  });

  const first = await run(batch, admin, prisma);
  assert.equal(first.status, "UNCERTAIN");
  assert.equal(first.batchId, batch.id);
  assert.equal(first.lines[0].status, "UNCERTAIN");
  assert.equal(calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length, 1);
  assert.equal(state.lines[0].idempotencyKey, line.idempotencyKey);

  const second = await run(batch, admin, prisma);
  const adjustments = calls.filter((call) => call.operationName === "StockHubAdjustIncoming");
  assert.equal(second.status, "COMPLETED");
  assert.equal(second.batchId, first.batchId);
  assert.deepEqual(adjustments.map((call) => call.variables.key), [line.idempotencyKey, line.idempotencyKey]);
  assert.deepEqual(
    adjustments.map((call) => call.variables.input.referenceDocumentUri),
    [
      `stockhub://receipt/${encodeURIComponent(batch.receiptCode)}/line/${line.operationId}`,
      `stockhub://receipt/${encodeURIComponent(batch.receiptCode)}/line/${line.operationId}`,
    ],
    "retry must retain the same batch receipt code and line operation identity",
  );
  assert.deepEqual(
    adjustments.map((call) => call.variables.input.changes[0].changeFromQuantity),
    [line.expectedQuantity, line.expectedQuantity],
    "an uncertain retry must reuse the persisted CAS baseline",
  );
  assert.equal(state.lines[0].status, "SUCCEEDED");
});

test("an old uncertain inventory adjustment does not replay after the idempotency retention window", async () => {
  const line = makeLine({ quantity: 3, status: "UNCERTAIN", stage: "INVENTORY_ADJUSTING" });
  line.productId = "gid://shopify/Product/30";
  line.variantId = "gid://shopify/ProductVariant/20";
  line.inventoryItemId = "gid://shopify/InventoryItem/40";
  line.createdAt = new Date("2026-10-20T04:29:00.000Z");
  // A later status update must not make an old, possibly accepted API attempt fresh.
  line.updatedAt = fixedNow();
  const batch = makeBatch({ lines: [line], status: "UNCERTAIN" });
  const { prisma } = makePrisma({ batch });
  const { admin, calls } = makeAdmin({ skuResults: [existingVariant()] });

  const result = await run(batch, admin, prisma);

  assert.equal(result.status, "UNCERTAIN");
  assert.equal(result.lines[0].status, "UNCERTAIN");
  assert.match(result.lines[0].errorDetail ?? "", /reconcil|manual|expired|unknown/i);
  assert.equal(calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length, 0);
});

test("a lost location does not erase an uncertain prior inventory adjustment", async () => {
  const line = makeLine({ status: "UNCERTAIN", stage: "INVENTORY_ADJUSTING" });
  const batch = makeBatch({ lines: [line], status: "UNCERTAIN" });
  const { prisma, state } = makePrisma({ batch });
  const { admin, calls } = makeAdmin({
    handlers: {
      StockHubValidateLocation() {
        return graphQLResponse({
          locations: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      },
    },
  });

  const result = await run(batch, admin, prisma);

  assert.equal(result.status, "UNCERTAIN");
  assert.equal(result.lines[0].status, "UNCERTAIN");
  assert.equal(state.lines[0].stage, "INVENTORY_ADJUSTING");
  assert.match(result.lines[0].errorDetail ?? "", /location|reconcil/i);
  assert.equal(calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length, 0);
});

test("a Draft SKU that appeared after preview is blocked before product creation", async () => {
  const batch = makeBatch({ lines: [makeLine({ operationType: "CREATE_DRAFT" })] });
  const { prisma } = makePrisma({ batch });
  const { admin, calls } = makeAdmin({ skuResults: [existingVariant()] });

  const result = await run(batch, admin, prisma);

  assert.equal(result.lines[0].status, "BLOCKED");
  assert.equal(result.lines[0].errorCode, "SKU_NO_LONGER_UNMATCHED");
  assert.equal(calls.some((call) => call.operationName === "StockHubCreateDraft"), false);
});

test("uncertain productCreate is reconciled before retry and never blindly repeated", async () => {
  const line = makeLine({ operationType: "CREATE_DRAFT" });
  const batch = makeBatch({ lines: [line] });
  const { prisma, state } = makePrisma({ batch });
  let createAttempts = 0;
  const { admin, calls } = makeAdmin({
    handlers: {
      StockHubCreateDraft() {
        createAttempts += 1;
        throw new Error("connection closed after Shopify accepted the request");
      },
    },
  });

  const first = await run(batch, admin, prisma);
  assert.equal(first.lines[0].status, "UNCERTAIN");
  assert.equal(state.lines[0].stage, "PRODUCT_CREATING");

  const second = await run(batch, admin, prisma);
  assert.equal(second.lines[0].status, "UNCERTAIN");
  assert.equal(second.lines[0].errorCode, "PRODUCT_CREATE_UNCONFIRMED");
  assert.equal(createAttempts, 1);
  assert.equal(calls.filter((call) => call.operationName === "StockHubFindDraftMarker").length, 1);
});

test("a Draft found with the matching operation marker is reconciled instead of recreated", async () => {
  const line = makeLine({ operationType: "CREATE_DRAFT" });
  const batch = makeBatch({ lines: [line] });
  const { prisma, state } = makePrisma({ batch });
  let createAttempts = 0;
  let reconciliationAttempts = 0;
  const { admin, calls } = makeAdmin({
    handlers: {
      StockHubCreateDraft() {
        createAttempts += 1;
        throw new Error("response lost after create reached Shopify");
      },
      StockHubFindDraftMarker() {
        reconciliationAttempts += 1;
        return graphQLResponse({
          productByIdentifier: draftProduct(line.operationId),
        });
      },
    },
  });

  const first = await run(batch, admin, prisma);
  assert.equal(first.lines[0].status, "UNCERTAIN");
  const second = await run(batch, admin, prisma);

  assert.equal(second.lines[0].status, "SUCCEEDED");
  assert.equal(state.lines[0].productId, "gid://shopify/Product/300");
  assert.equal(createAttempts, 1);
  assert.equal(reconciliationAttempts, 1);
  assert.equal(calls.filter((call) => call.operationName === "StockHubUpdateDraftInventoryItem").length, 1);
  assert.equal(calls.filter((call) => call.operationName === "StockHubSetDraftPrice").length, 1);
  assert.equal(calls.filter((call) => call.operationName === "StockHubActivateDraftInventory").length, 1);
  const markerLookup = calls.find((call) => call.operationName === "StockHubFindDraftMarker");
  assert.deepEqual(markerLookup.variables.identifier, { handle: "stockhub-operation-line-1" });
  assert.match(markerLookup.query, /productByIdentifier\(identifier: \$identifier\)/);
  assert.match(markerLookup.query, /metafield\(namespace: "\$app", key: "stockhub_import_operation"\)/);
});

test("a Draft with a mismatched operation marker is never mutated during reconciliation", async () => {
  const line = makeLine({ operationType: "CREATE_DRAFT" });
  const batch = makeBatch({ lines: [line] });
  const { prisma } = makePrisma({ batch });
  const { admin, calls } = makeAdmin({
    handlers: {
      StockHubCreateDraft() {
        throw new Error("response lost after create reached Shopify");
      },
      StockHubFindDraftMarker() {
        return graphQLResponse({
          productByIdentifier: draftProduct("another-operation", "stockhub-operation-line-1"),
        });
      },
    },
  });

  const first = await run(batch, admin, prisma);
  assert.equal(first.lines[0].status, "UNCERTAIN");
  const second = await run(batch, admin, prisma);

  assert.equal(second.lines[0].status, "BLOCKED");
  assert.equal(second.lines[0].errorCode, "DRAFT_HANDLE_COLLISION");
  assert.equal(calls.filter((call) => call.operationName === "StockHubCreateDraft").length, 1);
  assert.equal(calls.filter((call) => call.operationName === "StockHubUpdateDraftInventoryItem").length, 0);
  assert.equal(calls.filter((call) => call.operationName === "StockHubSetDraftPrice").length, 0);
  assert.equal(calls.filter((call) => call.operationName === "StockHubActivateDraftInventory").length, 0);
});

test("a concurrent duplicate submission cannot claim a RUNNING batch", async () => {
  const batch = makeBatch({ lines: [makeLine()] });
  const { prisma } = makePrisma({ batch });
  let enteredLocationLookup;
  const locationLookupEntered = new Promise((resolve) => {
    enteredLocationLookup = resolve;
  });
  let releaseLocationLookup;
  const locationLookupResult = new Promise((resolve) => {
    releaseLocationLookup = resolve;
  });
  const { admin, calls } = makeAdmin({
    skuResults: [existingVariant()],
    handlers: {
      StockHubValidateLocation() {
        enteredLocationLookup();
        return locationLookupResult;
      },
    },
  });

  const firstRun = run(batch, admin, prisma);
  await locationLookupEntered;
  await assert.rejects(
    run(batch, admin, prisma),
    (error) => error.code === "BATCH_ALREADY_RUNNING",
  );
  releaseLocationLookup(graphQLResponse({
    locations: {
      nodes: [{ id: LOCATION_ID, name: "Main warehouse", isActive: true }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  }));
  const result = await firstRun;

  assert.equal(result.status, "COMPLETED");
  assert.equal(calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length, 1);
});

test("a preview replacement after confirmation is not dispatched until it receives a fresh confirmation", async () => {
  const staleLine = makeLine({ id: "stale-line", sku: "SKU-OLD", quantity: 2 });
  const replacementLine = makeLine({ id: "replacement-line", sku: "SKU-NEW", quantity: 7 });
  const batch = makeBatch({ lines: [staleLine] });
  const { prisma, state } = makePrisma({
    batch,
    beforeClaim(current) {
      // Model a preview replacement that wins immediately before the RUNNING claim.
      current.batch.locationId = REPLACED_LOCATION_ID;
      current.batch.locationName = "Replacement warehouse";
      current.batch.revision += 1;
      current.lines.splice(0, current.lines.length, structuredClone(replacementLine));
    },
  });
  const { admin, calls } = makeAdmin({
    handlers: {
      StockHubValidateLocation: () => graphQLResponse({
        locations: {
          nodes: [
            { id: LOCATION_ID, name: "Main warehouse", isActive: true },
            { id: REPLACED_LOCATION_ID, name: "Replacement warehouse", isActive: true },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }),
      StockHubRecheckSku(call) {
        const sku = call.variables.query.includes("SKU-NEW") ? "SKU-NEW" : "SKU-OLD";
        return graphQLResponse({
          productVariants: {
            edges: [{ node: existingVariant({ sku }) }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      },
    },
  });

  await assert.rejects(
    run(batch, admin, prisma, SHOP, [staleLine.id], "merge", 0),
    /confirm|changed|eligible|missing/i,
    "the claimed snapshot no longer contains the exact line ID the merchant confirmed",
  );
  assert.equal(calls.length, 0, "a replacement row must not inherit the stale confirmation");
  assert.equal(state.lines[0].id, replacementLine.id);
  assert.equal(state.lines[0].status, "PREVIEWED");

  const freshConfirmation = await run(batch, admin, prisma, SHOP, [replacementLine.id], "merge", 1);
  assert.equal(freshConfirmation.status, "COMPLETED");
  assert.equal(freshConfirmation.lines[0].sku, "SKU-NEW");
  assert.equal(state.lines[0].status, "SUCCEEDED");
  const skuLookup = calls.find((call) => call.operationName === "StockHubRecheckSku");
  assert.equal(skuLookup.variables.query, 'sku:"SKU-NEW"');
  assert.equal(skuLookup.variables.locationId, REPLACED_LOCATION_ID);
  const adjustment = calls.find((call) => call.operationName === "StockHubAdjustIncoming");
  assert.equal(adjustment.variables.input.changes[0].delta, 7);
  assert.equal(adjustment.variables.input.changes[0].locationId, REPLACED_LOCATION_ID);
});

test("rows appended after confirmation remain untouched until separately confirmed", async () => {
  const initialLine = makeLine({ id: "initial-line" });
  const batch = makeBatch({ lines: [initialLine] });
  const appendedLines = Array.from({ length: 51 }, (_, index) => makeLine({
    id: `replacement-line-${index + 1}`,
    rowNumber: index + 2,
    sku: `SKU-${index + 1}`,
  }));
  const { prisma, state } = makePrisma({
    batch,
    beforeClaim(current) {
      current.lines.push(...structuredClone(appendedLines));
      current.batch.revision += 1;
    },
  });
  const { admin, calls } = makeAdmin({
    skuResults(call) {
      const sku = call.variables.query.match(/sku:\\?"([^"]+)/)?.[1];
      return [existingVariant({ sku })];
    },
  });

  await assert.rejects(
    run(batch, admin, prisma, SHOP, [initialLine.id], "merge", 0),
    /revision|changed|confirm/i,
    "new eligible rows after confirmation invalidate the entire approval snapshot before dispatch",
  );
  assert.equal(state.lines.length, 52);
  assert.ok(state.lines.every((line) => line.status === "PREVIEWED"),
    "a changed snapshot leaves all rows untouched until a fresh approval");
  assert.equal(calls.length, 0, "the stale initial approval must make no Shopify call");

  const approvedSnapshot = [...state.lines].map((line) => line.id);
  const nextConfirmation = await run(batch, admin, prisma, SHOP, approvedSnapshot, "merge", 1);
  assert.equal(nextConfirmation.lines.filter((line) => line.status === "SUCCEEDED").length, 50,
    "the fresh approval includes appended rows but the service still bounds each chunk at 50");
  assert.equal(calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length, 50);
  assert.equal(state.lines.filter((line) => line.status === "PREVIEWED").length, 2);
});

test("one 1,000-line confirmation advances its persisted snapshot in ≤50-line chunks without replaying successes", async () => {
  const lines = Array.from({ length: 1000 }, (_, index) => makeLine({
    id: `capacity-line-${String(index + 1).padStart(4, "0")}`,
    batchId: "capacity-batch",
    rowNumber: index + 2,
    sku: `CAP-${String(index + 1).padStart(4, "0")}`,
    quantity: 2,
  }));
  const batch = makeBatch({ id: "capacity-batch", lines });
  const { prisma, state } = makePrisma({ batch });
  const { admin, calls } = makeAdmin({
    skuResults(call) {
      const sku = call.variables.query.match(/sku:\\?"([^"]+)/)?.[1];
      assert.ok(sku, `expected exact SKU lookup, got ${call.variables.query}`);
      return [existingVariant({ sku })];
    },
  });
  const lineIds = lines.map((line) => line.id);

  let attempt = 1;
  let result = await mergeImportBatch({
    shop: SHOP,
    batchId: batch.id,
    admin,
    prisma,
    now: fixedNow,
    intent: "merge",
    expectedRevision: batch.revision,
    confirmedLineIds: lineIds,
  });
  const approvalId = result.approvalId;
  assert.ok(approvalId, "the initial merchant confirmation must create a durable approval identity");
  assert.equal(result.chunkNumber, 1);
  assert.equal(result.continueRequired, true);
  assert.equal(result.approvalStatus, "ACTIVE");

  while (result.continueRequired && attempt < 20) {
    const beforeSuccessCount = state.lines.filter((line) => line.status === "SUCCEEDED").length;
    const beforeAdjustmentCount = calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length;
    result = await mergeImportBatch({
      shop: SHOP,
      batchId: batch.id,
      admin,
      prisma,
      now: fixedNow,
      intent: "continue",
      approvalId,
    });
    attempt += 1;

    const afterSuccessCount = state.lines.filter((line) => line.status === "SUCCEEDED").length;
    const afterAdjustmentCount = calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length;
    const newlyCompleted = afterSuccessCount - beforeSuccessCount;
    assert.ok(newlyCompleted > 0, `bounded chunk ${attempt} must make persisted progress`);
    assert.ok(newlyCompleted <= 50, `chunk ${attempt} completed ${newlyCompleted} lines, above the 50-line service bound`);
    assert.equal(afterAdjustmentCount - beforeAdjustmentCount, newlyCompleted,
      "each persisted success in this confirmed chunk has one corresponding inventory mutation");
    assert.equal(result.approvalId, approvalId, "every continuation is bound to the original approval");
    assert.equal(result.chunkNumber, attempt, "chunk order is monotonic and persisted");
    assert.equal(result.lines.length, 1000, "the full receipt remains visible after every chunk");
    assert.equal(result.lines[0].rowNumber, 2);
    assert.equal(result.lines.at(-1).rowNumber, 1001);
  }

  assert.equal(attempt, 20, "one merchant confirmation must auto-advance through twenty bounded chunks");
  assert.equal(result.continueRequired, false);
  assert.equal(result.approvalStatus, "COMPLETED");
  assert.ok(state.lines.every((line) => line.status === "SUCCEEDED"));
  const writesBeforeReplay = calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length;
  const replay = await mergeImportBatch({
    shop: SHOP,
    batchId: batch.id,
    admin,
    prisma,
    now: fixedNow,
    intent: "continue",
    approvalId,
  });
  assert.equal(replay.status, "COMPLETED");
  assert.equal(replay.approvalStatus, "COMPLETED");
  assert.equal(calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length, writesBeforeReplay,
    "replaying a successful chunk must not redispatch any completed line");
  assert.equal(writesBeforeReplay, 1000);
});

test("a Pause accepted during an active chunk lets that chunk finish but prevents the next chunk", async () => {
  const lines = Array.from({ length: 51 }, (_, index) => makeLine({
    id: `pause-line-${String(index + 1).padStart(3, "0")}`,
    batchId: "pause-batch",
    rowNumber: index + 2,
    sku: `PAUSE-${String(index + 1).padStart(3, "0")}`,
  }));
  const batch = makeBatch({ id: "pause-batch", lines });
  const { prisma, state } = makePrisma({ batch });
  const { admin, calls } = makeAdmin({
    skuResults(call) {
      const sku = call.variables.query.match(/sku:\\?"([^"]+)/)?.[1];
      return [existingVariant({ sku })];
    },
    handlers: {
      StockHubValidateLocation() {
        // This is the deterministic interleaving: the route's independent
        // Pause action wins after the chunk has claimed the batch but before
        // its operations finish.
        assert.equal(state.approvals.length, 1);
        state.approvals[0].status = "PAUSED";
        return graphQLResponse({ locations: {
          nodes: [{ id: LOCATION_ID, name: "Main warehouse", isActive: true }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } });
      },
    },
  });

  const firstChunk = await run(batch, admin, prisma, SHOP, lines.map((line) => line.id), "merge", 0);
  assert.equal(firstChunk.approvalStatus, "PAUSED",
    "the chunk completion CAS must preserve a Pause accepted while its worker was active");
  assert.equal(firstChunk.continueRequired, false);
  assert.equal(firstChunk.lines.filter((line) => line.status === "SUCCEEDED").length, 50,
    "the already-running bounded chunk may finish; pause is not a rollback");
  assert.equal(firstChunk.lines.filter((line) => line.status === "PREVIEWED").length, 1,
    "no next chunk may start after the accepted pause");
  assert.equal(state.approvals[0].processedCount, 50);

  const writesAtPause = calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length;
  await assert.rejects(
    mergeImportBatch({ shop: SHOP, batchId: batch.id, admin, prisma, now: fixedNow, intent: "continue", approvalId: firstChunk.approvalId }),
    (error) => error.code === "APPROVAL_PAUSED",
    "automatic continuation cannot advance a paused approval; only an explicit resume control may reactivate it",
  );
  assert.equal(calls.filter((call) => call.operationName === "StockHubAdjustIncoming").length, writesAtPause);
});

test("UNKNOWN stops automatic continuation; only explicit Resume can reconcile it", async () => {
  const unknownLine = makeLine({ id: "unknown-in-first-chunk", sku: "UNKNOWN-1" });
  const completedLine = makeLine({ id: "known-in-first-chunk", sku: "KNOWN-1" });
  const batch = makeBatch({ lines: [unknownLine, completedLine] });
  const { prisma, state } = makePrisma({ batch });
  let unknownLookups = 0;
  const { admin, calls } = makeAdmin({
    skuResults(call) {
      const sku = call.variables.query.match(/sku:\\?"([^"]+)/)?.[1];
      if (sku === unknownLine.sku && ++unknownLookups > 1) {
        const replacement = existingVariant({ sku });
        replacement.id = "gid://shopify/ProductVariant/999";
        replacement.product.id = "gid://shopify/Product/999";
        replacement.inventoryItem.id = "gid://shopify/InventoryItem/999";
        return [replacement];
      }
      return [existingVariant({ sku })];
    },
    handlers: {
      StockHubAdjustIncoming(call) {
        if (call.variables.key === unknownLine.idempotencyKey) {
          throw new Error("Simulated timeout with unknown Shopify outcome");
        }
        return graphQLResponse({
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/100" },
            userErrors: [],
          },
        });
      },
    },
  });

  const initial = await run(batch, admin, prisma, SHOP, [unknownLine.id, completedLine.id], "merge", 0);
  const approvalId = initial.approvalId;
  assert.ok(approvalId);
  assert.equal(initial.lines.find((line) => line.id === unknownLine.id).status, "UNCERTAIN");
  assert.equal(initial.lines.find((line) => line.id === completedLine.id).status, "SUCCEEDED");
  assert.equal(initial.approvalStatus, "STOPPED");
  assert.equal(initial.continueRequired, false,
    "an uncertain result prevents the 1-click automatic flow from entering another chunk");
  const unknownWritesBeforeContinuation = calls.filter((call) =>
    call.operationName === "StockHubAdjustIncoming" && call.variables.key === unknownLine.idempotencyKey).length;

  const automaticContinuation = await mergeImportBatch({
    shop: SHOP, batchId: batch.id, admin, prisma, now: fixedNow,
    intent: "continue", approvalId,
  });
  assert.equal(automaticContinuation.approvalStatus, "STOPPED");
  assert.equal(calls.filter((call) => call.operationName === "StockHubAdjustIncoming" && call.variables.key === unknownLine.idempotencyKey).length,
    unknownWritesBeforeContinuation,
    "replaying automatic continuation after UNKNOWN must not redispatch the unknown operation");

  const explicitResume = await run(batch, admin, prisma, SHOP, [unknownLine.id], "resume", 0);
  assert.notEqual(explicitResume.lines.find((line) => line.id === unknownLine.id).status, "SUCCEEDED",
    "Resume must not report a different Shopify variant as a successful reconciliation");
  assert.equal(calls.filter((call) => call.operationName === "StockHubRecheckSku" && call.variables.query.includes(unknownLine.sku)).length, 2,
    "explicit Resume performs a fresh Shopify lookup before deciding whether a retry is safe");
  assert.equal(calls.filter((call) => call.operationName === "StockHubAdjustIncoming" && call.variables.key === unknownLine.idempotencyKey).length,
    unknownWritesBeforeContinuation,
    "a retry is not sent when reconciliation discovers a different variant target");
  assert.notEqual(state.lines.find((line) => line.id === unknownLine.id).status, "SUCCEEDED");
});

test("partial failure preserves successful lines and resumes only unfinished rows", async () => {
  const firstLine = makeLine({ id: "line-1", rowNumber: 2, sku: "SKU-1", quantity: 2 });
  const secondLine = makeLine({ id: "line-2", rowNumber: 3, sku: "SKU-2", quantity: 4 });
  const batch = makeBatch({ lines: [firstLine, secondLine] });
  const { prisma, state } = makePrisma({ batch });
  let secondAdjustmentAttempts = 0;
  const { admin, calls } = makeAdmin({
    skuResults: (call) => [existingVariant({ sku: call.variables.query.includes("SKU-2") ? "SKU-2" : "SKU-1" })],
    handlers: {
      StockHubAdjustIncoming(call) {
        if (call.variables.input.changes[0].inventoryItemId === "gid://shopify/InventoryItem/40") {
          if (call.variables.input.referenceDocumentUri.includes("operation-line-2")) {
            secondAdjustmentAttempts += 1;
            if (secondAdjustmentAttempts === 1) {
              return graphQLResponse({
                inventoryAdjustQuantities: {
                  inventoryAdjustmentGroup: null,
                  userErrors: [{ field: ["input"], message: "temporary Shopify rejection", code: "INTERNAL_ERROR" }],
                },
              });
            }
          }
        }
        return graphQLResponse({
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: { id: `gid://shopify/InventoryAdjustmentGroup/${calls.length}` },
            userErrors: [],
          },
        });
      },
    },
  });

  const first = await run(batch, admin, prisma);
  assert.equal(first.status, "PARTIAL");
  assert.equal(state.lines.find((line) => line.id === "line-1").status, "SUCCEEDED");
  assert.equal(state.lines.find((line) => line.id === "line-2").status, "FAILED");

  const second = await run(batch, admin, prisma);
  const adjustments = calls.filter((call) => call.operationName === "StockHubAdjustIncoming");
  assert.equal(second.status, "COMPLETED");
  assert.equal(adjustments.length, 3, "two attempts for row 3; successful row 2 is not rerun");
  assert.equal(adjustments.filter((call) => call.variables.input.referenceDocumentUri.includes("operation-line-1")).length, 1);
  assert.equal(state.lines.every((line) => line.status === "SUCCEEDED"), true);
});

test("pre-blocked invalid rows never reach Shopify mutations", async () => {
  const line = makeLine({ operationType: "BLOCKED", status: "BLOCKED", errorCode: "INVALID_ROW" });
  const batch = makeBatch({ lines: [line] });
  const { prisma } = makePrisma({ batch });
  const { admin, calls } = makeAdmin();

  const result = await run(batch, admin, prisma);

  assert.equal(result.status, "FAILED");
  assert.equal(result.lines[0].status, "BLOCKED");
  assert.equal(calls.some((call) => call.operationName !== "StockHubValidateLocation"), false);
});

test("explicit partial merge processes eligible rows while retaining blocked rows", async () => {
  const ready = makeLine({ id: "line-ready", sku: "SKU-1" });
  const blocked = makeLine({ id: "line-blocked", rowNumber: 3, sku: "BAD-SKU", operationType: "BLOCKED", status: "BLOCKED", errorCode: "CSV_INVALID_ROW" });
  const batch = makeBatch({ lines: [ready, blocked] });
  const { prisma, state } = makePrisma({ batch });
  const { admin, calls } = makeAdmin({ skuResults: [existingVariant()] });

  const result = await run(batch, admin, prisma);

  assert.equal(result.status, "PARTIAL");
  assert.equal(state.lines.find((line) => line.id === "line-ready").status, "SUCCEEDED");
  assert.equal(state.lines.find((line) => line.id === "line-blocked").status, "BLOCKED");
  assert.equal(calls.some((call) => call.operationName === "StockHubAdjustIncoming"), true);
});

test("batch status reflects verified 10/10, 0/10, and 7/10 line outcomes", async (t) => {
  for (const { label, successes, expectedBatchStatus, expectedLineStatus } of [
    { label: "10 of 10 succeed", successes: 10, expectedBatchStatus: "COMPLETED", expectedLineStatus: "SUCCEEDED" },
    { label: "0 of 10 succeed", successes: 0, expectedBatchStatus: "FAILED", expectedLineStatus: "FAILED" },
    { label: "7 of 10 succeed", successes: 7, expectedBatchStatus: "PARTIAL", expectedLineStatus: null },
  ]) {
    await t.test(label, async () => {
      const lines = Array.from({ length: 10 }, (_, index) => makeLine({
        id: `line-${index + 1}`,
        sku: `SKU-${index + 1}`,
      }));
      const batch = makeBatch({ lines });
      const { prisma, state } = makePrisma({ batch });
      const { admin } = makeAdmin({
        handlers: {
          StockHubRecheckSku(call) {
            const index = Number(call.variables.query.match(/SKU-(\d+)/)?.[1] ?? 0);
            const sku = `SKU-${index}`;
            const variant = existingVariant({ sku });
            variant.id = `gid://shopify/ProductVariant/${20 + index}`;
            variant.product.id = `gid://shopify/Product/${30 + index}`;
            variant.inventoryItem.id = `gid://shopify/InventoryItem/${40 + index}`;
            return graphQLResponse({ productVariants: { edges: [{ node: variant }], pageInfo: { hasNextPage: false, endCursor: null } } });
          },
          StockHubAdjustIncoming(call) {
            const index = Number(call.variables.input.referenceDocumentUri.match(/operation-line-(\d+)/)?.[1] ?? 0);
            if (index > successes) {
              return graphQLResponse({
                inventoryAdjustQuantities: {
                  inventoryAdjustmentGroup: null,
                  userErrors: [{ field: ["input"], message: "rejected for regression", code: "INVALID" }],
                },
              });
            }
            return graphQLResponse({
              inventoryAdjustQuantities: {
                inventoryAdjustmentGroup: { id: `gid://shopify/InventoryAdjustmentGroup/${index}` },
                userErrors: [],
              },
            });
          },
        },
      });

      // Preview snapshots must identify the same Shopify target returned by recheck.
      for (let index = 1; index <= 10; index += 1) {
        const line = state.lines[index - 1];
        line.productId = `gid://shopify/Product/${30 + index}`;
        line.variantId = `gid://shopify/ProductVariant/${20 + index}`;
        line.inventoryItemId = `gid://shopify/InventoryItem/${40 + index}`;
      }

      const result = await run(batch, admin, prisma);
      assert.equal(result.status, expectedBatchStatus);
      if (expectedLineStatus) {
        assert.equal(state.lines.every((line) => line.status === expectedLineStatus), true);
      } else {
        assert.equal(state.lines.filter((line) => line.status === "SUCCEEDED").length, 7);
        assert.equal(state.lines.filter((line) => line.status === "FAILED").length, 3);
      }
    });
  }
});

test("Shopify success followed by Prisma success-write failure stays uncertain and retries the same idempotency key", async () => {
  const line = makeLine({ quantity: 3 });
  const batch = makeBatch({ lines: [line] });
  const { prisma, state } = makePrisma({ batch, failSucceededLineUpdateOnce: true });
  const appliedKeys = new Set();
  const { admin, calls } = makeAdmin({
    skuResults: [existingVariant()],
    handlers: {
      StockHubAdjustIncoming(call) {
        // Model Shopify idempotency: repeated request with the same key applies once.
        appliedKeys.add(call.variables.key);
        return graphQLResponse({
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/once" },
            userErrors: [],
          },
        });
      },
    },
  });

  const first = await run(batch, admin, prisma);
  assert.equal(first.status, "UNCERTAIN");
  assert.equal(first.lines[0].status, "UNCERTAIN");
  assert.equal(state.lines[0].idempotencyKey, line.idempotencyKey);

  const second = await run(batch, admin, prisma);
  const adjustmentCalls = calls.filter((call) => call.operationName === "StockHubAdjustIncoming");
  assert.equal(second.status, "COMPLETED");
  assert.deepEqual(adjustmentCalls.map((call) => call.variables.key), [line.idempotencyKey, line.idempotencyKey]);
  assert.equal(appliedKeys.size, 1, "retry must retain the same Shopify idempotency identity");
  assert.equal(state.lines[0].status, "SUCCEEDED");
});

test("known inventory activation userError is reconciled before retry and stops uncertain if the level exists", async () => {
  const line = makeLine({ operationType: "CREATE_DRAFT", quantity: 7 });
  const batch = makeBatch({ lines: [line] });
  const { prisma, state } = makePrisma({ batch });
  let activationAttempts = 0;
  let markerReads = 0;
  const { admin, calls } = makeAdmin({
    handlers: {
      StockHubActivateDraftInventory() {
        activationAttempts += 1;
        return graphQLResponse({
          inventoryActivate: {
            inventoryLevel: null,
            userErrors: [{ field: ["inventoryItemId"], message: "Inventory item is already stocked at this location." }],
          },
        });
      },
      StockHubFindDraftMarker(call) {
        markerReads += 1;
        assert.equal(call.variables.locationId, LOCATION_ID, "reconciliation must query the selected location");
        const reconciledDraft = draftProduct(line.operationId);
        reconciledDraft.variants.nodes[0].sku = line.sku;
        return graphQLResponse({
          productByIdentifier: {
            ...reconciledDraft,
            variants: {
              nodes: [{
                ...reconciledDraft.variants.nodes[0],
                inventoryItem: {
                  id: "gid://shopify/InventoryItem/400",
                  tracked: true,
                  inventoryLevel: {
                    quantities: [{ name: "available", quantity: 7 }],
                  },
                },
              }],
            },
          },
        });
      },
    },
  });

  const first = await run(batch, admin, prisma);
  const originalKey = state.lines[0].idempotencyKey;
  assert.equal(first.status, "FAILED");
  assert.equal(first.lines[0].status, "FAILED");
  assert.deepEqual(
    [state.lines[0].productId, state.lines[0].variantId, state.lines[0].inventoryItemId, state.lines[0].sku],
    ["gid://shopify/Product/300", "gid://shopify/ProductVariant/200", "gid://shopify/InventoryItem/400", line.sku],
    "resume fixture must match the resource IDs and SKU persisted from the initial attempt",
  );

  const second = await run(batch, admin, prisma);
  assert.equal(second.status, "UNCERTAIN");
  assert.equal(second.lines[0].status, "UNCERTAIN");
  assert.equal(state.lines[0].idempotencyKey, originalKey, "do not rotate the key when Shopify already has a level");
  assert.equal(markerReads, 1);
  assert.equal(activationAttempts, 1, "existing level must stop a duplicate activation");
  assert.equal(calls.some((call) => call.operationName === "StockHubFindDraftMarker" && /inventoryLevel\(locationId:\s*\$locationId\)/.test(call.query)), true);
});

test("known inventory activation userError rotates the key only after a fresh absent-level read", async () => {
  const line = makeLine({ operationType: "CREATE_DRAFT", quantity: 7 });
  const batch = makeBatch({ lines: [line] });
  const { prisma, state } = makePrisma({ batch });
  let activationAttempts = 0;
  let markerReads = 0;
  const { admin, calls } = makeAdmin({
    handlers: {
      StockHubActivateDraftInventory() {
        activationAttempts += 1;
        if (activationAttempts === 1) {
          return graphQLResponse({
            inventoryActivate: {
              inventoryLevel: null,
              userErrors: [{ field: ["inventoryItemId"], message: "Inventory item is already stocked at this location." }],
            },
          });
        }
        return graphQLResponse({
          inventoryActivate: { inventoryLevel: { id: "gid://shopify/InventoryLevel/401" }, userErrors: [] },
        });
      },
      StockHubFindDraftMarker(call) {
        markerReads += 1;
        assert.equal(call.variables.locationId, LOCATION_ID);
        const reconciledDraft = draftProduct(line.operationId);
        reconciledDraft.variants.nodes[0].sku = line.sku;
        return graphQLResponse({
          productByIdentifier: {
            ...reconciledDraft,
            variants: {
              nodes: [{
                ...reconciledDraft.variants.nodes[0],
                inventoryItem: {
                  id: "gid://shopify/InventoryItem/400",
                  tracked: true,
                  inventoryLevel: null,
                },
              }],
            },
          },
        });
      },
    },
  });

  const first = await run(batch, admin, prisma);
  const originalKey = state.lines[0].idempotencyKey;
  assert.equal(first.lines[0].status, "FAILED");
  assert.deepEqual(
    [state.lines[0].productId, state.lines[0].variantId, state.lines[0].inventoryItemId, state.lines[0].sku],
    ["gid://shopify/Product/300", "gid://shopify/ProductVariant/200", "gid://shopify/InventoryItem/400", line.sku],
    "resume fixture must match the resource IDs and SKU persisted from the initial attempt",
  );
  const second = await run(batch, admin, prisma);
  assert.equal(second.status, "COMPLETED");
  assert.equal(second.lines[0].status, "SUCCEEDED");
  assert.equal(markerReads, 1, "retry must freshly read the selected location before deciding to activate");
  assert.equal(activationAttempts, 2);
  assert.notEqual(state.lines[0].idempotencyKey, originalKey, "a new key is allowed only after fresh absence is established");
  assert.deepEqual(
    calls.filter((call) => call.operationName === "StockHubActivateDraftInventory").map((call) => call.variables.key),
    [originalKey, state.lines[0].idempotencyKey],
  );
});
