/* eslint-env node */
/* global globalThis */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

const shop = "create-review-test.myshopify.com";
const batchId = "create-review-batch";
const groupId = "create-review-group";
const lineId = "create-review-line";

const line = {
  id: lineId,
  shop,
  batchId,
  rowNumber: 1,
  sourceRowNumber: 2,
  sourceValues: ["New Shirt", "NEW-001", "12.50"],
  productName: "New Shirt",
  sku: "NEW-001",
  price: "12.50",
  priceZeroConfirmed: false,
  size: null,
  color: null,
  vendor: null,
  productType: null,
  description: null,
  imageUrl: null,
  productGroupCode: null,
  status: "READY",
  errors: [],
  groupId,
};

const decisions = {
  schemaVersion: 1,
  group: "CONFIRM",
  productFields: {
    title: "KEEP_SHOPIFY",
    description: "KEEP_SHOPIFY",
    vendor: "KEEP_SHOPIFY",
    productType: "KEEP_SHOPIFY",
  },
  variants: {
    [lineId]: {
      operation: "CREATE",
      fields: {
        sku: "KEEP_SHOPIFY",
        price: "KEEP_SHOPIFY",
        size: "KEEP_SHOPIFY",
        color: "KEEP_SHOPIFY",
      },
    },
  },
};

const review = {
  id: "create-review-record",
  shop,
  batchId,
  groupId,
  draftVersion: 1,
  reviewVersion: 0,
  operation: "CREATE",
  status: "PENDING",
  snapshotFingerprint: "b".repeat(64),
  snapshot: { variants: [] },
  matchedVariantIds: [],
  decisions,
  reviewedAt: null,
};

const group = {
  id: groupId,
  shop,
  batchId,
  source: "productName",
  groupingKey: "new shirt",
  reason: "Test CREATE proposal",
  selections: { productName: { value: "New Shirt", sourceLineId: lineId } },
  validation: [],
  confirmedAt: new Date("2026-10-20T10:00:00.000Z"),
  state: "ACTIVE",
  lines: [line],
};

const batch = {
  id: batchId,
  shop,
  fileName: "create.csv",
  fileChecksum: "a".repeat(64),
  originalCsv: "Product Name,SKU,Price\nNew Shirt,NEW-001,12.50\n",
  sourceHeaders: ["Product Name", "SKU", "Price"],
  mapping: { "0": "productName", "1": "sku", "2": "price" },
  status: "DRAFT",
  draftVersion: 1,
};

const state = { review };
const prisma = {
  catalogImportBatch: {
    findFirst: async () => batch,
    updateMany: async () => ({ count: 1 }),
  },
  catalogImportGroup: {
    findFirst: async () => group,
  },
  catalogImportLine: {
    findMany: async () => [line],
  },
  catalogImportReview: {
    findFirst: async () => state.review,
    updateMany: async ({ data }) => {
      Object.assign(state.review, {
        status: data.status,
        reviewVersion: state.review.reviewVersion + data.reviewVersion.increment,
        reviewedAt: data.reviewedAt,
      });
      return { count: 1 };
    },
  },
  $transaction: async (callback) => callback(prisma),
};

globalThis.__stockhubCatalogCreateReviewTest = {
  prisma,
  auth: async () => ({ session: { shop } }),
};

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: "custom",
  plugins: [{
    name: "stockhub-catalog-create-review-test-mocks",
    enforce: "pre",
    resolveId(source) {
      if (source === "../shopify.server") return "\0stockhub-catalog-create-review-test-shopify.server";
      if (source === "../db.server") return "\0stockhub-catalog-create-review-test-db.server";
      return null;
    },
    load(id) {
      if (id === "\0stockhub-catalog-create-review-test-shopify.server") return "export const authenticate = { admin: async (request) => globalThis.__stockhubCatalogCreateReviewTest.auth(request) };";
      if (id === "\0stockhub-catalog-create-review-test-db.server") return "const prisma = globalThis.__stockhubCatalogCreateReviewTest.prisma; export default prisma;";
      return null;
    },
  }],
  server: { middlewareMode: true, hmr: false },
  ssr: { noExternal: ["@shopify/shopify-app-react-router"] },
  optimizeDeps: { noDiscovery: true, include: [], entries: [] },
  logLevel: "error",
});

test.after(async () => {
  await vite.close();
  delete globalThis.__stockhubCatalogCreateReviewTest;
});

const route = await vite.ssrLoadModule("/app/routes/app.imports.catalog.$batchId.tsx");

test("CREATE review confirmation rejects KEEP_SHOPIFY when Shopify has no current product or variant values", async () => {
  const form = new URLSearchParams({
    intent: "confirm-review",
    draftVersion: "1",
    groupId,
    reviewVersion: "0",
  });
  const result = await route.action({
    request: new Request(`http://localhost/app/imports/catalog/${batchId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    }),
    params: { batchId },
    context: {},
  });

  assert.equal(result.error ? "rejected" : result.status, "rejected",
    "the current route redirects instead of rejecting this unusable CREATE review");
  assert.match(result.error, /current Shopify value|choose.*CSV|cannot keep/i,
    "a CREATE proposal with no current Shopify values must reject KEEP_SHOPIFY decisions");
  assert.equal(state.review.status, "PENDING", "rejected confirmation must not persist CONFIRMED state");
  assert.equal(state.review.reviewVersion, 0, "rejected confirmation must not advance the review version");
});
