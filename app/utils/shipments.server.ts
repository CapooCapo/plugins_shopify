import { randomUUID } from "node:crypto";
import prisma from "../db.server.ts";
import { assertReceiptCanStart, assertShipmentCanClose, assertShipmentCanReopen, normalizeReference, ShipmentDomainError as ShipmentError } from "./shipment-domain.js";

export { ShipmentError, normalizeReference };

function requiredText(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new ShipmentError(`${label} is required.`, "INVALID_INPUT");
  return trimmed;
}

export async function createShipment(input: {
  shop: string; referenceType: string; reference: string; issuer: string; notes?: string | null;
  expectations?: Array<{ sku: string; expectedQty: number | null }>;
}, db = prisma) {
  const referenceType = requiredText(input.referenceType, "Reference type").toUpperCase();
  if (referenceType !== "TRACKING" && referenceType !== "DELIVERY_REFERENCE") {
    throw new ShipmentError("Reference type must be Tracking number or Supplier delivery reference.", "INVALID_REFERENCE_TYPE");
  }
  const reference = requiredText(input.reference, "Reference");
  const issuer = requiredText(input.issuer, "Carrier or supplier");
  const normalized = normalizeReference(reference);
  const issuerNormalized = normalizeReference(issuer);
  const expectations = (input.expectations ?? []).map((item) => {
    const sku = requiredText(item.sku, "SKU");
    if (item.expectedQty !== null && (!Number.isInteger(item.expectedQty) || item.expectedQty < 0)) {
      throw new ShipmentError("Expected quantities must be non-negative whole numbers.", "INVALID_EXPECTATION");
    }
    return { id: randomUUID(), sku, expectedQty: item.expectedQty };
  });
  if (new Set(expectations.map((item) => item.sku)).size !== expectations.length) {
    throw new ShipmentError("Each expected SKU can appear only once.", "DUPLICATE_EXPECTATION");
  }
  const id = `shp_${randomUUID()}`;
  try {
    return await db.$transaction(async (tx) => {
      const shipment = await tx.shipment.create({
        data: {
          id, shop: input.shop, referenceType, reference, referenceNormalized: normalized,
          issuer, issuerNormalized, notes: input.notes?.trim() || null,
          expectations: { create: expectations },
        },
        include: { expectations: true },
      });
      await tx.shipmentEvent.create({ data: { id: randomUUID(), shop: input.shop, shipmentId: shipment.id, type: "CREATED" } });
      return shipment;
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") {
      throw new ShipmentError("A Shipment with this reference, type, and carrier/supplier already exists.", "DUPLICATE_REFERENCE");
    }
    throw error;
  }
}

export async function createReceiptDraft(input: {
  shop: string; shipmentId: string; locationId: string; locationName: string; requestId: string;
}, db = prisma) {
  if (!input.locationId.startsWith("gid://shopify/Location/") || !input.locationName.trim()) {
    throw new ShipmentError("Choose an active Shopify Location.", "INVALID_LOCATION");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
    throw new ShipmentError("Invalid Receipt request identity. Reload the page and retry.", "INVALID_REQUEST_ID");
  }
  const existing = await db.receivingReceipt.findUnique({ where: { shop_requestId: { shop: input.shop, requestId: input.requestId } } });
  if (existing) {
    if (existing.shipmentId !== input.shipmentId || existing.locationId !== input.locationId) {
      throw new ShipmentError("This Receipt request was already used with different details. Reload the page and retry.", "IDEMPOTENCY_CONFLICT");
    }
    return existing;
  }
  try {
    return await db.$transaction(async (tx) => {
      const shipment = await tx.shipment.findFirst({ where: { id: input.shipmentId, shop: input.shop } });
      if (!shipment) throw new ShipmentError("Shipment not found.", "NOT_FOUND");
      assertReceiptCanStart(shipment.status);
      const receipt = await tx.receivingReceipt.create({
        data: {
          id: `rcp_${randomUUID()}`, shop: input.shop, shipmentId: shipment.id, requestId: input.requestId,
          locationId: input.locationId, locationName: input.locationName.trim(), status: "DRAFT",
        },
      });
      if (shipment.status === "OPEN") {
        await tx.shipment.update({ where: { id: shipment.id }, data: { status: "RECEIVING" } });
        await tx.shipmentEvent.create({ data: { id: randomUUID(), shop: input.shop, shipmentId: shipment.id, type: "RECEIVING_STARTED" } });
      }
      await tx.shipmentEvent.create({ data: {
        id: randomUUID(), shop: input.shop, shipmentId: shipment.id,
        type: "RECEIPT_DRAFT_CREATED", metadata: JSON.stringify({ receiptId: receipt.id, locationId: input.locationId }),
      } });
      return receipt;
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "P2002") {
      const replay = await db.receivingReceipt.findUnique({ where: { shop_requestId: { shop: input.shop, requestId: input.requestId } } });
      if (replay && replay.shipmentId === input.shipmentId && replay.locationId === input.locationId) return replay;
      if (replay) throw new ShipmentError("This Receipt request was already used with different details. Reload the page and retry.", "IDEMPOTENCY_CONFLICT");
    }
    throw error;
  }
}

export async function closeShipment(input: { shop: string; shipmentId: string; reason?: string | null }, db = prisma) {
  return db.$transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, shop: input.shop },
      include: { receipts: true, expectations: true },
    });
    if (!shipment) throw new ShipmentError("Shipment not found.", "NOT_FOUND");
    const reason = input.reason?.trim() || null;
    assertShipmentCanClose({ status: shipment.status, hasDraftReceipt: shipment.receipts.some((receipt) => receipt.status === "DRAFT"), hasExpectedQuantities: shipment.expectations.some((line) => line.expectedQty !== null), reason });
    if (shipment.status === "CLOSED") return shipment;
    await tx.shipment.update({ where: { id: shipment.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await tx.shipmentEvent.create({ data: { id: randomUUID(), shop: input.shop, shipmentId: shipment.id, type: "CLOSED", reason } });
    return { ...shipment, status: "CLOSED" };
  });
}

export async function cancelReceiptDraft(input: { shop: string; shipmentId: string; receiptId: string; reason: string }, db = prisma) {
  const reason = requiredText(input.reason, "Cancellation reason");
  return db.$transaction(async (tx) => {
    const receipt = await tx.receivingReceipt.findFirst({ where: { id: input.receiptId, shipmentId: input.shipmentId, shop: input.shop }, include: { inspectionLines: { select: { id: true }, take: 1 }, exceptions: { select: { id: true }, take: 1 } } });
    if (!receipt) throw new ShipmentError("Receipt not found.", "NOT_FOUND");
    if (receipt.status !== "DRAFT") throw new ShipmentError("Only a draft Receipt can be cancelled.", "NOT_DRAFT");
    if (receipt.inspectionLines.length || receipt.exceptions.length) throw new ShipmentError("A Receipt with prepared inspection data or recorded exceptions cannot be cancelled; preserve its source history and finish inspection instead.", "INSPECTION_STARTED");
    await tx.receivingReceipt.update({ where: { id: receipt.id }, data: { status: "CANCELLED" } });
    await tx.shipmentEvent.create({ data: {
      id: randomUUID(), shop: input.shop, shipmentId: input.shipmentId, type: "RECEIPT_DRAFT_CANCELLED", reason,
      metadata: JSON.stringify({ receiptId: receipt.id }),
    } });
    return receipt;
  });
}

export async function reopenShipment(input: { shop: string; shipmentId: string; reason: string }, db = prisma) {
  const reason = input.reason.trim();
  return db.$transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({ where: { id: input.shipmentId, shop: input.shop } });
    if (!shipment) throw new ShipmentError("Shipment not found.", "NOT_FOUND");
    assertShipmentCanReopen(shipment.status, reason);
    await tx.shipment.update({ where: { id: shipment.id }, data: { status: "RECEIVING", closedAt: null } });
    await tx.shipmentEvent.create({ data: { id: randomUUID(), shop: input.shop, shipmentId: shipment.id, type: "REOPENED", reason } });
    return shipment;
  });
}

export async function listShipments(shop: string, query = "", status = "", db = prisma) {
  const where = {
    shop,
    ...(status && ["OPEN", "RECEIVING", "CLOSED"].includes(status) ? { status } : {}),
    ...(query.trim() ? { OR: [
      { id: { contains: query.trim() } }, { reference: { contains: query.trim() } }, { issuer: { contains: query.trim() } },
    ] } : {}),
  };
  return db.shipment.findMany({ where, orderBy: { createdAt: "desc" }, include: { expectations: true, receipts: true } });
}

export async function getShipment(shop: string, id: string, db = prisma) {
  return db.shipment.findFirst({ where: { shop, id }, include: {
    expectations: true, receipts: { orderBy: { createdAt: "asc" } }, events: { where: { shop }, orderBy: { createdAt: "asc" } },
  } });
}
