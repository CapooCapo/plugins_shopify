type PrivacyWebhookPayload = Record<string, unknown>;

import type { PrismaClient } from "@prisma/client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPositiveShopifyId(value: unknown): boolean {
  return (typeof value === "string" || typeof value === "number") && /^\d+$/.test(String(value)) && Number(value) > 0;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function validateCustomerPayload(payload: PrivacyWebhookPayload): void {
  if (!hasPositiveShopifyId(payload.shop_id) || !isRecord(payload.customer) || !hasPositiveShopifyId(payload.customer.id)) {
    throw new Response("Invalid Shopify privacy webhook payload", { status: 400 });
  }
}

function validateShopPayload(payload: PrivacyWebhookPayload): void {
  if (!hasPositiveShopifyId(payload.shop_id)) {
    throw new Response("Invalid Shopify shop redaction payload", { status: 400 });
  }
}

/**
 * Customer data is not persisted by StockHub: there is no Customer model or customer
 * identifier on ImportBatch/ImportLine. Session records contain merchant-admin
 * authentication data and must not be mistaken for customer records.
 */
export function acknowledgeCustomerDataRequest(payload: PrivacyWebhookPayload): void {
  validateCustomerPayload(payload);
}

/**
 * The same schema boundary makes customer redaction a verified no-op: no customer
 * record or customer-linked import history exists to erase. Do not delete a
 * merchant's import history or admin Session based on a customer ID.
 */
export function redactCustomerData(payload: PrivacyWebhookPayload): void {
  validateCustomerPayload(payload);
}

/**
 * Erase all shop-owned data atomically. ImportLine rows cascade from ImportBatch;
 * the explicit counter and session deletes cover the remaining shop-scoped data.
 * Repeated deliveries are safe because deleteMany is idempotent.
 */
export async function redactShopData(
  prisma: PrismaClient,
  shop: string,
  payload: PrivacyWebhookPayload,
): Promise<void> {
  validateShopPayload(payload);
  if (!shop || shop.trim() !== shop || hasControlCharacter(shop)) {
    throw new Response("Invalid authenticated Shopify shop", { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.activityLog.deleteMany({ where: { shop } });
    await tx.importBatch.deleteMany({ where: { shop } });
    await tx.importReceiptCounter.deleteMany({ where: { shop } });
    await tx.session.deleteMany({ where: { shop } });
  });
}
