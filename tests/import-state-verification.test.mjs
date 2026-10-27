/* eslint-env node */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadVerifier() {
  try {
    const module = await import("../app/utils/import-state-verification.server.ts");
    assert.equal(typeof module.verifyImportBatchShopifyState, "function");
    return module.verifyImportBatchShopifyState;
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("import-state-verification")) {
      assert.fail("Missing regression target app/utils/import-state-verification.server.ts#verifyImportBatchShopifyState");
    }
    throw error;
  }
}

const SHOP = "demo.myshopify.com";
const LOCATION_ID = "gid://shopify/Location/10";
const PRODUCT_ID = "gid://shopify/Product/30";
const VARIANT_ID = "gid://shopify/ProductVariant/20";
const INVENTORY_ITEM_ID = "gid://shopify/InventoryItem/40";
const OPERATION_ID = "operation-1";
const SECRET = "shpat_private-token-do-not-copy";

function makeLine(overrides = {}) {
  return {
    id: "line-1",
    rowNumber: 2,
    sku: "SKU-1",
    title: "Example product",
    quantity: 5,
    operationType: "CREATE_DRAFT",
    status: "FAILED",
    stage: "INVENTORY_ACTIVATING",
    errorCode: "INVENTORY_ACTIVATE_USER_ERROR",
    operationId: OPERATION_ID,
    productId: PRODUCT_ID,
    variantId: VARIANT_ID,
    inventoryItemId: INVENTORY_ITEM_ID,
    ...overrides,
  };
}

function makeBatch(lines = [makeLine()]) {
  return {
    id: "batch-1",
    shop: SHOP,
    locationId: LOCATION_ID,
    locationName: "Main warehouse",
    receiptCode: "IMP-20261022-000001",
    lines,
  };
}

function productData(overrides = {}) {
  const product = {
    id: PRODUCT_ID,
    status: "DRAFT",
    metafield: { value: OPERATION_ID },
    ...overrides.product,
  };
  const variant = {
    id: VARIANT_ID,
    sku: "SKU-1",
    product: {
      id: PRODUCT_ID,
      status: "DRAFT",
      metafield: { value: OPERATION_ID },
      ...overrides.variantProduct,
    },
    inventoryItem: {
      id: INVENTORY_ITEM_ID,
      tracked: true,
      inventoryLevel: null,
      ...overrides.inventoryItem,
    },
    ...overrides.variant,
  };
  return { nodes: [product, variant] };
}

function mockAdmin({ data = productData(), status = 200, errors, rawBody } = {}) {
  const calls = [];
  return {
    calls,
    admin: {
      async graphql(query, options) {
        calls.push({ query, options });
        return new Response(rawBody ?? JSON.stringify({ ...(data === undefined ? {} : { data }), ...(errors ? { errors } : {}) }), { status });
      },
    },
  };
}

async function verify({ line = makeLine(), data = productData(), status = 200, errors, rawBody, batch } = {}) {
  const verifier = await loadVerifier();
  const admin = mockAdmin({ data, status, errors, rawBody });
  const inputBatch = batch ?? makeBatch([line]);
  const before = structuredClone(inputBatch);
  const report = await verifier({
    admin: admin.admin,
    batch: inputBatch,
    locationId: LOCATION_ID,
    locationName: "Main warehouse",
    shop: SHOP,
    now: () => new Date("2026-10-22T04:30:00.000Z"),
  });
  assert.deepEqual(inputBatch, before, "verification must not mutate or persist the supplied batch");
  assert.ok(admin.calls.length > 0, "verification must query Shopify state");
  assert.ok(admin.calls.every(({ query }) => !/\bmutation\b/i.test(query)), "verification must not write Shopify state");
  return { report, calls: admin.calls };
}

function classification(report, lineId = "line-1") {
  return report.lines.find((line) => line.id === lineId)?.classification;
}

test("only the exact failed inventory-activation CREATE_DRAFT with matching marked tracked Draft and no level is a candidate", async () => {
  const { report } = await verify();

  assert.equal(classification(report), "SAFE_CANDIDATE");
  assert.equal(report.verifiedAt, "2026-10-22T04:30:00.000Z");
  assert.equal(report.counts.total, 1);
  assert.equal(report.counts.safeCandidate, 1);
  assert.equal(report.counts.blocked, 0);
  assert.equal(report.counts.uncertain, 0);
  assert.equal(typeof report.copyText, "string");
  assert.ok(report.copyText.length > 0);
});

test("identity, marker, product status, or tracked mismatch blocks retry; existing InventoryLevel is uncertain", async (t) => {
  const variants = [
    ["product mismatch", productData({ variantProduct: { id: "gid://shopify/Product/999" } }), "BLOCKED"],
    ["variant mismatch", productData({ variant: { id: "gid://shopify/ProductVariant/999" } }), "BLOCKED"],
    ["inventory item mismatch", productData({ inventoryItem: { id: "gid://shopify/InventoryItem/999" } }), "BLOCKED"],
    ["SKU mismatch", productData({ variant: { sku: "OTHER" } }), "BLOCKED"],
    ["foreign marker", productData({ variantProduct: { metafield: { value: "another-operation" } } }), "BLOCKED"],
    ["deleted product", { nodes: [null, null] }, "BLOCKED"],
    ["non-Draft product", productData({ variantProduct: { status: "ACTIVE" } }), "BLOCKED"],
    ["untracked inventory", productData({ inventoryItem: { tracked: false } }), "BLOCKED"],
    ["inventory level already exists", productData({ inventoryItem: { inventoryLevel: { quantities: [{ name: "available", quantity: 0 }] } } }), "UNCERTAIN"],
  ];
  for (const [label, data, expected] of variants) {
    await t.test(label, async () => {
      const { report } = await verify({ data });
      assert.equal(classification(report), expected);
    });
  }
});

test("only the known activation rejection qualifies; ADJUST with prior mutation state remains uncertain", async (t) => {
  const nonEligible = [
    makeLine({ errorCode: "INVENTORY_ACTIVATE_UNCERTAIN" }),
    makeLine({ errorCode: "OTHER_ERROR" }),
    makeLine({ status: "SUCCEEDED" }),
    makeLine({ stage: "PRODUCT_CREATED" }),
  ];
  for (const line of nonEligible) {
    await t.test(`${line.status}/${line.stage}/${line.errorCode}`, async () => {
      const { report } = await verify({ line });
      assert.notEqual(classification(report), "SAFE_CANDIDATE");
    });
  }

  const adjust = makeLine({
    operationType: "ADJUST",
    status: "UNCERTAIN",
    stage: "ADJUSTING",
    errorCode: "INVENTORY_ADJUST_UNCERTAIN",
  });
  const { report } = await verify({ line: adjust });
  assert.equal(classification(report), "UNCERTAIN");
});

test("unauthorized responses, GraphQL errors, malformed responses, and missing nodes are uncertain", async (t) => {
  const failures = [
    ["HTTP 401", { status: 401, rawBody: JSON.stringify({ errors: [{ message: SECRET }] }) }],
    ["HTTP 403", { status: 403, rawBody: JSON.stringify({ errors: [{ message: SECRET }] }) }],
    ["GraphQL errors", { errors: [{ message: SECRET }] }],
    ["malformed JSON", { rawBody: "not-json" }],
    ["missing data", { data: {} }],
    ["missing nodes", { data: { nodes: [] } }],
  ];
  for (const [label, options] of failures) {
    await t.test(label, async () => {
      const { report } = await verify(options);
      assert.equal(classification(report), "UNCERTAIN");
      assert.match(report.safeMessage, /no (retry|mutation)|cannot.*(verify|confirm)|uncertain/i);
    });
  }
});

test("live verification failure takes precedence over a saved SUCCEEDED status", async (t) => {
  const succeeded = makeLine({ status: "SUCCEEDED", stage: "COMPLETED", errorCode: null });
  const failures = [
    ["HTTP 401", { status: 401, rawBody: JSON.stringify({ errors: [{ message: SECRET }] }) }],
    ["HTTP 403", { status: 403, rawBody: JSON.stringify({ errors: [{ message: SECRET }] }) }],
    ["GraphQL error", { errors: [{ message: SECRET }] }],
  ];
  for (const [label, options] of failures) {
    await t.test(label, async () => {
      const { report } = await verify({ line: succeeded, ...options });
      assert.equal(classification(report), "UNCERTAIN");
    });
  }

  const { report } = await verify({ line: succeeded });
  assert.equal(classification(report), "BLOCKED", "a successful read must never make a completed line retryable");
});

test("copy text is sanitized and does not expose Shopify IDs, API tokens, or raw GraphQL errors", async () => {
  const { report } = await verify({ errors: [{ message: `Authorization ${SECRET} failed at ${PRODUCT_ID}` }] });
  assert.equal(typeof report.copyText, "string");
  for (const sensitive of [SECRET, PRODUCT_ID, VARIANT_ID, INVENTORY_ITEM_ID, LOCATION_ID]) {
    assert.equal(report.copyText.includes(sensitive), false);
  }
});

test("verification action authenticates first and scopes receipt lookup to the session shop", async () => {
  const source = await readFile(new URL("../app/routes/app.imports._index.tsx", import.meta.url), "utf8");
  const action = source.slice(source.indexOf("export const action ="));
  const authIndex = action.indexOf("await authenticate.admin(request)");
  const intentIndex = action.indexOf("const intent = formData.get(\"intent\")");
  assert.ok(authIndex >= 0 && intentIndex > authIndex, "authenticate.admin must run before intent routing");

  const verifyStart = action.indexOf('if (intent === "verifyShopifyState")');
  const verifyEnd = action.indexOf('if (intent === "merge" || intent === "resume")', verifyStart);
  assert.ok(verifyStart >= 0 && verifyEnd > verifyStart, "verification intent branch must be explicit");
  const verifyBranch = action.slice(verifyStart, verifyEnd);
  assert.match(verifyBranch, /prisma\.importBatch\.findFirst\(\{\s*where:\s*\{\s*id:\s*batchId,\s*shop:\s*session\.shop\s*\}/,
    "verification must load the receipt using both its ID and authenticated shop");
});

test("verification requires current read grants and an active authorized receipt location without Prisma writes", async () => {
  const source = await readFile(new URL("../app/routes/app.imports._index.tsx", import.meta.url), "utf8");
  const action = source.slice(source.indexOf("export const action ="));
  const verifyStart = action.indexOf('if (intent === "verifyShopifyState")');
  const verifyEnd = action.indexOf('if (intent === "merge" || intent === "resume")', verifyStart);
  assert.ok(verifyStart >= 0 && verifyEnd > verifyStart, "verification intent branch must be explicit");
  const verifyBranch = action.slice(verifyStart, verifyEnd);

  assert.match(verifyBranch, /missingScopesForGrant\(grantedScopes,\s*\["read_products",\s*"read_inventory",\s*"read_locations"\]\)/,
    "verification must require current product, inventory, and location read grants");
  assert.match(verifyBranch, /queryLocations\(admin\)/, "verification must re-read current authorized locations");
  assert.match(verifyBranch, /sameScopeGrant\(grantedScopes,\s*locationContext\.scopes\)/,
    "location and Admin API scope grants must agree");
  assert.match(verifyBranch, /locationContext\.shopDomain\.toLowerCase\(\)\s*!==\s*session\.shop\.toLowerCase\(\)/,
    "verification must confirm the Admin API store matches the authenticated session");
  assert.match(verifyBranch, /locationContext\.locations\.some\(\(location\)\s*=>\s*location\.id\s*===\s*batch\.locationId\s*&&\s*location\.isActive\)/,
    "verification must require the receipt location to be active and authorized");
  assert.doesNotMatch(verifyBranch, /prisma\.\w+\.(?:update|updateMany|create|createMany|delete|deleteMany|upsert)\s*\(/,
    "the read-only verification branch must not persist changes");
});

test("each history receipt renders one verification action and verification results show counts, reasons, and Copy result", async () => {
  const source = await readFile(new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url), "utf8");
  const [verifyForm] = source.match(/<Form method="post">\s*<input[^>]+name="intent"\s+value="verifyShopifyState"[^>]*\/>\s*<input[^>]+name="batchId"\s+value=\{batch\.id\}[^>]*\/>[\s\S]*?<\/Form>/) ?? [];
  assert.ok(verifyForm, "receipt detail must expose one manual verification form");
  assert.equal((verifyForm.match(/Verify Shopify State/g) ?? []).length, 1,
    "selected receipt detail must provide exactly one Verify action");

  const reportStart = source.indexOf("{actionData?.verification ?");
  const reportEnd = source.indexOf("{batch.lines.length || draftEditable ?", reportStart);
  assert.ok(reportStart >= 0 && reportEnd > reportStart, "the route must render verification report output");
  const report = source.slice(reportStart, reportEnd);
  assert.match(report, /counts\.SAFE_CANDIDATE/);
  assert.match(report, /counts\.BLOCKED/);
  assert.match(report, /counts\.UNCERTAIN/,
    "the report must display blocked, safe-candidate, and uncertain counts");
  assert.match(report, /row\.reasons\.join/, "the report must display per-row reasons");
  assert.match(report, />Copy verification result<\//, "the report must provide a Copy result action");

  const statusRegion = source.match(/<div\s+role="status"\s+aria-live="polite"\s+aria-atomic="true"[\s\S]*?>\{verificationAnnouncement\}<\/div>/)?.[0];
  const statusIndex = statusRegion ? source.indexOf(statusRegion) : -1;
  assert.ok(statusIndex >= 0 && statusIndex < reportStart,
    "a persistent polite status region must be mounted before verification results arrive");
  const announcementStart = source.indexOf("const verificationAnnouncement =");
  const announcementEnd = source.indexOf("const confirmedInventoryActivated =", announcementStart);
  const announcement = source.slice(announcementStart, announcementEnd);
  assert.match(announcement, /actionData\?\.verification/);
  assert.match(announcement, /verifiedAt/);
  assert.match(announcement, /counts\.SAFE_CANDIDATE/);
  assert.match(announcement, /counts\.BLOCKED/);
  assert.match(announcement, /counts\.UNCERTAIN/,
    "the live announcement must summarize all verification outcomes");
});

test("verification results can be filtered by classification and explain their read-only meaning", async () => {
  const source = await readFile(new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url), "utf8");
  assert.match(source, /id="verification-classification-filter"[\s\S]*?value="SAFE_CANDIDATE"[\s\S]*?value="BLOCKED"[\s\S]*?value="UNCERTAIN"/,
    "the result view must offer each classification as a local filter");
  assert.match(source, /verificationFilter === "ALL" \|\| row\.classification === verificationFilter/,
    "filtering must only affect displayed snapshot rows");
  assert.match(source, /read-only snapshot[\s\S]*?does not change this receipt or authorize a later merge\/resume/,
    "the interface must explain that a verification snapshot is not mutation authorization");
  assert.match(source, /safe candidate means[\s\S]*?blocked means[\s\S]*?uncertain means/i,
    "all classifications must have a human-readable explanation");
});

test("Verify summary and per-SKU rows use human-readable classification labels", async () => {
  const source = await readFile(new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url), "utf8");
  assert.match(source, /Safe candidate \{actionData\.verification\.counts\.SAFE_CANDIDATE\} · Blocked \{actionData\.verification\.counts\.BLOCKED\} · Uncertain \{actionData\.verification\.counts\.UNCERTAIN\}/,
    "the visible summary should present readable labels while retaining the same count fields");
  assert.match(source, /function verificationClassificationLabel[\s\S]*?"Safe candidate"[\s\S]*?"Blocked"[\s\S]*?"Uncertain"/,
    "the mapping should preserve each raw classification while giving it a readable display label");
  assert.match(source, /<s-table-cell>\{verificationClassificationLabel\(row\.classification\)\}<\/s-table-cell>/,
    "per-SKU classification cells should render the readable label rather than the enum");
});

test("receipt detail explicitly explains confirmed Draft creation followed by inventory activation failure", async () => {
  const source = await readFile(new URL("../app/routes/app.imports.history.$batchId.tsx", import.meta.url), "utf8");
  assert.match(source, /createdDraftInventoryFailures[\s\S]*?stage === "INVENTORY_ACTIVATING"[\s\S]*?INVENTORY_ACTIVATE_/,
    "the warning must be driven by persisted product and inventory-activation stage data");
  assert.match(source, /Products were created, but inventory activation failed[\s\S]*?saved receipt status has not been changed/,
    "the UI must explain the partial outcome without rewriting history");
});
