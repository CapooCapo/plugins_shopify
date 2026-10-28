import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { buildCatalogExecutionPlan, canonicalCatalogPrice, catalogExecutionIdempotencyKey, fingerprintForCatalogReview, type CatalogExecutionPlan } from "./catalog-execution.shared";
import { readShopifyCatalogSnapshot } from "./catalog-shopify-read.server";
import { missingScopesForGrant, queryGrantedScopes, type ShopifyScopesApi } from "./shopify-scopes.server";

const PRODUCT_CREATE = `#graphql
  mutation StockHubCatalogProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id title descriptionHtml vendor productType status tags metafield(namespace: "$app", key: "catalog_execution_id") { value } variants(first: 250) { nodes { id sku price selectedOptions { name value } } pageInfo { hasNextPage } } }
      userErrors { field message }
    }
  }
`;
const PRODUCT_UPDATE = `#graphql
  mutation StockHubCatalogProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id title descriptionHtml vendor productType } userErrors { field message } }
  }
`;
const VARIANTS_UPDATE = `#graphql
  mutation StockHubCatalogVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $allowPartialUpdates: Boolean!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: $allowPartialUpdates) {
      product { id }
      productVariants { id sku price selectedOptions { name value } }
      userErrors { field message }
    }
  }
`;
const VARIANTS_CREATE = `#graphql
  mutation StockHubCatalogVariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      product { id }
      productVariants { id sku price selectedOptions { name value } }
      userErrors { field message }
    }
  }
`;
const RECONCILE_CREATE = `#graphql
  query StockHubCatalogFindOperationProduct($search: String!) {
    shop { myshopifyDomain }
    products(first: 2, query: $search) {
      nodes { id title descriptionHtml vendor productType status tags metafield(namespace: "$app", key: "catalog_execution_id") { value } variants(first: 250) { nodes { id sku price selectedOptions { name value } } pageInfo { hasNextPage } } }
    }
  }
`;
const RUNNING_OPERATION_RECOVERY_MS = 5 * 60 * 1000;
const RECONCILIATION_LEASE_MS = 5 * 60 * 1000;
const SHOPIFY_MUTATION_TIMEOUT_MS = 20_000;

type AdminGraphql = { graphql: (query: string, options?: { variables?: Record<string, unknown>; signal?: AbortSignal; tries?: number }) => Promise<Response> };
type CatalogPrisma = PrismaClient;
type RuntimeEnv = NodeJS.ProcessEnv;
type DbIdentity = { database: string; role: string; serverAddress: string | null; clientAddress: string | null; serverPort: number };
type CatalogReviewVersion = {
  id: string;
  shop: string;
  batchId: string;
  groupId: string;
  draftVersion: number;
  reviewVersion: number;
  operation: string;
  status: string;
  snapshotFingerprint: string;
  snapshot: Prisma.JsonValue;
  shopifyProductId: string | null;
  matchedVariantIds: Prisma.JsonValue;
  decisions: Prisma.JsonValue;
  snapshotCapturedAt: Date;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Archive a review version once; an existing history row is immutable. */
export async function archiveCatalogReviewVersion(tx: Prisma.TransactionClient, review: CatalogReviewVersion) {
  await tx.catalogImportReviewHistory.createMany({
    data: [{
      id: review.id, shop: review.shop, batchId: review.batchId, groupId: review.groupId,
      draftVersion: review.draftVersion, reviewVersion: review.reviewVersion, operation: review.operation,
      status: review.status, snapshotFingerprint: review.snapshotFingerprint, snapshot: review.snapshot as Prisma.InputJsonValue,
      shopifyProductId: review.shopifyProductId, matchedVariantIds: review.matchedVariantIds as Prisma.InputJsonValue,
      decisions: review.decisions as Prisma.InputJsonValue, snapshotCapturedAt: review.snapshotCapturedAt,
      reviewedAt: review.reviewedAt, createdAt: review.createdAt, updatedAt: review.updatedAt,
    }],
    skipDuplicates: true,
  });
}

export type CatalogExecutionRuntimeConfig = { shop: string; appId: string; databaseName: string; databaseUser: string; databaseServerAddress: string; databaseServerPort: number };

function normalizedPostgresInet(value: string | null) {
  if (!value) return null;
  // Accept only the canonical loopback literals PostgreSQL may report, with
  // their exact host prefixes. Do not normalize mapped IPv6 or alternate
  // spellings into an allowed address; this gate must fail closed.
  if (value === "127.0.0.1" || value === "127.0.0.1/32") return "127.0.0.1";
  if (value === "::1" || value === "::1/128") return "::1";
  return null;
}

function isLoopbackAddress(value: string | null) {
  if (!value) return false;
  const address = normalizedPostgresInet(value);
  return address === "127.0.0.1" || address === "::1";
}

/** The application must opt in with explicit identities. Merely running Vite/Shopify CLI never enables this gate. */
export function validateCatalogExecutionGateConfig(shop: string, environment: RuntimeEnv = process.env): CatalogExecutionRuntimeConfig {
  if (environment.STOCKHUB_CATALOG_EXECUTION_ENABLED !== "true") throw new Error("Catalog execution is disabled. Configure the explicit local development identities before enabling it.");
  const expectedAppId = environment.STOCKHUB_CATALOG_EXECUTION_EXPECTED_DEV_APP_ID?.trim();
  const appId = environment.SHOPIFY_API_KEY?.trim();
  if (!expectedAppId || !appId || expectedAppId !== appId) throw new Error("Catalog execution is blocked because the running Shopify app identity does not match the explicitly expected Development App.");
  const expectedShop = environment.STOCKHUB_CATALOG_EXECUTION_EXPECTED_DEV_STORE?.trim().toLowerCase();
  if (!expectedShop || shop.trim().toLowerCase() !== expectedShop) throw new Error("Catalog execution is blocked because the authenticated store does not match the explicitly expected development store.");
  const databaseUrl = environment.DATABASE_URL;
  const expectedDatabaseUrl = environment.STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_URL;
  const expectedDatabaseUser = environment.STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_USER?.trim();
  const expectedDatabaseServerAddressRaw = environment.STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_SERVER_ADDRESS?.trim();
  const expectedDatabaseServerPortRaw = environment.STOCKHUB_CATALOG_EXECUTION_EXPECTED_DATABASE_SERVER_PORT?.trim();
  const expectedDatabaseServerPort = expectedDatabaseServerPortRaw ? Number(expectedDatabaseServerPortRaw) : Number.NaN;
  if (!databaseUrl || !expectedDatabaseUrl || databaseUrl !== expectedDatabaseUrl || !expectedDatabaseUser || !expectedDatabaseServerAddressRaw || !Number.isInteger(expectedDatabaseServerPort) || expectedDatabaseServerPort < 1 || expectedDatabaseServerPort > 65535) {
    throw new Error("Catalog execution is blocked because the database target is not explicitly pinned to the isolated local test database.");
  }
  const databaseServerAddress = normalizedPostgresInet(expectedDatabaseServerAddressRaw);
  if (!isLoopbackAddress(databaseServerAddress)) throw new Error("Catalog execution is blocked because the expected PostgreSQL server address must be 127.0.0.1 or ::1; private-network addresses may be tunnels to managed databases.");
  let parsed: URL;
  try { parsed = new URL(databaseUrl); } catch { throw new Error("Catalog execution is blocked because the configured local database target is invalid."); }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const databaseUser = decodeURIComponent(parsed.username);
  if (!(["127.0.0.1", "localhost", "::1"].includes(host)) || parsed.port !== "55432" || databaseName !== "stockhub_regression" || databaseUser !== expectedDatabaseUser) {
    throw new Error("Catalog execution is blocked because DATABASE_URL is not the explicitly pinned loopback stockhub_regression database on port 55432.");
  }
  return { shop: expectedShop, appId, databaseName, databaseUser, databaseServerAddress: databaseServerAddress!, databaseServerPort: expectedDatabaseServerPort };
}

/** Confirms the live Prisma connection identity only after the URL has passed the no-network config gate. */
export async function verifyCatalogExecutionDatabase(prisma: Pick<CatalogPrisma, "$queryRaw">, config: CatalogExecutionRuntimeConfig) {
  if (!isLoopbackAddress(config.databaseServerAddress)) throw new Error("Catalog execution is blocked because the expected PostgreSQL server address is not loopback.");
  let rows: DbIdentity[];
  try {
    rows = await prisma.$queryRaw<DbIdentity[]>`
      SELECT current_database() AS database,
             current_user AS role,
             inet_server_addr()::text AS "serverAddress",
             inet_client_addr()::text AS "clientAddress",
             inet_server_port() AS "serverPort"
    `;
  } catch {
    throw new Error("Catalog execution is blocked because the isolated local PostgreSQL identity could not be verified.");
  }
  const identity = rows[0];
  if (!identity || identity.database !== config.databaseName || identity.role !== config.databaseUser ||
    normalizedPostgresInet(identity.serverAddress) !== config.databaseServerAddress || !isLoopbackAddress(identity.serverAddress) || !isLoopbackAddress(identity.clientAddress) || identity.serverPort !== config.databaseServerPort) {
    throw new Error("Catalog execution is blocked because the connected PostgreSQL server identity is not the expected isolated local test database.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getProposal(snapshot: unknown) {
  if (!isRecord(snapshot) || !isRecord(snapshot.proposal)) throw new Error("The saved catalog proposal is incomplete. Compare and confirm again before execution.");
  return snapshot.proposal;
}

function readShop(value: unknown): string | null {
  return isRecord(value) && typeof value.myshopifyDomain === "string" ? value.myshopifyDomain : null;
}

function markerTag(operationId: string) { return `stockhub-catalog-exec-${operationId.replaceAll("-", "").toLowerCase()}`; }

function safeError(code: string) {
  const messages: Record<string, string> = {
    SHOPIFY_REJECTED: "Shopify rejected the catalog change. Review the product data and retry the failed operation.",
    RATE_LIMITED: "Shopify rate-limited this catalog change before processing it. Wait briefly, then retry the rejected operation.",
    SHOPIFY_UNKNOWN: "Shopify may have accepted this catalog change, but its result could not be verified. Reconcile the operation before taking further action.",
    INVALID_RESPONSE: "Shopify returned an incomplete catalog result. Reconcile the operation before retrying.",
  };
  return messages[code] ?? "Catalog execution could not be completed safely.";
}

type MutationResult = { ok: true; payload: Record<string, unknown> } | { ok: false; status: "FAILED" | "UNKNOWN"; code: string };

async function renewReconciliationLease(prisma: CatalogPrisma, shop: string, operationId: string, claimToken: string) {
  const now = new Date();
  const renewed = await prisma.catalogExecutionOperation.updateMany({
    where: { shop, id: operationId, status: "RECONCILING", claimToken, claimExpiresAt: { gt: now } },
    data: { claimExpiresAt: new Date(now.getTime() + RECONCILIATION_LEASE_MS) },
  });
  return renewed.count === 1;
}

async function sendMutation(input: {
  prisma: CatalogPrisma; admin: AdminGraphql; shop: string; operationId: string; itemId?: string | null;
  claimToken?: string;
  mutation: "productCreate" | "productUpdate" | "productVariantsBulkUpdate" | "productVariantsBulkCreate";
  query: string; variables: Record<string, unknown>; requiredCount?: number;
}) : Promise<MutationResult> {
  if (input.claimToken && !await renewReconciliationLease(input.prisma, input.shop, input.operationId, input.claimToken)) return { ok: false, status: "UNKNOWN", code: "SHOPIFY_UNKNOWN" };
  const attemptId = randomUUID();
  const requestHash = createHash("sha256").update(JSON.stringify(input.variables)).digest("hex");
  await input.prisma.catalogExecutionAttempt.create({ data: {
    id: attemptId, shop: input.shop, operationId: input.operationId, itemId: input.itemId ?? null,
    mutation: input.mutation, status: "PREPARED", requestHash, claimToken: input.claimToken ?? null,
  } });
  // Recheck immediately before the network call as attempt persistence is an
  // asynchronous boundary at which an expired lease could be taken over.
  if (input.claimToken && !await renewReconciliationLease(input.prisma, input.shop, input.operationId, input.claimToken)) {
    await input.prisma.catalogExecutionAttempt.update({ where: { id: attemptId }, data: { status: "UNKNOWN", errorCode: "SHOPIFY_UNKNOWN", detail: safeError("SHOPIFY_UNKNOWN"), finishedAt: new Date() } });
    return { ok: false, status: "UNKNOWN", code: "SHOPIFY_UNKNOWN" };
  }
  let response: Response;
  let body: unknown;
  try {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await input.admin.graphql(input.query, { variables: input.variables, signal: controller.signal, tries: 1 });
          if (!response.ok || response.status === 429) return { response, body: undefined };
          return { response, body: await response.json() as unknown };
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Shopify mutation deadline exceeded"));
          }, SHOPIFY_MUTATION_TIMEOUT_MS);
        }),
      ]);
      response = result.response;
      body = result.body;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (response.status === 429) {
      await input.prisma.catalogExecutionAttempt.update({ where: { id: attemptId }, data: { status: "FAILED", errorCode: "RATE_LIMITED", detail: safeError("RATE_LIMITED"), finishedAt: new Date() } });
      return { ok: false, status: "FAILED", code: "RATE_LIMITED" };
    }
    if (!response.ok) throw new Error("transport");
  } catch {
    await input.prisma.catalogExecutionAttempt.update({ where: { id: attemptId }, data: { status: "UNKNOWN", errorCode: "SHOPIFY_UNKNOWN", detail: safeError("SHOPIFY_UNKNOWN"), finishedAt: new Date() } });
    return { ok: false, status: "UNKNOWN", code: "SHOPIFY_UNKNOWN" };
  }
  if (isRecord(body) && Array.isArray(body.errors) && body.errors.length > 0 && body.errors.every((error) => isRecord(error) && isRecord(error.extensions) && error.extensions.code === "THROTTLED")) {
    await input.prisma.catalogExecutionAttempt.update({ where: { id: attemptId }, data: { status: "FAILED", errorCode: "RATE_LIMITED", detail: safeError("RATE_LIMITED"), finishedAt: new Date() } });
    return { ok: false, status: "FAILED", code: "RATE_LIMITED" };
  }
  if (!isRecord(body) || Array.isArray(body.errors) && body.errors.length > 0 || !isRecord(body.data)) {
    await input.prisma.catalogExecutionAttempt.update({ where: { id: attemptId }, data: { status: "UNKNOWN", errorCode: "SHOPIFY_UNKNOWN", detail: safeError("SHOPIFY_UNKNOWN"), finishedAt: new Date() } });
    return { ok: false, status: "UNKNOWN", code: "SHOPIFY_UNKNOWN" };
  }
  const payload = body.data[input.mutation];
  if (!isRecord(payload)) {
    await input.prisma.catalogExecutionAttempt.update({ where: { id: attemptId }, data: { status: "UNKNOWN", errorCode: "INVALID_RESPONSE", detail: safeError("INVALID_RESPONSE"), finishedAt: new Date() } });
    return { ok: false, status: "UNKNOWN", code: "INVALID_RESPONSE" };
  }
  const userErrors = payload.userErrors;
  if (!Array.isArray(userErrors) || userErrors.some((error) => !isRecord(error) || typeof error.message !== "string")) {
    await input.prisma.catalogExecutionAttempt.update({ where: { id: attemptId }, data: { status: "UNKNOWN", errorCode: "INVALID_RESPONSE", detail: safeError("INVALID_RESPONSE"), finishedAt: new Date() } });
    return { ok: false, status: "UNKNOWN", code: "INVALID_RESPONSE" };
  }
  const returnedProduct = isRecord(payload.product) && typeof payload.product.id === "string";
  const returnedVariants = Array.isArray(payload.productVariants) ? payload.productVariants.filter((item) => isRecord(item) && typeof item.id === "string") : [];
  if (userErrors.length) {
    const possiblePartial = returnedProduct || returnedVariants.length > 0;
    const status = possiblePartial ? "UNKNOWN" : "FAILED";
    const code = possiblePartial ? "SHOPIFY_UNKNOWN" : "SHOPIFY_REJECTED";
    await input.prisma.catalogExecutionAttempt.update({ where: { id: attemptId }, data: { status, errorCode: code, detail: safeError(code), finishedAt: new Date() } });
    return { ok: false, status, code };
  }
  const count = input.requiredCount ?? 0;
  const hasExpectedResult = input.mutation === "productCreate" || input.mutation === "productUpdate"
    ? returnedProduct
    : returnedProduct && returnedVariants.length === count;
  if (!hasExpectedResult) {
    await input.prisma.catalogExecutionAttempt.update({ where: { id: attemptId }, data: { status: "UNKNOWN", errorCode: "INVALID_RESPONSE", detail: safeError("INVALID_RESPONSE"), finishedAt: new Date() } });
    return { ok: false, status: "UNKNOWN", code: "INVALID_RESPONSE" };
  }
  await input.prisma.catalogExecutionAttempt.update({ where: { id: attemptId }, data: { status: "SUCCEEDED", finishedAt: new Date() } });
  return { ok: true, payload };
}

function priceAndOptionsMatch(variant: Record<string, unknown>, item: { sku: string | null; price: string | null; optionValues: Array<{ optionName: string; name: string }> }) {
  if (variant.sku !== item.sku || canonicalCatalogPrice(variant.price) !== canonicalCatalogPrice(item.price)) return false;
  const selected = Array.isArray(variant.selectedOptions) ? variant.selectedOptions.filter(isRecord) : [];
  const expectedOptions = item.optionValues.length ? item.optionValues : [{ optionName: "Title", name: "Default Title" }];
  return selected.length === expectedOptions.length && expectedOptions.every((expected) => selected.some((actual) => actual.name === expected.optionName && actual.value === expected.name));
}

async function reconcileUnknown(input: {
  prisma: CatalogPrisma; admin: AdminGraphql; shop: string; claimToken: string; operation: { id: string; productId: string | null; result?: unknown };
  plan: CatalogExecutionPlan; snapshot?: Awaited<ReturnType<typeof readShopifyCatalogSnapshot>>;
}): Promise<{ status: string; message: string; productId: string | null }> {
  const { operation, plan } = input;
  if (plan.disposition === "CREATE") {
    const tag = markerTag(operation.id);
    let response: Response;
    let body: unknown;
    try {
      response = await input.admin.graphql(RECONCILE_CREATE, { variables: { search: `tag:${tag}` } });
      if (!response.ok) throw new Error("response");
      body = await response.json();
    } catch { return { status: "UNKNOWN", message: safeError("SHOPIFY_UNKNOWN"), productId: typeof operation.productId === "string" ? operation.productId : null }; }
    if (!isRecord(body) || Array.isArray(body.errors) && body.errors.length || !isRecord(body.data) || readShop(body.data.shop)?.toLowerCase() !== input.shop.toLowerCase()) {
      return { status: "UNKNOWN", message: safeError("SHOPIFY_UNKNOWN"), productId: null };
    }
    const connection = body.data.products;
    const products = isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes.filter(isRecord) : null;
    if (!products || products.length !== 1) return { status: "UNKNOWN", message: safeError("SHOPIFY_UNKNOWN"), productId: null };
    const product = products[0]!;
    const marker = isRecord(product.metafield) ? product.metafield.value : null;
    const productTags = Array.isArray(product.tags) ? product.tags : null;
    const variantsConnection = product.variants;
    const variantsPageInfo = isRecord(variantsConnection) ? variantsConnection.pageInfo : null;
    const variants = isRecord(variantsConnection) && Array.isArray(variantsConnection.nodes) ? variantsConnection.nodes.filter(isRecord) : null;
    const expectedProduct = plan.productCreate ?? {};
    const productFieldsMatch = Object.entries(expectedProduct).filter(([field]) => ["title", "descriptionHtml", "vendor", "productType"].includes(field)).every(([field, value]) => product[field] === value);
    if (marker !== operation.id || !productTags?.includes(tag) || product.status !== "DRAFT" || typeof product.id !== "string" || !productFieldsMatch || !variants || !isRecord(variantsPageInfo) || variantsPageInfo.hasNextPage !== false) {
      return { status: "UNKNOWN", message: safeError("SHOPIFY_UNKNOWN"), productId: typeof product.id === "string" ? product.id : null };
    }
    const verifiedProductId = product.id;
    const expected = plan.items.filter((item) => item.disposition === "CREATE");
    const matches = expected.map((item) => variants.filter((variant) => priceAndOptionsMatch(variant, item)));
    const matchedIds = matches.map((items) => items[0]?.id).filter((id): id is string => typeof id === "string");
    const complete = variants.length === expected.length && matches.every((items) => items.length === 1) && new Set(matchedIds).size === expected.length;
    if (!complete) return { status: "UNKNOWN", message: safeError("SHOPIFY_UNKNOWN"), productId: product.id };
    await input.prisma.$transaction(async (tx) => {
      const finished = await tx.catalogExecutionOperation.updateMany({ where: { shop: input.shop, id: operation.id, status: "RECONCILING", claimToken: input.claimToken }, data: { status: "SUCCEEDED", claimToken: null, claimExpiresAt: null, productId: verifiedProductId, result: { productId: verifiedProductId, reconciled: true, variantCount: expected.length }, errorCode: null, errorDetail: null, completedAt: new Date() } });
      if (finished.count !== 1) throw new Error("Catalog reconciliation lease changed before completion.");
      for (const item of expected) {
        const variant = variants.find((candidate) => priceAndOptionsMatch(candidate, item));
        if (!variant || typeof variant.id !== "string") continue;
        const variantId = variant.id;
        await tx.catalogExecutionItem.updateMany({ where: { shop: input.shop, operationId: operation.id, lineId: item.lineId }, data: { status: "SUCCEEDED", productId: verifiedProductId, variantId, errorCode: null, errorDetail: null } });
      }
      await tx.catalogExecutionAttempt.updateMany({ where: { shop: input.shop, operationId: operation.id, status: "UNKNOWN" }, data: { status: "RECONCILED", finishedAt: new Date() } });
    });
    return { status: "SUCCEEDED", message: "Shopify confirms this Draft product and all approved variants were created; no retry mutation was sent.", productId: verifiedProductId };
  }

  const snapshot = input.snapshot ?? await readShopifyCatalogSnapshot((query, options) => input.admin.graphql(query, options) as Promise<Response>, input.shop).catch(() => null);
  if (!snapshot) return { status: "UNKNOWN", message: safeError("SHOPIFY_UNKNOWN"), productId: typeof operation.productId === "string" ? operation.productId : null };
  const productId = plan.productId ?? (typeof operation.productId === "string" ? operation.productId : null);
  if (!productId) return { status: "UNKNOWN", message: safeError("SHOPIFY_UNKNOWN"), productId: null };
  const originalProductFields = plan.originalProductFields;
  const originalVariantFields = plan.originalVariantFields;
  const productVariants = snapshot.variants.filter((variant) => variant.productId === productId);
  const product = productVariants[0];
  const productFieldStates: Record<string, string> = {};
  let hasUnappliedFields = false;
  const conflicts: string[] = [];
  for (const [field, target] of Object.entries(plan.productUpdate)) {
    if (!originalProductFields || !Object.hasOwn(originalProductFields, field) || !product) {
      productFieldStates[field] = "AMBIGUOUS";
      conflicts.push(`product.${field}`);
      continue;
    }
    const current = field === "title" ? product.productTitle : field === "descriptionHtml" ? product.productDescription : field === "vendor" ? product.vendor : field === "productType" ? product.productType : undefined;
    const original = originalProductFields[field];
    if (current === target) productFieldStates[field] = "APPLIED";
    else if (current === original) { productFieldStates[field] = "UNAPPLIED"; hasUnappliedFields = true; }
    else { productFieldStates[field] = "CONFLICT"; conflicts.push(`product.${field}`); }
  }

  const variantFieldStates: Record<string, Record<string, string>> = {};
  for (const expected of plan.variantUpdates) {
    const matches = snapshot.variants.filter((variant) => variant.id === expected.id && variant.productId === productId);
    const baseline = originalVariantFields?.[expected.id];
    const states: Record<string, string> = {};
    if (matches.length !== 1 || !baseline) {
      states.target = "AMBIGUOUS";
      conflicts.push(`variant.${expected.id}`);
      variantFieldStates[expected.id] = states;
      continue;
    }
    const current = matches[0]!;
    for (const field of ["sku", "price"] as const) {
      if (!Object.hasOwn(expected, field)) continue;
      if (!Object.hasOwn(baseline, field)) {
        states[field] = "AMBIGUOUS";
        conflicts.push(`variant.${expected.id}.${field}`);
        continue;
      }
      const currentValue = current[field];
      const targetValue = expected[field];
      const originalValue = baseline[field];
      const equal = field === "price" ? (left: unknown, right: unknown) => canonicalCatalogPrice(left) === canonicalCatalogPrice(right) : (left: unknown, right: unknown) => left === right;
      if (equal(currentValue, targetValue)) states[field] = "APPLIED";
      else if (equal(currentValue, originalValue)) {
        states[field] = "UNAPPLIED";
        hasUnappliedFields = true;
      } else {
        states[field] = "CONFLICT";
        conflicts.push(`variant.${expected.id}.${field}`);
      }
    }
    variantFieldStates[expected.id] = states;
  }
  const reconciliation = { productFields: productFieldStates, variantFields: variantFieldStates, conflicts, checkedAt: new Date().toISOString() };
  const saveReconciliation = async (detail: string) => {
    const previous = isRecord(operation.result) ? operation.result : {};
    await input.prisma.catalogExecutionOperation.updateMany({ where: { shop: input.shop, id: operation.id, status: "RECONCILING", claimToken: input.claimToken }, data: {
      result: { ...previous, productId, reconciliation } as Prisma.InputJsonValue,
      errorCode: "SHOPIFY_UNKNOWN", errorDetail: detail,
    } });
  };
  const complete = async () => {
    await input.prisma.$transaction(async (tx) => {
      const finished = await tx.catalogExecutionOperation.updateMany({ where: { shop: input.shop, id: operation.id, status: "RECONCILING", claimToken: input.claimToken }, data: { status: "SUCCEEDED", claimToken: null, claimExpiresAt: null, productId, result: { ...(isRecord(operation.result) ? operation.result : {}), productId, reconciled: true, reconciliation } as Prisma.InputJsonValue, errorCode: null, errorDetail: null, completedAt: new Date() } });
      if (finished.count !== 1) throw new Error("Catalog reconciliation lease changed before completion.");
      await tx.catalogExecutionItem.updateMany({ where: { shop: input.shop, operationId: operation.id, status: { in: ["RUNNING", "UNKNOWN"] } }, data: { status: "SUCCEEDED", productId, errorCode: null, errorDetail: null } });
      await tx.catalogExecutionAttempt.updateMany({ where: { shop: input.shop, operationId: operation.id, status: "UNKNOWN" }, data: { status: "RECONCILED", finishedAt: new Date() } });
    });
    return { status: "SUCCEEDED", message: "Shopify confirms every approved Update field is applied; no retry mutation was sent.", productId };
  };
  if (conflicts.length) {
    const detail = "Current Shopify values differ from both the approved target and recorded original values. This operation is blocked for manual review; no retry mutation was sent.";
    await saveReconciliation(detail);
    return { status: "UNKNOWN", message: detail, productId };
  }
  if (!hasUnappliedFields) return complete();
  const detail = "Some approved fields remain at their recorded original values. A previous Shopify request may still complete later, so this operation remains UNKNOWN for manual reconciliation. No retry mutation was sent.";
  await saveReconciliation(detail);
  return { status: "UNKNOWN", message: detail, productId };
}

async function persistPlan(input: { prisma: CatalogPrisma; shop: string; batchId: string; groupId: string; reviewId: string; draftVersion: number; reviewVersion: number; fingerprint: string; plan: CatalogExecutionPlan }) {
  const idempotencyKey = catalogExecutionIdempotencyKey({ shop: input.shop, batchId: input.batchId, groupId: input.groupId, reviewId: input.reviewId, draftVersion: input.draftVersion, reviewVersion: input.reviewVersion, snapshotFingerprint: input.fingerprint });
  const versionWhere = { shop: input.shop, reviewId: input.reviewId, reviewVersion: input.reviewVersion };
  const existing = await input.prisma.catalogExecutionOperation.findFirst({ where: versionWhere });
  if (existing) return existing;
  const id = randomUUID();
  const status = input.plan.disposition === "SKIP" ? "SKIPPED" : input.plan.disposition === "CONFLICT" ? "CONFLICT" : "READY";
  try {
    return await input.prisma.$transaction(async (tx) => {
      const operation = await tx.catalogExecutionOperation.create({ data: {
        id, shop: input.shop, batchId: input.batchId, groupId: input.groupId, reviewId: input.reviewId,
        draftVersion: input.draftVersion, reviewVersion: input.reviewVersion, snapshotFingerprint: input.fingerprint,
        idempotencyKey, plan: input.plan.disposition, status, productId: input.plan.productId,
        planJson: input.plan as unknown as Prisma.InputJsonValue,
        result: { reason: input.plan.reason }, ...(status === "SKIPPED" || status === "CONFLICT" ? { completedAt: new Date() } : {}),
      } });
      await tx.catalogExecutionItem.createMany({ data: input.plan.items.map((item) => ({
        id: randomUUID(), shop: input.shop, batchId: input.batchId, operationId: id, lineId: item.lineId,
        plan: item.disposition, status: item.disposition === "SKIP" ? "SKIPPED" : item.disposition === "CONFLICT" ? "CONFLICT" : "READY",
        productId: item.productId, variantId: item.variantId, approvedFields: item.approvedFields as Prisma.InputJsonValue,
        idempotencyKey: createHash("sha256").update(`${id}:${item.lineId}`).digest("hex"),
      })) });
      return operation;
    });
  } catch (error) {
    const raced = await input.prisma.catalogExecutionOperation.findFirst({ where: versionWhere });
    if (raced) return raced;
    throw error;
  }
}

async function markOperation(input: { prisma: CatalogPrisma; shop: string; operationId: string; status: string; productId?: string | null; code?: string | null; detail?: string | null; result?: unknown; completed?: boolean }) {
  await input.prisma.catalogExecutionOperation.updateMany({ where: { shop: input.shop, id: input.operationId }, data: {
    status: input.status,
    ...(input.productId !== undefined ? { productId: input.productId } : {}),
    errorCode: input.code ?? null,
    errorDetail: input.detail ?? null,
    ...(input.result !== undefined ? { result: input.result as Prisma.InputJsonValue } : {}),
    ...(input.completed ? { completedAt: new Date() } : {}),
  } });
}

async function markReviewStale(prisma: CatalogPrisma, input: { shop: string; batchId: string; groupId: string; draftVersion: number; reviewId: string; reviewVersion: number }) {
  await prisma.$transaction(async (tx) => {
    const locked = await tx.catalogImportBatch.updateMany({ where: { shop: input.shop, id: input.batchId, draftVersion: input.draftVersion, status: "DRAFT" }, data: { draftVersion: { increment: 0 } } });
    if (locked.count !== 1) throw new Error("This catalog draft changed during execution checks. Reload and compare again.");
    const currentReview = await tx.catalogImportReview.findFirst({ where: { shop: input.shop, batchId: input.batchId, groupId: input.groupId, id: input.reviewId, draftVersion: input.draftVersion, reviewVersion: input.reviewVersion, status: "CONFIRMED" } });
    if (!currentReview) throw new Error("This catalog review changed during execution checks. Reload and compare again.");
    await archiveCatalogReviewVersion(tx, currentReview);
    const changed = await tx.catalogImportReview.updateMany({ where: { shop: input.shop, batchId: input.batchId, groupId: input.groupId, id: input.reviewId, draftVersion: input.draftVersion, reviewVersion: input.reviewVersion, status: "CONFIRMED" }, data: { status: "STALE", reviewVersion: { increment: 1 }, reviewedAt: null } });
    if (changed.count !== 1) throw new Error("This catalog review changed during execution checks. Reload and compare again.");
  });
}

export async function executeConfirmedCatalogReview(input: {
  shop: string;
  batchId: string;
  groupId: string;
  draftVersion: number;
  expectedReviewVersion: number;
  expectedFingerprint: string;
  reconcileOnly?: boolean;
  admin: AdminGraphql;
  scopes: ShopifyScopesApi;
  prisma: CatalogPrisma;
  environment?: RuntimeEnv;
  verifyDatabase?: (config: CatalogExecutionRuntimeConfig) => Promise<void>;
}) {
  const environment = input.environment ?? process.env;
  const config = validateCatalogExecutionGateConfig(input.shop, environment);
  if (input.verifyDatabase) await input.verifyDatabase(config);
  else await verifyCatalogExecutionDatabase(input.prisma, config);
  let granted: string[];
  try { granted = await queryGrantedScopes(input.scopes); }
  catch { throw new Error("Shopify permission grants could not be verified. No catalog mutation was sent."); }
  if (missingScopesForGrant(granted, ["read_products", "write_products"]).length) throw new Error("The current Shopify grant must include read_products and write_products. No catalog mutation was sent.");

  const batch = await input.prisma.catalogImportBatch.findFirst({ where: { shop: input.shop, id: input.batchId } });
  if (!batch || batch.status !== "DRAFT" || batch.draftVersion !== input.draftVersion) throw new Error("The current catalog draft changed or is unavailable. Compare and confirm it again before execution.");
  const group = await input.prisma.catalogImportGroup.findFirst({ where: { shop: input.shop, batchId: input.batchId, id: input.groupId, state: "ACTIVE" }, include: { lines: { orderBy: { rowNumber: "asc" } } } });
  const review = await input.prisma.catalogImportReview.findFirst({ where: { shop: input.shop, batchId: input.batchId, groupId: input.groupId, draftVersion: input.draftVersion } });
  if (!group || !review || review.status !== "CONFIRMED" || review.reviewVersion !== input.expectedReviewVersion || review.snapshotFingerprint !== input.expectedFingerprint) {
    throw new Error("A current persisted confirmation for this catalog review is required. Reload and confirm the current review first.");
  }
  if (!group.confirmedAt || group.lines.some((line) => line.status === "ERROR" || !Array.isArray(line.errors) || line.errors.length > 0)) throw new Error("Resolve group and data-quality errors before executing this review.");
  const snapshot = await readShopifyCatalogSnapshot((query, options) => input.admin.graphql(query, options) as Promise<Response>, input.shop);
  // The authenticated GraphQL snapshot's shop field is checked by the reader; the gate separately pins session.shop.
  const proposal = getProposal(review.snapshot);
  const currentFingerprint = fingerprintForCatalogReview({ variants: snapshot.variants }, proposal, group.lines.map((line) => ({ id: line.id, sku: line.sku })));
  const idempotencyKey = catalogExecutionIdempotencyKey({ shop: input.shop, batchId: input.batchId, groupId: input.groupId, reviewId: review.id, draftVersion: input.draftVersion, reviewVersion: review.reviewVersion, snapshotFingerprint: review.snapshotFingerprint });
  const legacyIdempotencyKey = catalogExecutionIdempotencyKey({ shop: input.shop, batchId: input.batchId, groupId: input.groupId, reviewId: review.id, draftVersion: input.draftVersion, snapshotFingerprint: review.snapshotFingerprint });
  let existing = await input.prisma.catalogExecutionOperation.findFirst({ where: { shop: input.shop, reviewId: review.id, reviewVersion: review.reviewVersion } });
  if (existing && existing.idempotencyKey !== idempotencyKey && existing.idempotencyKey !== legacyIdempotencyKey) throw new Error("The execution record does not match this confirmed review. No Shopify mutation was sent.");
  if (existing?.status === "SUCCEEDED" || existing?.status === "SKIPPED" || existing?.status === "CONFLICT") return { status: existing.status, message: typeof existing.errorDetail === "string" ? existing.errorDetail : "This confirmed review already has a final execution record.", operationId: existing.id, productId: existing.productId };

  const reconcileClaimed = async (operation: NonNullable<typeof existing>) => {
    const claimToken = randomUUID();
    const claimedAt = new Date();
    const claimExpiresAt = new Date(claimedAt.getTime() + RECONCILIATION_LEASE_MS);
    const claim = await input.prisma.catalogExecutionOperation.updateMany({
      where: { shop: input.shop, id: operation.id, status: "UNKNOWN" },
      data: { status: "RECONCILING", claimToken, claimExpiresAt },
    });
    if (claim.count !== 1) {
      const current = await input.prisma.catalogExecutionOperation.findFirst({ where: { shop: input.shop, id: operation.id } });
      return { status: current?.status ?? "UNKNOWN", message: "Another request owns this catalog reconciliation. Reload its status before continuing.", operationId: operation.id, productId: current?.productId ?? null };
    }

    const releaseUnknown = async (detail: string) => {
      const released = await input.prisma.catalogExecutionOperation.updateMany({
        where: { shop: input.shop, id: operation.id, status: "RECONCILING", claimToken },
        data: { status: "UNKNOWN", claimToken: null, claimExpiresAt: null, errorCode: "SHOPIFY_UNKNOWN", errorDetail: detail },
      });
      await input.prisma.catalogExecutionAttempt.updateMany({
        where: { shop: input.shop, operationId: operation.id, status: "PREPARED", claimToken },
        data: { status: "UNKNOWN", errorCode: "SHOPIFY_UNKNOWN", detail, finishedAt: new Date() },
      });
      return released.count;
    };

    try {
      const reconciled = await reconcileUnknown({
        prisma: input.prisma, admin: input.admin, shop: input.shop, claimToken,
        operation, plan: operation.planJson as unknown as CatalogExecutionPlan,
        snapshot,
      });
      if (reconciled.status === "UNKNOWN") {
        const released = await releaseUnknown(reconciled.message);
        if (released !== 1) {
          const current = await input.prisma.catalogExecutionOperation.findFirst({ where: { shop: input.shop, id: operation.id } });
          return { status: current?.status ?? "UNKNOWN", message: current?.errorDetail ?? reconciled.message, operationId: operation.id, productId: current?.productId ?? reconciled.productId };
        }
      }
      return { ...reconciled, operationId: operation.id };
    } catch {
      const released = await releaseUnknown(safeError("SHOPIFY_UNKNOWN"));
      const current = await input.prisma.catalogExecutionOperation.findFirst({ where: { shop: input.shop, id: operation.id } });
      return { status: released === 1 ? "UNKNOWN" : current?.status ?? "UNKNOWN", message: current?.errorDetail ?? safeError("SHOPIFY_UNKNOWN"), operationId: operation.id, productId: current?.productId ?? operation.productId };
    }
  };

  if (existing?.status === "UNKNOWN") {
    return reconcileClaimed(existing);
  }
  if (existing?.status === "RECONCILING") {
    const expires = existing.claimExpiresAt instanceof Date ? existing.claimExpiresAt.getTime() : Number.POSITIVE_INFINITY;
    if (expires > Date.now()) {
      return { status: "RECONCILING", message: "Another request is reconciling this operation. Wait for its result before retrying.", operationId: existing.id, productId: existing.productId };
    }
    const expiredClaimToken = existing.claimToken;
    const expired = await input.prisma.catalogExecutionOperation.updateMany({
      where: { shop: input.shop, id: existing.id, status: "RECONCILING", claimToken: expiredClaimToken, claimExpiresAt: { lte: new Date() } },
      data: { status: "UNKNOWN", claimToken: null, claimExpiresAt: null, errorCode: "SHOPIFY_UNKNOWN", errorDetail: safeError("SHOPIFY_UNKNOWN") },
    });
    if (expired.count !== 1) {
      const current = await input.prisma.catalogExecutionOperation.findFirst({ where: { shop: input.shop, id: existing.id } });
      return { status: current?.status ?? "UNKNOWN", message: "The catalog reconciliation lease changed while its status was checked. Reload before continuing.", operationId: existing.id, productId: current?.productId ?? null };
    }
    await input.prisma.catalogExecutionAttempt.updateMany({
      where: { shop: input.shop, operationId: existing.id, status: "PREPARED", claimToken: expiredClaimToken },
      data: { status: "UNKNOWN", errorCode: "SHOPIFY_UNKNOWN", detail: safeError("SHOPIFY_UNKNOWN"), finishedAt: new Date() },
    });
    existing = await input.prisma.catalogExecutionOperation.findFirst({ where: { shop: input.shop, id: existing.id } });
    if (existing?.status === "UNKNOWN") return reconcileClaimed(existing);
  }
  if (existing?.status === "RUNNING") {
    const updatedAt = existing.updatedAt instanceof Date ? existing.updatedAt.getTime() : Number.NaN;
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt < RUNNING_OPERATION_RECOVERY_MS) {
      return { status: "RUNNING", message: "This catalog operation is still within its execution window. Check again later; no additional mutation was sent.", operationId: existing.id, productId: existing.productId };
    }
    const recoveryCutoff = new Date(Date.now() - RUNNING_OPERATION_RECOVERY_MS);
    const recovered = await input.prisma.catalogExecutionOperation.updateMany({
      where: { shop: input.shop, id: existing.id, status: "RUNNING", updatedAt: { lte: recoveryCutoff } },
      data: { status: "UNKNOWN", errorCode: "SHOPIFY_UNKNOWN", errorDetail: safeError("SHOPIFY_UNKNOWN") },
    });
    if (recovered.count !== 1) {
      const current = await input.prisma.catalogExecutionOperation.findFirst({ where: { shop: input.shop, id: existing.id } });
      return { status: current?.status ?? "UNKNOWN", message: "This catalog operation changed while its status was checked. Reload before continuing.", operationId: existing.id, productId: current?.productId ?? null };
    }
    await input.prisma.catalogExecutionItem.updateMany({ where: { shop: input.shop, operationId: existing.id, plan: { in: ["CREATE", "UPDATE"] }, status: { in: ["READY", "RUNNING"] } }, data: { status: "UNKNOWN", errorCode: "SHOPIFY_UNKNOWN", errorDetail: safeError("SHOPIFY_UNKNOWN") } });
    await input.prisma.catalogExecutionAttempt.updateMany({ where: { shop: input.shop, operationId: existing.id, status: "PREPARED" }, data: { status: "UNKNOWN", errorCode: "SHOPIFY_UNKNOWN", detail: safeError("SHOPIFY_UNKNOWN"), finishedAt: new Date() } });
    existing = await input.prisma.catalogExecutionOperation.findFirst({ where: { shop: input.shop, id: existing.id } });
    if (existing?.status === "UNKNOWN") return reconcileClaimed(existing);
  }
  if (input.reconcileOnly) return { status: existing?.status ?? "NOT_STARTED", message: existing ? "This operation does not currently require unknown-outcome reconciliation." : "No catalog execution operation exists to reconcile.", operationId: existing?.id ?? null, productId: existing?.productId ?? null };
  if (currentFingerprint !== review.snapshotFingerprint) {
    await markReviewStale(input.prisma, { shop: input.shop, batchId: input.batchId, groupId: input.groupId, draftVersion: input.draftVersion, reviewId: review.id, reviewVersion: review.reviewVersion });
    throw new Error("Shopify changed since this review was confirmed. The review is now stale; compare, save, and confirm again before execution.");
  }
  const plan = buildCatalogExecutionPlan({ review, group, mapping: batch.mapping, snapshotVariants: snapshot.variants });
  existing ??= await persistPlan({ prisma: input.prisma, shop: input.shop, batchId: input.batchId, groupId: input.groupId, reviewId: review.id, draftVersion: input.draftVersion, reviewVersion: review.reviewVersion, fingerprint: review.snapshotFingerprint, plan });
  if (existing.status === "SUCCEEDED" || existing.status === "SKIPPED" || existing.status === "CONFLICT") return { status: existing.status, message: plan.reason, operationId: existing.id, productId: existing.productId };
  if (existing.status === "UNKNOWN") {
    return reconcileClaimed(existing);
  }
  const claim = await input.prisma.$transaction(async (tx) => {
    const draftLock = await tx.catalogImportBatch.updateMany({
      where: { shop: input.shop, id: input.batchId, draftVersion: input.draftVersion, status: "DRAFT" },
      data: { draftVersion: { increment: 0 } },
    });
    if (draftLock.count !== 1) throw new Error("This catalog draft changed after Shopify was checked. Compare and confirm again before execution.");
    const reviewLock = await tx.catalogImportReview.updateMany({
      where: { shop: input.shop, batchId: input.batchId, groupId: input.groupId, id: review.id, draftVersion: input.draftVersion, reviewVersion: input.expectedReviewVersion, snapshotFingerprint: input.expectedFingerprint, status: "CONFIRMED" },
      data: { reviewVersion: { increment: 0 } },
    });
    if (reviewLock.count !== 1) throw new Error("The saved catalog confirmation changed after Shopify was checked. Confirm the current review before execution.");
    return tx.catalogExecutionOperation.updateMany({
      where: { shop: input.shop, id: existing.id, reviewId: review.id, draftVersion: input.draftVersion, reviewVersion: input.expectedReviewVersion, snapshotFingerprint: input.expectedFingerprint, status: { in: ["READY", "FAILED"] } },
      data: { status: "RUNNING", errorCode: null, errorDetail: null },
    });
  });
  if (claim.count !== 1) {
    const current = await input.prisma.catalogExecutionOperation.findFirst({ where: { shop: input.shop, id: existing.id } });
    return { status: current?.status ?? "UNKNOWN", message: "Another request owns this catalog operation. Reload its status before retrying.", operationId: existing.id, productId: current?.productId ?? null };
  }

  const operationId = existing.id;
  const setItems = async (status: string, productId?: string, error?: string) => {
    await input.prisma.catalogExecutionItem.updateMany({ where: { shop: input.shop, operationId, plan: { in: ["CREATE", "UPDATE"] } }, data: { status, ...(productId ? { productId } : {}), errorCode: error ?? null, errorDetail: error ? safeError(error) : null } });
  };
  if (plan.disposition === "SKIP" || plan.disposition === "CONFLICT") {
    const status = plan.disposition === "SKIP" ? "SKIPPED" : "CONFLICT";
    await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status, detail: plan.reason, result: { reason: plan.reason }, completed: true });
    return { status, message: plan.reason, operationId, productId: plan.productId };
  }

  if (plan.disposition === "CREATE") {
    let productId = typeof existing.productId === "string" ? existing.productId : null;
    let defaultVariantId: string | null = null;
    const createItems = plan.items.filter((item) => item.disposition === "CREATE");
    if (!productId) {
      const productInput = { ...(plan.productCreate ?? {}), tags: [markerTag(operationId)], metafields: [{ namespace: "$app", key: "catalog_execution_id", type: "single_line_text_field", value: operationId }] };
      const result = await sendMutation({ prisma: input.prisma, admin: input.admin, shop: input.shop, operationId, mutation: "productCreate", query: PRODUCT_CREATE, variables: { product: productInput } });
      if (!result.ok) {
        await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status: result.status, code: result.code, detail: safeError(result.code), completed: result.status === "FAILED" });
        await setItems(result.status, undefined, result.code);
        return { status: result.status, message: safeError(result.code), operationId, productId: null };
      }
      const created = result.payload.product;
      const createdVariants = isRecord(created) ? created.variants : null;
      const createdPageInfo = isRecord(createdVariants) ? createdVariants.pageInfo : null;
      const createdNodes = isRecord(createdVariants) && Array.isArray(createdVariants.nodes) ? createdVariants.nodes.filter(isRecord) : null;
      const createdProductId = isRecord(created) && typeof created.id === "string" ? created.id : null;
      const defaultVariantResponseId = createdNodes?.length === 1 && typeof createdNodes[0]!.id === "string" ? createdNodes[0]!.id : null;
      const approvedProductFieldsMatch = isRecord(created) && Object.entries(plan.productCreate ?? {}).filter(([field]) => ["title", "descriptionHtml", "vendor", "productType"].includes(field)).every(([field, value]) => created[field] === value);
      if (!createdProductId || !isRecord(created) || !approvedProductFieldsMatch || created.status !== "DRAFT" || !Array.isArray(created.tags) || !created.tags.includes(markerTag(operationId)) || !isRecord(createdPageInfo) || createdPageInfo.hasNextPage !== false || !createdNodes || createdNodes.length !== 1 || !defaultVariantResponseId) {
        await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status: "UNKNOWN", code: "INVALID_RESPONSE", detail: safeError("INVALID_RESPONSE") });
        await setItems("UNKNOWN", createdProductId ?? undefined, "INVALID_RESPONSE");
        return { status: "UNKNOWN", message: safeError("INVALID_RESPONSE"), operationId, productId: createdProductId };
      }
      productId = createdProductId;
      defaultVariantId = defaultVariantResponseId;
      await input.prisma.catalogExecutionOperation.updateMany({ where: { shop: input.shop, id: operationId, status: "RUNNING" }, data: { productId } });
    }
    if (!defaultVariantId) {
      // A retry cannot issue productCreate again. Resolve the marker first; if
      // the variant response is incomplete, leave the record uncertain.
      await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status: "UNKNOWN", productId, code: "SHOPIFY_UNKNOWN", detail: safeError("SHOPIFY_UNKNOWN") });
      return { status: "UNKNOWN", message: safeError("SHOPIFY_UNKNOWN"), operationId, productId };
    }
    const first = createItems[0];
    if (!first) throw new Error("The Create plan contains no active variants.");
    const defaultUpdate = await sendMutation({ prisma: input.prisma, admin: input.admin, shop: input.shop, operationId, itemId: undefined, mutation: "productVariantsBulkUpdate", query: VARIANTS_UPDATE, variables: {
      productId, allowPartialUpdates: false,
      variants: [{ id: defaultVariantId, sku: first.sku, price: first.price, ...(first.optionValues.length ? { optionValues: first.optionValues } : {}) }],
    }, requiredCount: 1 });
    if (!defaultUpdate.ok) {
      await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status: "UNKNOWN", productId, code: defaultUpdate.code, detail: safeError(defaultUpdate.code) });
      await setItems("UNKNOWN", productId, defaultUpdate.code);
      return { status: "UNKNOWN", message: safeError(defaultUpdate.code), operationId, productId };
    }
    const defaultPayload = defaultUpdate.payload.productVariants as unknown[];
    const defaultNode = defaultPayload.find(isRecord);
    if (!defaultNode || typeof defaultNode.id !== "string" || !priceAndOptionsMatch(defaultNode, first)) {
      await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status: "UNKNOWN", productId, code: "INVALID_RESPONSE", detail: safeError("INVALID_RESPONSE") });
      await setItems("UNKNOWN", productId, "INVALID_RESPONSE");
      return { status: "UNKNOWN", message: safeError("INVALID_RESPONSE"), operationId, productId };
    }
    await input.prisma.catalogExecutionItem.updateMany({ where: { shop: input.shop, operationId, lineId: first.lineId }, data: { status: "SUCCEEDED", productId, variantId: defaultNode.id } });
    const additional = createItems.slice(1);
    if (additional.length) {
      const result = await sendMutation({ prisma: input.prisma, admin: input.admin, shop: input.shop, operationId, mutation: "productVariantsBulkCreate", query: VARIANTS_CREATE, variables: {
        productId, strategy: "PRESERVE_STANDALONE_VARIANT",
        variants: additional.map((item) => ({ sku: item.sku, price: item.price, optionValues: item.optionValues })),
      }, requiredCount: additional.length });
      if (!result.ok) {
        await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status: "UNKNOWN", productId, code: result.code, detail: safeError(result.code) });
        await setItems("UNKNOWN", productId, result.code);
        return { status: "UNKNOWN", message: safeError(result.code), operationId, productId };
      }
      const returned = result.payload.productVariants as unknown[];
      const returnedVariants = returned.filter(isRecord);
      for (const item of additional) {
        const matches = returnedVariants.filter((candidate) => priceAndOptionsMatch(candidate, item));
        const variant = matches[0];
        if (matches.length !== 1 || !variant || typeof variant.id !== "string") {
          await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status: "UNKNOWN", productId, code: "INVALID_RESPONSE", detail: safeError("INVALID_RESPONSE") });
          await setItems("UNKNOWN", productId, "INVALID_RESPONSE");
          return { status: "UNKNOWN", message: safeError("INVALID_RESPONSE"), operationId, productId };
        }
        await input.prisma.catalogExecutionItem.updateMany({ where: { shop: input.shop, operationId, lineId: item.lineId }, data: { status: "SUCCEEDED", productId, variantId: variant.id } });
      }
    }
    await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status: "SUCCEEDED", productId, result: { productId, status: "DRAFT", variantCount: createItems.length, markerTag: markerTag(operationId) }, completed: true });
    return { status: "SUCCEEDED", message: `Draft product created with ${createItems.length} approved variant${createItems.length === 1 ? "" : "s"}.`, operationId, productId };
  }

  let successfulMutationCount = 0;
  if (Object.keys(plan.productUpdate).length) {
    const product = await sendMutation({ prisma: input.prisma, admin: input.admin, shop: input.shop, operationId, mutation: "productUpdate", query: PRODUCT_UPDATE, variables: { product: { id: plan.productId, ...plan.productUpdate } } });
    if (!product.ok) {
      await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status: product.status, productId: plan.productId, code: product.code, detail: safeError(product.code), completed: product.status === "FAILED" });
      await setItems(product.status, plan.productId ?? undefined, product.code);
      return { status: product.status, message: safeError(product.code), operationId, productId: plan.productId };
    }
    successfulMutationCount += 1;
  }
  if (plan.variantUpdates.length) {
    const variants = await sendMutation({ prisma: input.prisma, admin: input.admin, shop: input.shop, operationId, mutation: "productVariantsBulkUpdate", query: VARIANTS_UPDATE, variables: { productId: plan.productId, variants: plan.variantUpdates, allowPartialUpdates: false }, requiredCount: plan.variantUpdates.length });
    if (!variants.ok) {
      const status = successfulMutationCount > 0 ? "UNKNOWN" : variants.status;
      const code = successfulMutationCount > 0 ? "SHOPIFY_UNKNOWN" : variants.code;
      await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status, productId: plan.productId, code, detail: safeError(code), completed: status === "FAILED" });
      await setItems(status, plan.productId ?? undefined, code);
      return { status, message: safeError(code), operationId, productId: plan.productId };
    }
    successfulMutationCount += 1;
    for (const item of plan.items.filter((entry) => entry.disposition === "UPDATE" && entry.variantId)) {
      await input.prisma.catalogExecutionItem.updateMany({ where: { shop: input.shop, operationId, lineId: item.lineId }, data: { status: "SUCCEEDED", productId: plan.productId, variantId: item.variantId } });
    }
  }
  await markOperation({ prisma: input.prisma, shop: input.shop, operationId, status: "SUCCEEDED", productId: plan.productId, result: { productId: plan.productId, updatedProductFields: Object.keys(plan.productUpdate), updatedVariantCount: plan.variantUpdates.length }, completed: true });
  return { status: "SUCCEEDED", message: plan.reason, operationId, productId: plan.productId };
}

export const catalogExecutionGraphql = { PRODUCT_CREATE, PRODUCT_UPDATE, VARIANTS_UPDATE, VARIANTS_CREATE, RECONCILE_CREATE };
