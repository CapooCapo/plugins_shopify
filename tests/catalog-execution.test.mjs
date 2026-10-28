/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: resolve(process.cwd(), "app/utils"),
  appType: "custom",
  server: { middlewareMode: true },
  logLevel: "error",
});
const { buildCatalogExecutionPlan, catalogExecutionIdempotencyKey, fingerprintForCatalogReview } = await vite.ssrLoadModule("/catalog-execution.shared.ts");
const { executeConfirmedCatalogReview, verifyCatalogExecutionDatabase } = await vite.ssrLoadModule("/catalog-execution.server.ts");
test.after(() => vite.close());

const SHOP = "dev-stockhub.myshopify.com";
const OTHER_SHOP = "other-stockhub.myshopify.com";
const BATCH_ID = "catalog-batch-1";
const GROUP_ID = "catalog-group-1";
const REVIEW_ID = "catalog-review-1";
const PRODUCT_ID = "gid://shopify/Product/900";
const DATABASE_URL = "postgresql://stockhub_test:local-only@127.0.0.1:55432/stockhub_regression?schema=public";
const DATABASE_IDENTITY_CONFIG = {
  shop: SHOP, appId: "dev-app-client-id", databaseName: "stockhub_regression", databaseUser: "stockhub_test",
  databaseServerAddress: "127.0.0.1", databaseServerPort: 5432,
};

function databaseIdentity(patch = {}) {
  return {
    database: "stockhub_regression",
    role: "stockhub_test",
    serverAddress: "127.0.0.1",
    clientAddress: "127.0.0.1",
    serverPort: 5432,
    ...patch,
  };
}

function prismaReturningIdentity(rows) {
  return {
    async $queryRaw(strings) {
      assert.match(strings.join(" "), /current_database\(\).*current_user.*inet_server_addr/s);
      return rows;
    },
  };
}

function environment(patch = {}) {
  return {
    STOCKHUB_CATALOG_EXECUTION_ENABLED: "true",
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DEV_APP_ID: "dev-app-client-id",
    SHOPIFY_API_KEY: "dev-app-client-id",
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DEV_STORE: SHOP,
    DATABASE_URL,
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_URL: DATABASE_URL,
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_USER: "stockhub_test",
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_SERVER_ADDRESS: "127.0.0.1",
    STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_SERVER_PORT: "5432",
    ...patch,
  };
}

const fieldChoices = (patch = {}) => ({
  sku: "USE_CSV", price: "USE_CSV", size: "KEEP_SHOPIFY", color: "KEEP_SHOPIFY", ...patch,
});

function line(id, patch = {}) {
  return {
    id,
    batchId: BATCH_ID,
    rowNumber: Number(id.replace(/\D/g, "")) || 2,
    status: "READY",
    errors: [],
    sku: id === "line-2" ? "SKU-M" : "SKU-S",
    price: "12.50",
    productName: "Wool Shirt",
    description: "Soft wool shirt",
    vendor: "StockHub Test",
    productType: "Apparel",
    size: id === "line-2" ? "M" : "S",
    color: null,
    sourceRowNumber: Number(id.replace(/\D/g, "")) || 2,
    ...patch,
  };
}

function variant(patch = {}) {
  return {
    id: "gid://shopify/ProductVariant/901",
    sku: "SKU-S",
    price: "10.00",
    selectedOptions: [{ name: "Size", value: "S" }],
    productId: PRODUCT_ID,
    productTitle: "Wool Shirt",
    productDescription: "Old description",
    vendor: "Old Vendor",
    productType: "Old Type",
    productOptions: [{ name: "Size", values: ["S"] }],
    ...patch,
  };
}

function decisionsFor(lines, { operation = "CREATE", group = "CONFIRM", productFields = {}, variantFields = {} } = {}) {
  return {
    schemaVersion: 1,
    group,
    productFields: {
      title: "USE_CSV", description: "KEEP_SHOPIFY", vendor: "KEEP_SHOPIFY", productType: "KEEP_SHOPIFY", ...productFields,
    },
    variants: Object.fromEntries(lines.map((entry) => [entry.id, {
      operation,
      fields: fieldChoices({
        ...(operation === "CREATE" ? { size: entry.size ? "USE_CSV" : "KEEP_SHOPIFY", color: entry.color ? "USE_CSV" : "KEEP_SHOPIFY" } : {}),
        ...(variantFields[entry.id] ?? {}),
      }),
    }])),
  };
}

function fixture({
  shop = SHOP,
  operation = "CREATE",
  status = "CONFIRMED",
  reviewVersion = 4,
  draftVersion = 7,
  lines = [line("line-1")],
  snapshotVariants = [],
  decisions,
  mapping,
  beforeClaim,
} = {}) {
  const productId = operation === "UPDATE" ? PRODUCT_ID : null;
  const proposal = { groupTitle: "Wool Shirt", productId, rowIds: lines.map((entry) => entry.id) };
  const fingerprintVariants = [...snapshotVariants].sort((left, right) => left.productId.localeCompare(right.productId) || (left.sku ?? "").localeCompare(right.sku ?? "") || left.id.localeCompare(right.id));
  const fingerprint = fingerprintForCatalogReview({ variants: fingerprintVariants }, proposal, lines.map(({ id, sku }) => ({ id, sku })));
  const batch = {
    id: BATCH_ID, shop, status: "DRAFT", draftVersion,
    mapping: mapping ?? { productName: "productName", sku: "sku", price: "price", size: "size" },
  };
  const group = {
    id: GROUP_ID, shop, batchId: BATCH_ID, state: "ACTIVE", confirmedAt: new Date("2026-10-28T00:00:00.000Z"),
    selections: {
      productName: { value: "Wool Shirt" },
      description: { value: "Soft wool shirt" },
      vendor: { value: "StockHub Test" },
      productType: { value: "Apparel" },
    },
    lines,
  };
  const review = {
    id: REVIEW_ID, shop, batchId: BATCH_ID, groupId: GROUP_ID, draftVersion, reviewVersion,
    operation, status, snapshotFingerprint: fingerprint, snapshot: { proposal, variants: snapshotVariants },
    shopifyProductId: productId, decisions: decisions ?? decisionsFor(lines, { operation }),
  };
  const state = { batch, group, review, reviewHistory: [], operations: [], items: [], attempts: [], transitions: [], dbReads: 0, transactionCount: 0 };
  const matches = (record, where = {}) => Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if ("in" in condition) return condition.in.includes(record[key]);
      if ("notIn" in condition) return !condition.notIn.includes(record[key]);
      if ("equals" in condition) return record[key] === condition.equals;
      if ("lte" in condition) return record[key] <= condition.lte;
      if ("lt" in condition) return record[key] < condition.lt;
      if ("gte" in condition) return record[key] >= condition.gte;
      if ("gt" in condition) return record[key] > condition.gt;
    }
    return record[key] === condition;
  });
  const applyData = (record, data) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) record[key] += value.increment;
      else record[key] = value;
    }
  };
  const updateMany = (collection) => async ({ where, data }) => {
    const records = collection.filter((record) => matches(record, where));
    records.forEach((record) => {
      if (typeof data.status === "string" && data.status !== record.status) state.transitions.push({ id: record.id, from: record.status, to: data.status });
      applyData(record, data);
    });
    return { count: records.length };
  };
  const prisma = {
    async $transaction(callback) {
      state.transactionCount += 1;
      if (state.transactionCount === 2 && beforeClaim) await beforeClaim(state);
      return callback(prisma);
    },
    catalogImportBatch: {
      async findFirst({ where }) { return matches(state.batch, where) ? state.batch : null; },
      async updateMany({ where, data }) { return updateMany([state.batch])({ where, data }); },
    },
    catalogImportGroup: {
      async findFirst({ where }) { return matches(state.group, where) ? state.group : null; },
    },
    catalogImportReview: {
      async findFirst({ where }) { return matches(state.review, where) ? state.review : null; },
      async updateMany({ where, data }) { return updateMany([state.review])({ where, data }); },
    },
    catalogImportReviewHistory: {
      async createMany({ data }) {
        for (const record of data) {
          if (!state.reviewHistory.some((saved) => saved.id === record.id && saved.reviewVersion === record.reviewVersion)) {
            state.reviewHistory.push(record);
          }
        }
        return { count: data.length };
      },
    },
    catalogExecutionOperation: {
      async findFirst({ where }) { return state.operations.find((record) => matches(record, where)) ?? null; },
      async create({ data }) { state.operations.push(data); return data; },
      async updateMany({ where, data }) { return updateMany(state.operations)({ where, data }); },
    },
    catalogExecutionItem: {
      async createMany({ data }) { state.items.push(...data); return { count: data.length }; },
      async updateMany({ where, data }) { return updateMany(state.items)({ where, data }); },
    },
    catalogExecutionAttempt: {
      async create({ data }) { state.attempts.push(data); return data; },
      async update({ where, data }) {
        const attempt = state.attempts.find((record) => record.id === where.id);
        assert.ok(attempt, "attempt update references a persisted attempt");
        applyData(attempt, data);
        return attempt;
      },
      async updateMany({ where, data }) { return updateMany(state.attempts)({ where, data }); },
    },
    async $queryRaw() { state.dbReads += 1; return []; },
  };
  const readSnapshot = async () => {
    const nodes = snapshotVariants.map((entry) => ({
      id: entry.id, sku: entry.sku, price: entry.price, selectedOptions: entry.selectedOptions,
      product: {
        id: entry.productId, title: entry.productTitle, descriptionHtml: entry.productDescription,
        vendor: entry.vendor, productType: entry.productType, options: entry.productOptions,
      },
    }));
    return Response.json({ data: {
      shop: { myshopifyDomain: shop },
      productVariants: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
    } });
  };
  const calls = [];
  const mutations = [];
  const admin = {
    async graphql(query, options = {}) {
      const call = { query, variables: options.variables ?? {} };
      calls.push(call);
      if (query.includes("StockHubCatalogVariantSnapshot")) return readSnapshot(query, options);
      if (/\bmutation\b/.test(query)) mutations.push(call);
      return Response.json({ errors: [{ message: "Unexpected fake GraphQL operation" }] }, { status: 500 });
    },
  };
  let scopeReads = 0;
  const scopes = { async query() { scopeReads += 1; return { granted: ["read_products", "write_products"] }; } };
  const verifyCalls = [];
  const verifyDatabase = async (config) => { verifyCalls.push(config); };
  const request = (overrides = {}) => executeConfirmedCatalogReview({
    shop, batchId: BATCH_ID, groupId: GROUP_ID, draftVersion,
    expectedReviewVersion: reviewVersion, expectedFingerprint: fingerprint,
    admin, scopes, prisma, environment: environment(), verifyDatabase, ...overrides,
  });
  return { state, prisma, admin, calls, mutations, scopes, verifyCalls, request, environment: environment(), snapshotVariants, get scopeReads() { return scopeReads; } };
}

function planForFixture(f, snapshotVariants = f.snapshotVariants) {
  return buildCatalogExecutionPlan({
    review: f.state.review,
    group: f.state.group,
    mapping: f.state.batch.mapping,
    snapshotVariants,
  });
}

function seedRunningOperation(f, plan, updatedAt) {
  const review = f.state.review;
  const id = "operation-running-test";
  const operation = {
    id, shop: f.state.batch.shop, batchId: f.state.batch.id, groupId: f.state.group.id, reviewId: review.id,
    draftVersion: review.draftVersion, reviewVersion: review.reviewVersion,
    snapshotFingerprint: review.snapshotFingerprint,
    idempotencyKey: catalogExecutionIdempotencyKey({
      shop: f.state.batch.shop, batchId: f.state.batch.id, groupId: f.state.group.id,
      reviewId: review.id, draftVersion: review.draftVersion, snapshotFingerprint: review.snapshotFingerprint,
    }),
    plan: plan.disposition, status: "RUNNING", productId: plan.productId,
    planJson: plan, updatedAt,
  };
  f.state.operations.push(operation);
  f.state.items.push(...plan.items.filter((item) => ["CREATE", "UPDATE"].includes(item.disposition)).map((item, index) => ({
    id: `item-${index}`, shop: operation.shop, batchId: operation.batchId, operationId: id,
    lineId: item.lineId, plan: item.disposition, status: "RUNNING", productId: item.productId,
    variantId: item.variantId, approvedFields: item.approvedFields,
  })));
  f.state.attempts.push({ id: "attempt-prepared", shop: operation.shop, operationId: id, status: "PREPARED", mutation: "productVariantsBulkUpdate" });
  return operation;
}

const successfulMutation = (field, payload) => Response.json({ data: { [field]: { ...payload, userErrors: [] } } });

function unknownCreateOutcomeFixture() {
  const lines = [line("line-1")];
  const decisions = decisionsFor(lines, { productFields: {
    title: "USE_CSV", description: "USE_CSV", vendor: "USE_CSV", productType: "USE_CSV",
  } });
  const f = fixture({
    lines, decisions,
    mapping: { productName: "productName", description: "description", vendor: "vendor", productType: "productType", sku: "sku", price: "price", size: "size" },
  });
  const createdProductId = "gid://shopify/Product/create-reconcile";
  const defaultVariantId = "gid://shopify/ProductVariant/create-reconcile-default";
  let observedProduct;
  let observedVariant;
  const snapshotResponse = () => Response.json({ data: { shop: { myshopifyDomain: SHOP }, productVariants: {
    nodes: observedVariant && observedProduct ? [{
      id: observedVariant.id, sku: observedVariant.sku, price: observedVariant.price, selectedOptions: observedVariant.selectedOptions,
      product: {
        id: observedProduct.id, title: observedProduct.title, descriptionHtml: observedProduct.descriptionHtml, vendor: observedProduct.vendor, productType: observedProduct.productType,
        options: (observedProduct.productOptions ?? []).map((option) => ({ name: option.name, values: option.values.map((value) => typeof value === "string" ? value : value.name) })),
      },
    }] : [],
    pageInfo: { hasNextPage: false, endCursor: null },
  } } });
  f.admin.graphql = async (query, options = {}) => {
    const call = { query, variables: options.variables ?? {} };
    f.calls.push(call);
    if (query.includes("StockHubCatalogVariantSnapshot")) return snapshotResponse();
    if (query.includes("StockHubCatalogFindOperationProduct")) {
      return Response.json({ data: { shop: { myshopifyDomain: SHOP }, products: { nodes: [{
        id: observedProduct.id,
        title: observedProduct.title,
        descriptionHtml: observedProduct.descriptionHtml,
        vendor: observedProduct.vendor,
        productType: observedProduct.productType,
        status: observedProduct.status,
        tags: observedProduct.tags,
        metafield: { value: observedProduct.marker },
        variants: { nodes: observedVariant ? [observedVariant] : [], pageInfo: { hasNextPage: false } },
      }] } } });
    }
    f.mutations.push(call);
    if (query.includes("StockHubCatalogProductCreate")) {
      const input = call.variables.product;
      observedProduct = { ...input, id: createdProductId, status: "DRAFT", marker: input.metafields[0].value };
      return successfulMutation("productCreate", { product: {
        id: createdProductId, title: input.title, descriptionHtml: input.descriptionHtml, vendor: input.vendor, productType: input.productType,
        status: "DRAFT", tags: input.tags, metafield: { value: input.metafields[0].value },
        variants: { nodes: [{ id: defaultVariantId }], pageInfo: { hasNextPage: false } },
      } });
    }
    if (query.includes("StockHubCatalogVariantsUpdate")) {
      observedVariant = { id: defaultVariantId, sku: "SKU-S", price: "12.50", selectedOptions: [{ name: "Size", value: "S" }] };
      throw new Error("Timeout after Shopify accepted the default variant update");
    }
    throw new Error(`Unexpected GraphQL request during Create reconciliation: ${query}`);
  };
  return {
    ...f,
    changeObservedProduct(patch) { observedProduct = { ...observedProduct, ...patch }; },
    changeObservedVariant(patch) { observedVariant = { ...observedVariant, ...patch }; },
    removeObservedVariant() { observedVariant = null; },
  };
}

test("database verifier accepts only expected local PostgreSQL identities", async () => {
  const accepted = [
    databaseIdentity(),
    databaseIdentity({ serverAddress: "127.0.0.1/32", clientAddress: "127.0.0.1/32" }),
    databaseIdentity({ serverAddress: "::1", clientAddress: "127.0.0.1", serverPort: 55432 }),
    databaseIdentity({ serverAddress: "::1/128", clientAddress: "127.0.0.1/32", serverPort: 55432 }),
  ];
  for (const identity of accepted) {
    await verifyCatalogExecutionDatabase(prismaReturningIdentity([identity]), {
      ...DATABASE_IDENTITY_CONFIG,
      databaseServerAddress: identity.serverAddress.split("/")[0],
      databaseServerPort: identity.serverPort,
    });
  }
});

test("database verifier rejects private and non-loopback CIDRs for both server and client identities", async () => {
  const invalidAddresses = [
    "10.20.0.4/32", "172.16.0.1/32", "172.31.255.254/32", "192.168.1.10/32",
    "100.64.0.1/32", "8.8.8.8/32", "2001:db8::1/128", "127.0.0.2/32",
    "127.0.0.1/8", "127.0.0.1/31", "::1/64", "::1/127", "::ffff:127.0.0.1/128",
  ];
  for (const address of invalidAddresses) {
    for (const field of ["serverAddress", "clientAddress"]) {
      await assert.rejects(
        verifyCatalogExecutionDatabase(prismaReturningIdentity([databaseIdentity({ [field]: address })]), DATABASE_IDENTITY_CONFIG),
        /connected PostgreSQL server identity is not the expected isolated local test database/i,
        `${field}=${address}`,
      );
    }
  }
});

test("database verifier rejects mismatched or non-private identities and sanitizes query errors", async () => {
  const invalid = [
    databaseIdentity({ database: "production" }),
    databaseIdentity({ role: "managed_role" }),
    databaseIdentity({ serverAddress: "10.20.0.4", clientAddress: "192.168.1.10", serverPort: 55432 }),
    databaseIdentity({ serverAddress: "10.20.0.4" }),
    databaseIdentity({ serverAddress: "203.0.113.42" }),
    databaseIdentity({ serverAddress: "127.0.0.1/31" }),
    databaseIdentity({ serverAddress: "::1/127" }),
    databaseIdentity({ serverAddress: "10.0.0.1/32" }),
    databaseIdentity({ serverAddress: "127.0.0.1/32/1" }),
    databaseIdentity({ serverAddress: "127.0.0.1/garbage" }),
    databaseIdentity({ serverAddress: "127.0.0.1/32junk" }),
    databaseIdentity({ serverAddress: "::ffff:127.0.0.1/32" }),
    databaseIdentity({ clientAddress: "8.8.8.8" }),
    databaseIdentity({ serverAddress: null }),
    databaseIdentity({ clientAddress: null }),
    databaseIdentity({ serverPort: 5433 }),
  ];
  for (const identity of invalid) {
    await assert.rejects(
      verifyCatalogExecutionDatabase(prismaReturningIdentity([identity]), DATABASE_IDENTITY_CONFIG),
      /connected PostgreSQL server identity is not the expected isolated local test database/i,
    );
  }
  await assert.rejects(
    verifyCatalogExecutionDatabase(prismaReturningIdentity([]), DATABASE_IDENTITY_CONFIG),
    /connected PostgreSQL server identity/i,
  );

  const credentialDetail = "postgresql://secret-user:secret-password@managed.example/production";
  const failingPrisma = { async $queryRaw() { throw new Error(credentialDetail); } };
  await assert.rejects(verifyCatalogExecutionDatabase(failingPrisma, DATABASE_IDENTITY_CONFIG), (error) => {
    assert.equal(error.message, "Catalog execution is blocked because the isolated local PostgreSQL identity could not be verified.");
    assert.equal(error.message.includes("secret-password"), false);
    return true;
  });
});

test("execution fails closed unless app, dev store, and explicit loopback database identities match", async () => {
  const f = fixture();
  await assert.rejects(f.request({ environment: environment({ SHOPIFY_API_KEY: "production-linked-app-id" }) }), /does not match.*Development App/i);
  assert.equal(f.verifyCalls.length, 0);
  assert.equal(f.scopeReads, 0, "scope query is not invoked before environment gate");
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.operations.length, 0);

  await assert.rejects(f.request({ shop: OTHER_SHOP }), /expected development store/i);
  assert.equal(f.verifyCalls.length, 0);
  assert.equal(f.calls.length, 0);

  await assert.rejects(f.request({ environment: environment({ DATABASE_URL: "postgresql://managed.example/production" }) }), /database target/i);
  assert.equal(f.verifyCalls.length, 0);
  assert.equal(f.calls.length, 0);

  const disconnected = fixture();
  await assert.rejects(disconnected.request({ verifyDatabase: async () => { throw new Error("isolated DB identity verification failed"); } }), /isolated DB identity/i);
  assert.equal(disconnected.scopeReads, 0, "failed live DB verification blocks scope reads and Shopify calls");
  assert.equal(disconnected.calls.length, 0);
});

test("execution checks current granted scopes and never writes when write_products is missing", async () => {
  const f = fixture();
  let scopeCalls = 0;
  f.scopes.query = async () => { scopeCalls += 1; return { granted: ["read_products"] }; };
  await assert.rejects(f.request(), /must include read_products and write_products/i);
  assert.equal(scopeCalls, 1);
  assert.equal(f.verifyCalls.length, 1, "the injected local database identity check runs after the static gate");
  assert.equal(f.calls.length, 0, "missing write scope prevents even the snapshot read");
  assert.equal(f.mutations.length, 0);
  assert.equal(f.state.operations.length, 0);
});

test("only the current persisted CONFIRMED review version is executable", async () => {
  const pending = fixture({ status: "PENDING" });
  await assert.rejects(pending.request(), /current persisted confirmation/i);
  assert.equal(pending.calls.length, 0);

  const changedVersion = fixture();
  await assert.rejects(changedVersion.request({ expectedReviewVersion: changedVersion.state.review.reviewVersion + 1 }), /current persisted confirmation/i);
  assert.equal(changedVersion.calls.length, 0);
  assert.equal(changedVersion.mutations.length, 0);
});

test("final pre-mutation CAS rejects a draft or review changed after the Shopify read", async () => {
  const changedDraft = fixture({ beforeClaim(state) { state.batch.draftVersion += 1; } });
  await assert.rejects(changedDraft.request(), /draft changed after Shopify was checked/i);
  assert.equal(changedDraft.mutations.length, 0);
  assert.ok(changedDraft.calls.every(({ query }) => /^\s*#graphql\s*query/.test(query)));

  const changedReview = fixture({ beforeClaim(state) {
    state.review.status = "STALE";
    state.review.reviewVersion += 1;
  } });
  await assert.rejects(changedReview.request(), /saved catalog confirmation changed after Shopify was checked/i);
  assert.equal(changedReview.mutations.length, 0);
  assert.ok(changedReview.calls.every(({ query }) => /^\s*#graphql\s*query/.test(query)));
});

test("a changed fresh Shopify snapshot marks the confirmed review stale without sending a mutation", async () => {
  const f = fixture();
  const changed = variant({ id: "gid://shopify/ProductVariant/new", sku: "SKU-S" });
  f.snapshotVariants.push(changed);
  await assert.rejects(f.request(), /Shopify changed since this review was confirmed/i);
  assert.equal(f.state.review.status, "STALE");
  assert.equal(f.state.review.reviewVersion, 5);
  assert.equal(f.state.reviewHistory.length, 1);
  assert.equal(f.state.reviewHistory[0].id, REVIEW_ID);
  assert.equal(f.state.reviewHistory[0].reviewVersion, 4);
  assert.equal(f.state.reviewHistory[0].status, "CONFIRMED");
  assert.equal(f.mutations.length, 0);
  assert.ok(f.calls.every(({ query }) => /^\s*#graphql\s*query/.test(query)), "stale detection uses reads only");
});

test("confirmed multi-variant CREATE stays Draft, assigns the default variant, creates combinations, and is idempotent", async () => {
  const lines = [line("line-1"), line("line-2")];
  const f = fixture({ lines, mapping: { productName: "productName", sku: "sku", price: "price", size: "size" } });
  let productId = "gid://shopify/Product/1000";
  f.admin.graphql = async (query, options = {}) => {
    const call = { query, variables: options.variables ?? {} };
    f.calls.push(call);
    if (query.includes("StockHubCatalogVariantSnapshot")) return Response.json({ data: { shop: { myshopifyDomain: SHOP }, productVariants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    f.mutations.push(call);
    if (query.includes("StockHubCatalogProductCreate")) {
      const input = call.variables.product;
      return successfulMutation("productCreate", { product: {
        id: productId, title: input.title, status: "DRAFT", tags: input.tags,
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/default" }], pageInfo: { hasNextPage: false } },
      } });
    }
    if (query.includes("StockHubCatalogVariantsUpdate")) {
      return successfulMutation("productVariantsBulkUpdate", { product: { id: productId }, productVariants: [{
        id: "gid://shopify/ProductVariant/default", sku: "SKU-S", price: "12.50", selectedOptions: [{ name: "Size", value: "S" }],
      }] });
    }
    if (query.includes("StockHubCatalogVariantsCreate")) {
      return successfulMutation("productVariantsBulkCreate", { product: { id: productId }, productVariants: [{
        id: "gid://shopify/ProductVariant/second", sku: "SKU-M", price: "12.50", selectedOptions: [{ name: "Size", value: "M" }],
      }] });
    }
    throw new Error(`Unexpected mutation: ${query}`);
  };
  const first = await f.request();
  assert.equal(first.status, "SUCCEEDED", first.message);
  assert.equal(first.productId, productId);
  const createInput = f.mutations.find(({ query }) => query.includes("StockHubCatalogProductCreate")).variables.product;
  assert.equal(createInput.status, "DRAFT");
  assert.deepEqual(createInput.productOptions, [{ name: "Size", values: [{ name: "S" }, { name: "M" }] }]);
  assert.deepEqual(Object.keys(createInput).sort(), ["metafields", "productOptions", "status", "tags", "title"].sort(), "unapproved product fields are omitted");
  const defaultUpdate = f.mutations.find(({ query }) => query.includes("StockHubCatalogVariantsUpdate"));
  assert.deepEqual(defaultUpdate.variables.variants, [{ id: "gid://shopify/ProductVariant/default", sku: "SKU-S", price: "12.50", optionValues: [{ optionName: "Size", name: "S" }] }]);
  assert.equal(defaultUpdate.variables.allowPartialUpdates, false);
  const extraCreate = f.mutations.find(({ query }) => query.includes("StockHubCatalogVariantsCreate"));
  assert.equal(extraCreate.variables.strategy, "PRESERVE_STANDALONE_VARIANT");
  assert.deepEqual(extraCreate.variables.variants, [{ sku: "SKU-M", price: "12.50", optionValues: [{ optionName: "Size", name: "M" }] }]);
  assert.deepEqual(f.mutations.map(({ query }) => query.match(/StockHubCatalog\w+/)?.[0]), [
    "StockHubCatalogProductCreate", "StockHubCatalogVariantsUpdate", "StockHubCatalogVariantsCreate",
  ]);
  assert.ok(f.mutations.every(({ query }) => !/inventory|productDelete/i.test(query)), "execution never changes inventory or deletes products");
  assert.equal(f.state.operations.length, 1);
  assert.equal(f.state.operations[0].status, "SUCCEEDED");
  assert.equal(f.state.items.filter((item) => item.status === "SUCCEEDED").length, 2);

  const mutationCount = f.mutations.length;
  const second = await f.request();
  assert.equal(second.status, "SUCCEEDED");
  assert.equal(f.mutations.length, mutationCount, "a repeated success does not issue duplicate Shopify mutations");
  assert.equal(f.state.operations.length, 1);
});

test("UPDATE sends only approved changed fields and preserves unapproved Shopify product and variant fields", async () => {
  const current = variant();
  const lines = [line("line-1", { size: "S" })];
  const decisions = decisionsFor(lines, {
    operation: "UPDATE",
    productFields: { title: "USE_CSV", description: "KEEP_SHOPIFY", vendor: "KEEP_SHOPIFY", productType: "KEEP_SHOPIFY" },
    variantFields: { "line-1": { sku: "KEEP_SHOPIFY", price: "USE_CSV", size: "KEEP_SHOPIFY", color: "KEEP_SHOPIFY" } },
  });
  const f = fixture({ operation: "UPDATE", lines, snapshotVariants: [current], decisions, mapping: { productName: "productName", sku: "sku", price: "price" } });
  f.state.group.selections.productName.value = "Updated Wool Shirt";
  f.admin.graphql = async (query, options = {}) => {
    const call = { query, variables: options.variables ?? {} };
    f.calls.push(call);
    if (query.includes("StockHubCatalogVariantSnapshot")) return Response.json({ data: {
      shop: { myshopifyDomain: SHOP }, productVariants: { nodes: [{
        id: current.id, sku: current.sku, price: current.price, selectedOptions: current.selectedOptions,
        product: { id: current.productId, title: current.productTitle, descriptionHtml: current.productDescription, vendor: current.vendor, productType: current.productType, options: current.productOptions },
      }], pageInfo: { hasNextPage: false, endCursor: null } },
    } });
    f.mutations.push(call);
    if (query.includes("StockHubCatalogProductUpdate")) {
      return successfulMutation("productUpdate", { product: { id: PRODUCT_ID } });
    }
    if (query.includes("StockHubCatalogVariantsUpdate")) {
      return successfulMutation("productVariantsBulkUpdate", { product: { id: PRODUCT_ID }, productVariants: [{
        id: current.id, sku: "SKU-S", price: "12.50", selectedOptions: current.selectedOptions,
      }] });
    }
    throw new Error(`Unexpected mutation: ${query}`);
  };
  const result = await f.request();
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(f.mutations.length, 2);
  assert.deepEqual(f.mutations.find(({ query }) => query.includes("StockHubCatalogProductUpdate")).variables.product, { id: PRODUCT_ID, title: "Updated Wool Shirt" });
  const variantUpdate = f.mutations.find(({ query }) => query.includes("StockHubCatalogVariantsUpdate"));
  assert.deepEqual(variantUpdate.variables.variants, [{ id: current.id, price: "12.50" }]);
  assert.equal(variantUpdate.variables.allowPartialUpdates, false);
  assert.ok(f.mutations.every(({ query }) => !/inventory|productDelete|productVariantsBulkCreate/i.test(query)));
});

test("description-only UPDATE sends descriptionHtml and omits unchanged approved product fields", async () => {
  const current = variant({
    price: "12.50",
    productDescription: "Old description",
    vendor: "StockHub Test",
    productType: "Apparel",
  });
  const lines = [line("line-1", { size: "S", price: "12.50" })];
  const decisions = decisionsFor(lines, {
    operation: "UPDATE",
    productFields: { title: "KEEP_SHOPIFY", description: "USE_CSV", vendor: "USE_CSV", productType: "USE_CSV" },
    variantFields: { "line-1": { sku: "USE_CSV", price: "USE_CSV", size: "KEEP_SHOPIFY", color: "KEEP_SHOPIFY" } },
  });
  const f = fixture({
    operation: "UPDATE", lines, snapshotVariants: [current], decisions,
    mapping: { productName: "productName", description: "description", vendor: "vendor", productType: "productType", sku: "sku", price: "price" },
  });
  f.state.group.selections.description = { value: "Fresh description" };
  const baseGraphql = f.admin.graphql.bind(f.admin);
  f.admin.graphql = async (query, options = {}) => {
    if (query.includes("StockHubCatalogVariantSnapshot")) return baseGraphql(query, options);
    const call = { query, variables: options.variables ?? {} };
    f.calls.push(call);
    f.mutations.push(call);
    if (query.includes("StockHubCatalogProductUpdate")) return successfulMutation("productUpdate", { product: { id: PRODUCT_ID } });
    throw new Error(`Unexpected mutation in description-only fixture: ${query}`);
  };

  const result = await f.request();

  assert.equal(result.status, "SUCCEEDED", result.message);
  assert.equal(f.mutations.length, 1, "only one product mutation is needed; approved variant values already match");
  assert.ok(f.mutations[0].query.includes("StockHubCatalogProductUpdate"));
  assert.deepEqual(f.mutations[0].variables.product, { id: PRODUCT_ID, descriptionHtml: "Fresh description" });
  assert.equal(f.state.operations[0].planJson.productUpdate.descriptionHtml, "Fresh description");
  assert.deepEqual(f.state.operations[0].planJson.originalProductFields, { descriptionHtml: "Old description" });
});

test("unchanged approved product fields produce a terminal Skip, not an empty or ambiguous reconciliation", async () => {
  const current = variant({
    price: "12.50",
    productDescription: "Soft wool shirt",
    vendor: "StockHub Test",
    productType: "Apparel",
  });
  const lines = [line("line-1", { size: "S", price: "12.50" })];
  const decisions = decisionsFor(lines, {
    operation: "UPDATE",
    productFields: { title: "USE_CSV", description: "USE_CSV", vendor: "USE_CSV", productType: "USE_CSV" },
    variantFields: { "line-1": { sku: "USE_CSV", price: "USE_CSV", size: "KEEP_SHOPIFY", color: "KEEP_SHOPIFY" } },
  });
  const f = fixture({
    operation: "UPDATE", lines, snapshotVariants: [current], decisions,
    mapping: { productName: "productName", description: "description", vendor: "vendor", productType: "productType", sku: "sku", price: "price" },
  });
  f.state.group.selections.description = { value: "Soft wool shirt" };
  f.state.group.selections.vendor = { value: "StockHub Test" };
  f.state.group.selections.productType = { value: "Apparel" };

  const plan = planForFixture(f);
  assert.equal(plan.disposition, "SKIP");
  assert.deepEqual(plan.productUpdate, {});
  assert.deepEqual(plan.originalProductFields, {});

  const result = await f.request();
  assert.equal(result.status, "SKIPPED", result.message);
  assert.equal(f.state.operations[0].status, "SKIPPED");
  assert.equal(f.mutations.length, 0, "unchanged approved values must not emit a Shopify mutation");

  const reconcile = await f.request({ reconcileOnly: true });
  assert.equal(reconcile.status, "SKIPPED");
  assert.doesNotMatch(reconcile.message, /unknown|ambiguous|reconcil/i);
  assert.equal(f.mutations.length, 0, "terminal Skip does not enter unknown-outcome reconciliation");
});

function unknownDescriptionUpdateFixture({ applyBeforeTimeout }) {
  const current = variant({
    price: "12.50",
    productDescription: "Original description",
    vendor: "StockHub Test",
    productType: "Apparel",
  });
  const lines = [line("line-1", { size: "S", price: "12.50" })];
  const decisions = decisionsFor(lines, {
    operation: "UPDATE",
    productFields: { title: "KEEP_SHOPIFY", description: "USE_CSV", vendor: "USE_CSV", productType: "USE_CSV" },
    variantFields: { "line-1": { sku: "USE_CSV", price: "USE_CSV", size: "KEEP_SHOPIFY", color: "KEEP_SHOPIFY" } },
  });
  const f = fixture({
    operation: "UPDATE", lines, snapshotVariants: [current], decisions,
    mapping: { productName: "productName", description: "description", vendor: "vendor", productType: "productType", sku: "sku", price: "price" },
  });
  f.state.group.selections.description = { value: "Approved description" };
  const baseGraphql = f.admin.graphql.bind(f.admin);
  let mutationCount = 0;
  f.admin.graphql = async (query, options = {}) => {
    if (query.includes("StockHubCatalogVariantSnapshot")) return baseGraphql(query, options);
    const call = { query, variables: options.variables ?? {} };
    f.calls.push(call);
    f.mutations.push(call);
    if (!query.includes("StockHubCatalogProductUpdate")) throw new Error(`Unexpected mutation in description fixture: ${query}`);
    mutationCount += 1;
    if (mutationCount === 1) {
      if (applyBeforeTimeout) f.snapshotVariants[0] = { ...f.snapshotVariants[0], productDescription: call.variables.product.descriptionHtml };
      throw new Error("Timeout after Shopify may have accepted the description update");
    }
    f.snapshotVariants[0] = { ...f.snapshotVariants[0], productDescription: call.variables.product.descriptionHtml };
    return successfulMutation("productUpdate", { product: { id: PRODUCT_ID } });
  };
  return f;
}

test("unknown description UPDATE reconciles an applied description without resending it", async () => {
  const f = unknownDescriptionUpdateFixture({ applyBeforeTimeout: true });

  const first = await f.request();
  assert.equal(first.status, "UNKNOWN");
  assert.deepEqual(f.state.operations[0].planJson.productUpdate, { descriptionHtml: "Approved description" });
  assert.deepEqual(f.state.operations[0].planJson.originalProductFields, { descriptionHtml: "Original description" });
  assert.deepEqual(f.mutations[0].variables.product, { id: PRODUCT_ID, descriptionHtml: "Approved description" });

  const reconciled = await f.request({ reconcileOnly: true });
  assert.equal(reconciled.status, "SUCCEEDED", reconciled.message);
  assert.match(reconciled.message, /no retry mutation was sent/i);
  assert.equal(f.mutations.length, 1, "a description already at its approved value is reconciled read-only");
  assert.equal(f.state.attempts[0].status, "RECONCILED");
});

test("Safe Resume keeps an unapplied description UNKNOWN for manual reconciliation without retrying", async () => {
  const f = unknownDescriptionUpdateFixture({ applyBeforeTimeout: false });

  const first = await f.request();
  assert.equal(first.status, "UNKNOWN");
  assert.equal(f.snapshotVariants[0].productDescription, "Original description");
  assert.deepEqual(f.state.operations[0].planJson.originalProductFields, { descriptionHtml: "Original description" });

  const resumed = await f.request({ resumeUnknown: true });
  assert.equal(resumed.status, "UNKNOWN", resumed.message);
  assert.match(resumed.message, /manual reconciliation/i);
  assert.equal(f.state.operations[0].status, "UNKNOWN");
  assert.deepEqual(f.mutations.map(({ variables }) => variables.product), [
    { id: PRODUCT_ID, descriptionHtml: "Approved description" },
  ]);
  assert.equal(f.snapshotVariants[0].productDescription, "Original description");
  assert.equal(f.state.attempts.length, 1, "a read-only reconciliation creates no replacement mutation attempt");
  assert.equal(f.state.attempts[0].status, "UNKNOWN");
});

test("SKIP and missing Update targets persist terminal outcomes without Shopify mutations", async () => {
  const skippedLine = line("line-1");
  const skipped = fixture({ lines: [skippedLine], decisions: decisionsFor([skippedLine], { group: "SKIP" }) });
  const skipResult = await skipped.request();
  assert.equal(skipResult.status, "SKIPPED");
  assert.equal(skipped.state.operations[0].status, "SKIPPED");
  assert.equal(skipped.mutations.length, 0);

  const updateLine = line("line-1");
  const update = fixture({ operation: "UPDATE", lines: [updateLine], snapshotVariants: [], decisions: decisionsFor([updateLine], { operation: "UPDATE" }) });
  const conflictResult = await update.request();
  assert.equal(conflictResult.status, "CONFLICT");
  assert.equal(update.state.operations[0].status, "CONFLICT");
  assert.match(conflictResult.message, /missing|ambiguous/i);
  assert.equal(update.mutations.length, 0);
});

test("accepted mutation with lost response becomes UNKNOWN and reconciles by reads without resending", async () => {
  const f = fixture();
  const createdProductId = "gid://shopify/Product/unknown-accepted";
  let acceptedProduct;
  let acceptedVariant;
  f.admin.graphql = async (query, options = {}) => {
    const call = { query, variables: options.variables ?? {} };
    f.calls.push(call);
    if (query.includes("StockHubCatalogVariantSnapshot")) {
      const nodes = acceptedVariant ? [{
        id: acceptedVariant.id, sku: acceptedVariant.sku, price: acceptedVariant.price, selectedOptions: acceptedVariant.selectedOptions,
        product: { id: createdProductId, title: "Wool Shirt", descriptionHtml: null, vendor: "", productType: "", options: [] },
      }] : [];
      return Response.json({ data: { shop: { myshopifyDomain: SHOP }, productVariants: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes("StockHubCatalogFindOperationProduct")) {
      return Response.json({ data: { shop: { myshopifyDomain: SHOP }, products: { nodes: [{
        id: createdProductId, title: "Wool Shirt", status: "DRAFT", tags: acceptedProduct.tags,
        metafield: { value: acceptedProduct.operationId },
        variants: { nodes: [acceptedVariant], pageInfo: { hasNextPage: false } },
      }] } } });
    }
    f.mutations.push(call);
    if (query.includes("StockHubCatalogProductCreate")) {
      const input = call.variables.product;
      const operationId = input.metafields[0].value;
      acceptedProduct = { operationId, tags: input.tags };
      return successfulMutation("productCreate", { product: {
        id: createdProductId, title: input.title, status: "DRAFT", tags: input.tags,
        variants: { nodes: [{ id: "gid://shopify/ProductVariant/default-unknown" }], pageInfo: { hasNextPage: false } },
      } });
    }
    if (query.includes("StockHubCatalogVariantsUpdate")) {
      acceptedVariant = {
        id: "gid://shopify/ProductVariant/default-unknown", sku: "SKU-S", price: "12.50", selectedOptions: [{ name: "Size", value: "S" }],
      };
      throw new Error("Timeout after Shopify accepted the default variant update");
    }
    throw new Error(`Unexpected mutation: ${query}`);
  };

  const first = await f.request();
  assert.equal(first.status, "UNKNOWN");
  assert.equal(f.state.operations[0].status, "UNKNOWN");
  assert.equal(f.mutations.length, 2, JSON.stringify(f.calls.map(({ query }) => query.match(/(?:query|mutation)\s+(StockHubCatalog\w+)/)?.[1])));
  assert.equal(f.state.attempts.at(-1).status, "UNKNOWN");

  const reconcile = await f.request({ reconcileOnly: true });
  assert.equal(reconcile.status, "SUCCEEDED");
  assert.match(reconcile.message, /no retry mutation was sent/i);
  assert.equal(f.state.operations[0].status, "SUCCEEDED");
  assert.equal(f.mutations.length, 2, "reconciliation is read-only and never resends the accepted-then-timeout mutation");
  const subsequentCalls = f.calls.slice(3);
  assert.ok(subsequentCalls.every(({ query }) => /^\s*#graphql\s*query/.test(query)));
  assert.equal(f.state.attempts.at(-1).status, "RECONCILED");
});

test("Create reconciliation succeeds only when all approved fields, Draft status, marker, and expected variants match", async () => {
  const successful = unknownCreateOutcomeFixture();
  const first = await successful.request();
  assert.equal(first.status, "UNKNOWN");
  const reconciled = await successful.request({ reconcileOnly: true });
  assert.equal(reconciled.status, "SUCCEEDED", reconciled.message);
  assert.equal(successful.state.operations[0].status, "SUCCEEDED");
  assert.equal(successful.mutations.length, 2, "complete Create reconciliation performs no retry mutation");

  const corruptions = [
    ["title", (f) => f.changeObservedProduct({ title: "Third-party title" })],
    ["description", (f) => f.changeObservedProduct({ descriptionHtml: "Third-party description" })],
    ["vendor", (f) => f.changeObservedProduct({ vendor: "Third-party vendor" })],
    ["productType", (f) => f.changeObservedProduct({ productType: "Third-party type" })],
    ["Draft status", (f) => f.changeObservedProduct({ status: "ACTIVE" })],
    ["operation marker", (f) => f.changeObservedProduct({ marker: "another-operation" })],
    ["expected variant", (f) => f.changeObservedVariant({ sku: "OTHER-SKU" })],
    ["missing expected variant", (f) => f.removeObservedVariant()],
  ];
  for (const [label, corrupt] of corruptions) {
    const f = unknownCreateOutcomeFixture();
    const firstAttempt = await f.request();
    assert.equal(firstAttempt.status, "UNKNOWN", `${label}: mutation timeout must leave an uncertain operation`);
    corrupt(f);
    const result = await f.request({ reconcileOnly: true });
    assert.equal(result.status, "UNKNOWN", `${label} mismatch must not be reported as a successful Create`);
    assert.equal(f.state.operations[0].status, "UNKNOWN");
    assert.equal(f.mutations.length, 2, `${label} mismatch remains read-only; no blind retry is sent`);
  }
});

test("Create and Update groups above Shopify's 250-variant limit become persisted Conflict without mutations", async () => {
  const createLines = Array.from({ length: 251 }, (_, index) => line(`line-${index + 1}`, {
    sku: `CREATE-${index + 1}`, size: `Size-${index + 1}`,
  }));
  const create = fixture({ lines: createLines, mapping: { productName: "productName", sku: "sku", price: "price", size: "size" } });
  const createResult = await create.request();
  assert.equal(createResult.status, "CONFLICT");
  assert.match(createResult.message, /250-variant execution limit/i);
  assert.equal(create.state.operations[0].status, "CONFLICT");
  assert.equal(create.mutations.length, 0);

  const updateLines = Array.from({ length: 251 }, (_, index) => line(`line-${index + 1}`, {
    sku: `UPDATE-${index + 1}`, price: "12.50",
  }));
  const currentVariants = updateLines.map((entry, index) => variant({
    id: `gid://shopify/ProductVariant/${index + 1}`,
    sku: entry.sku,
    price: "10.00",
  }));
  const update = fixture({
    operation: "UPDATE", lines: updateLines, snapshotVariants: currentVariants,
    mapping: { productName: "productName", sku: "sku", price: "price" },
    decisions: decisionsFor(updateLines, { operation: "UPDATE" }),
  });
  const updateResult = await update.request();
  assert.equal(updateResult.status, "CONFLICT");
  assert.match(updateResult.message, /250-variant execution limit/i);
  assert.equal(update.state.operations[0].status, "CONFLICT");
  assert.equal(update.mutations.length, 0);
});

test("orphaned RUNNING execution older than five minutes becomes UNKNOWN then reconciles read-only", async () => {
  const original = variant({ price: "10.00" });
  const f = fixture({ operation: "UPDATE", snapshotVariants: [original], decisions: decisionsFor([line("line-1")], { operation: "UPDATE" }) });
  const plan = planForFixture(f, [original]);
  const operation = seedRunningOperation(f, plan, new Date(Date.now() - 6 * 60_000));
  f.snapshotVariants[0] = variant({ price: "12.50" });

  const result = await f.request();
  assert.equal(result.status, "SUCCEEDED");
  assert.deepEqual(f.state.transitions.filter((entry) => entry.id === operation.id).map(({ from, to }) => [from, to]), [
    ["RUNNING", "UNKNOWN"], ["UNKNOWN", "RECONCILING"], ["RECONCILING", "SUCCEEDED"],
  ]);
  assert.equal(f.state.attempts[0].status, "RECONCILED");
  assert.equal(f.mutations.length, 0, "orphan recovery uses Shopify reads and does not replay the mutation");
  assert.ok(f.calls.every(({ query }) => /^\s*#graphql\s*query/.test(query)));
});

test("a recent RUNNING execution stays owned and receives no extra mutation", async () => {
  const current = variant({ price: "10.00" });
  const f = fixture({ operation: "UPDATE", snapshotVariants: [current], decisions: decisionsFor([line("line-1")], { operation: "UPDATE" }) });
  const plan = planForFixture(f, [current]);
  const operation = seedRunningOperation(f, plan, new Date(Date.now() - 60_000));
  const result = await f.request();
  assert.equal(result.status, "RUNNING");
  assert.equal(f.state.operations[0].status, "RUNNING");
  assert.equal(f.state.transitions.length, 0);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.calls.length, 1, "only the current Shopify snapshot is read");
  assert.equal(f.calls[0].query.includes("StockHubCatalogVariantSnapshot"), true);
  assert.equal(result.operationId, operation.id);
});

async function unknownUpdateFixture({ shopifyApplied }) {
  const original = variant({ price: "10.00" });
  const lines = [line("line-1", { size: "S", price: "12.50" })];
  const f = fixture({ operation: "UPDATE", lines, snapshotVariants: [original], decisions: decisionsFor(lines, { operation: "UPDATE" }) });
  let observed = original;
  f.admin.graphql = async (query, options = {}) => {
    const call = { query, variables: options.variables ?? {} };
    f.calls.push(call);
    if (query.includes("StockHubCatalogVariantSnapshot")) {
      const current = observed;
      return Response.json({ data: { shop: { myshopifyDomain: SHOP }, productVariants: { nodes: [{
        id: current.id, sku: current.sku, price: current.price, selectedOptions: current.selectedOptions,
        product: { id: current.productId, title: current.productTitle, descriptionHtml: current.productDescription, vendor: current.vendor, productType: current.productType, options: current.productOptions },
      }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    f.mutations.push(call);
    if (query.includes("StockHubCatalogVariantsUpdate")) {
      if (shopifyApplied) observed = variant({ price: "12.50" });
      throw new Error("Timeout after the Update mutation was accepted");
    }
    throw new Error(`Unexpected GraphQL request during Update reconciliation: ${query}`);
  };
  return f;
}

test("unknown Update reconciles to success when Shopify shows every approved field applied", async () => {
  const f = await unknownUpdateFixture({ shopifyApplied: true });
  const first = await f.request();
  assert.equal(first.status, "UNKNOWN");
  assert.equal(f.state.operations[0].status, "UNKNOWN");
  assert.equal(f.mutations.length, 1);
  const reconciled = await f.request({ reconcileOnly: true });
  assert.equal(reconciled.status, "SUCCEEDED");
  assert.match(reconciled.message, /no retry mutation was sent/i);
  assert.equal(f.state.operations[0].status, "SUCCEEDED");
  assert.equal(f.state.attempts[0].status, "RECONCILED");
  assert.equal(f.mutations.length, 1, "reconciliation never retries the timed-out Update mutation");
});

test("unknown Update remains UNKNOWN when Shopify reflects only partial or mismatching state", async () => {
  const f = await unknownUpdateFixture({ shopifyApplied: false });
  const first = await f.request();
  assert.equal(first.status, "UNKNOWN");
  const reconciled = await f.request({ reconcileOnly: true });
  assert.equal(reconciled.status, "UNKNOWN");
  assert.equal(f.state.operations[0].status, "UNKNOWN");
  assert.equal(f.mutations.length, 1, "partial-state reconciliation is read-only and does not resend");
});

function partialProductAndVariantUpdateFixture() {
  const original = variant({ price: "10.00" });
  const lines = [line("line-1", { size: "S", price: "12.50" })];
  const decisions = decisionsFor(lines, {
    operation: "UPDATE",
    productFields: { title: "USE_CSV", description: "KEEP_SHOPIFY", vendor: "KEEP_SHOPIFY", productType: "KEEP_SHOPIFY" },
    variantFields: { "line-1": { sku: "KEEP_SHOPIFY", price: "USE_CSV", size: "KEEP_SHOPIFY", color: "KEEP_SHOPIFY" } },
  });
  const f = fixture({ operation: "UPDATE", lines, snapshotVariants: [original], decisions, mapping: { productName: "productName", sku: "sku", price: "price" } });
  f.state.group.selections.productName.value = "Updated Wool Shirt";
  const originalGraphql = f.admin.graphql.bind(f.admin);
  let variantMutationCalls = 0;
  f.admin.graphql = async (query, options = {}) => {
    if (query.includes("StockHubCatalogVariantSnapshot")) return originalGraphql(query, options);
    const call = { query, variables: options.variables ?? {} };
    f.calls.push(call);
    f.mutations.push(call);
    if (query.includes("StockHubCatalogProductUpdate")) {
      f.snapshotVariants[0] = { ...f.snapshotVariants[0], productTitle: call.variables.product.title };
      return successfulMutation("productUpdate", { product: { id: PRODUCT_ID } });
    }
    if (query.includes("StockHubCatalogVariantsUpdate")) {
      variantMutationCalls += 1;
      if (variantMutationCalls === 1) throw new Error("Timeout after product title was applied; variant outcome is unknown");
      for (const update of call.variables.variants) {
        f.snapshotVariants[0] = { ...f.snapshotVariants[0], ...(update.price ? { price: update.price } : {}), ...(update.sku ? { sku: update.sku } : {}) };
      }
      return successfulMutation("productVariantsBulkUpdate", { product: { id: PRODUCT_ID }, productVariants: call.variables.variants.map((update) => ({ ...f.snapshotVariants[0], ...update })) });
    }
    throw new Error(`Unexpected GraphQL request during partial Update recovery: ${query}`);
  };
  return f;
}

test("safe Update reconciliation recognizes applied fields but never retries fields still at original values", async () => {
  const f = partialProductAndVariantUpdateFixture();
  const first = await f.request();
  assert.equal(first.status, "UNKNOWN");
  assert.deepEqual(f.mutations.map(({ query }) => query.match(/StockHubCatalog\w+/)?.[0]), [
    "StockHubCatalogProductUpdate", "StockHubCatalogVariantsUpdate",
  ]);
  assert.equal(f.snapshotVariants[0].productTitle, "Updated Wool Shirt", "the first mutation is reflected as applied");
  assert.equal(f.snapshotVariants[0].price, "10.00", "the timed-out variant mutation remains at its original value");

  const result = await f.request({ resumeUnknown: true });
  assert.equal(result.status, "UNKNOWN", result.message);
  assert.match(result.message, /manual reconciliation/i);
  assert.equal(f.state.operations[0].status, "UNKNOWN");
  assert.deepEqual(f.mutations.map(({ query }) => query.match(/StockHubCatalog\w+/)?.[0]), [
    "StockHubCatalogProductUpdate", "StockHubCatalogVariantsUpdate",
  ]);
  assert.equal(f.mutations.filter(({ query }) => query.includes("StockHubCatalogProductUpdate")).length, 1, "an already-applied product field is not resent");
  assert.equal(f.snapshotVariants[0].productTitle, "Updated Wool Shirt");
  assert.equal(f.snapshotVariants[0].price, "10.00", "the unchanged price remains unapplied until an operator resolves the uncertain outcome");
  assert.equal(f.state.attempts.length, 2, "read-only reconciliation does not create another variant mutation attempt");
});

test("concurrent Safe Resume requests have one reconciliation lease claimant and never redispatch UNKNOWN updates", async () => {
  const f = partialProductAndVariantUpdateFixture();
  const initial = await f.request();
  assert.equal(initial.status, "UNKNOWN");
  const operation = f.state.operations[0];
  assert.equal(operation.status, "UNKNOWN");

  const findFirst = f.prisma.catalogExecutionOperation.findFirst.bind(f.prisma.catalogExecutionOperation);
  let unknownReads = 0;
  let releaseBothReads;
  const bothReadUnknown = new Promise((resolve) => { releaseBothReads = resolve; });
  f.prisma.catalogExecutionOperation.findFirst = async (args) => {
    const result = await findFirst(args);
    if (result?.id === operation.id && result.status === "UNKNOWN" && unknownReads < 2) {
      unknownReads += 1;
      if (unknownReads === 2) releaseBothReads();
      await bothReadUnknown;
    }
    return result;
  };

  const mutationCount = f.mutations.length;
  const results = await Promise.all([
    f.request({ resumeUnknown: true }),
    f.request({ resumeUnknown: true }),
  ]);
  assert.equal(unknownReads, 2, "both workers observed the same prior UNKNOWN state before attempting the CAS");
  assert.equal(f.state.operations[0].status, "UNKNOWN");
  assert.equal(f.state.operations[0].claimToken, null);
  assert.equal(f.state.operations[0].claimExpiresAt, null);
  assert.equal(f.mutations.length, mutationCount, "concurrent read-only reconciliation must not redispatch an UNKNOWN variant update");
  assert.equal(f.state.attempts.length, 2, "reconciliation creates no replacement mutation attempt");
  assert.equal(f.state.transitions.filter(({ from, to }) => from === "UNKNOWN" && to === "RECONCILING").length, 1, "only one request may own the persisted reconciliation lease at a time");
  assert.ok(results.every(({ status }) => ["UNKNOWN", "RECONCILING"].includes(status)));
  assert.ok(results.some(({ status }) => status === "UNKNOWN"));
});

test("expired reconciliation lease returns PREPARED attempts to UNKNOWN before a new read-only claim", async () => {
  const f = await unknownUpdateFixture({ shopifyApplied: false });
  const initial = await f.request();
  assert.equal(initial.status, "UNKNOWN");
  const operation = f.state.operations[0];
  operation.status = "RECONCILING";
  operation.claimToken = "expired-lease-token";
  operation.claimExpiresAt = new Date(Date.now() - 1000);
  f.state.attempts.push({ id: "attempt-still-prepared", shop: SHOP, operationId: operation.id, status: "PREPARED", claimToken: "expired-lease-token" });

  const result = await f.request({ reconcileOnly: true });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(operation.status, "UNKNOWN");
  assert.equal(operation.claimToken, null);
  assert.equal(operation.claimExpiresAt, null);
  assert.equal(f.state.attempts.at(-1).status, "UNKNOWN", "an interrupted in-flight mutation is uncertain, never replayable");
  assert.deepEqual(f.state.transitions.filter((entry) => entry.id === operation.id).map(({ from, to }) => [from, to]), [
    ["READY", "RUNNING"], ["RUNNING", "UNKNOWN"], ["RECONCILING", "UNKNOWN"], ["UNKNOWN", "RECONCILING"], ["RECONCILING", "UNKNOWN"],
  ]);
  assert.equal(f.mutations.length, 1, "expired lease recovery performs read-only reconciliation");
});

test("safe Update resume blocks third-party values and sends no blind retry", async () => {
  const f = partialProductAndVariantUpdateFixture();
  const first = await f.request();
  assert.equal(first.status, "UNKNOWN");
  f.snapshotVariants[0] = { ...f.snapshotVariants[0], price: "11.25" };
  const mutationCount = f.mutations.length;

  const result = await f.request({ resumeUnknown: true });
  assert.equal(result.status, "UNKNOWN");
  assert.match(result.message, /differ from both the approved target and recorded original values/i);
  assert.equal(f.mutations.length, mutationCount, "a third-party value is blocked before any retry mutation");
  assert.equal(f.snapshotVariants[0].price, "11.25");
});

test("direct Size/Color Update decisions persist as conflicts and the UI disables those unsupported choices", async () => {
  for (const field of ["size", "color"]) {
    const lines = [line("line-1", { size: "M", color: "Blue" })];
    const current = variant({ selectedOptions: [{ name: "Size", value: "S" }, { name: "Color", value: "Red" }] });
    const decisions = decisionsFor(lines, {
      operation: "UPDATE",
      variantFields: { "line-1": { sku: "KEEP_SHOPIFY", price: "KEEP_SHOPIFY", size: "KEEP_SHOPIFY", color: "KEEP_SHOPIFY", [field]: "USE_CSV" } },
    });
    const f = fixture({ operation: "UPDATE", lines, snapshotVariants: [current], decisions, mapping: { productName: "productName", sku: "sku", price: "price", size: "size", color: "color" } });
    const plan = planForFixture(f);
    assert.equal(plan.disposition, "CONFLICT", `${field} must not be silently accepted as a no-op`);
    assert.match(plan.reason, /Size\/Color option updates.*not supported/i);
    assert.deepEqual(plan.variantUpdates, []);
    const result = await f.request();
    assert.equal(result.status, "CONFLICT");
    assert.match(result.message, /Size\/Color option updates.*not supported/i);
    assert.equal(f.mutations.length, 0);
  }
  const route = await readFile(new URL("../app/routes/app.imports.catalog.$batchId.tsx", import.meta.url), "utf8");
  assert.match(route, /if \(proposal\.disposition === "UPDATE" && \(field === "size" \|\| field === "color"\)\) return false;/);
  assert.match(route, /Updating these options on existing products is not supported; choose Keep Shopify/);
});

test("a bounded Shopify mutation timeout records UNKNOWN, aborts the request, and never automatically retries", async () => {
  const f = fixture();
  let signal;
  const originalGraphql = f.admin.graphql.bind(f.admin);
  f.admin.graphql = async (query, options = {}) => {
    if (query.includes("StockHubCatalogVariantSnapshot")) return originalGraphql(query, options);
    if (query.includes("StockHubCatalogProductCreate")) {
      f.calls.push({ query, variables: options.variables ?? {} });
      f.mutations.push({ query, variables: options.variables ?? {} });
      signal = options.signal;
      return new Promise(() => {});
    }
    return originalGraphql(query, options);
  };
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
  global.clearTimeout = () => {};
  let first;
  try { first = await f.request(); }
  finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
  assert.equal(first.status, "UNKNOWN");
  assert.equal(f.state.operations[0].status, "UNKNOWN");
  assert.equal(f.state.attempts.at(-1).status, "UNKNOWN");
  assert.equal(signal?.aborted, true, "the bounded deadline aborts the GraphQL request");
  assert.equal(f.mutations.length, 1);

  await f.request({ reconcileOnly: true });
  assert.equal(f.mutations.length, 1, "a timeout requires reconciliation and does not trigger a blind automatic retry");
});

test("planner rejects unconfirmed execution and makes no implicit destructive plan", () => {
  const lines = [line("line-1")];
  const proposal = { groupTitle: "Wool Shirt", productId: null, rowIds: ["line-1"] };
  const review = { operation: "CREATE", status: "PENDING", shopifyProductId: null, snapshot: { variants: [] }, decisions: decisionsFor(lines) };
  const group = { id: GROUP_ID, confirmedAt: new Date(), selections: { productName: { value: "Wool Shirt" } }, lines };
  assert.throws(() => buildCatalogExecutionPlan({ review, group, mapping: { productName: "productName", sku: "sku", price: "price" }, snapshotVariants: [] }), /Confirm the current saved catalog review/i);
  assert.equal(proposal.groupTitle, "Wool Shirt");
});
