import { createHash, randomUUID } from "node:crypto";
import prisma from "../db.server.ts";
import type { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { MAX_GRAPHQL_INT } from "./csv-limits.js";

export class ReceiptInspectionError extends Error {
  constructor(message: string) { super(message); this.name = "ReceiptInspectionError"; }
}

function parseCount(value: unknown, label: string) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_GRAPHQL_INT) throw new ReceiptInspectionError(`${label} must be a non-negative whole number.`);
  return number;
}

function quantities(received: number, accepted: unknown, damaged: unknown, onHold: unknown, requireBalanced = false) {
  const a = parseCount(accepted, "Accepted quantity");
  const d = parseCount(damaged, "Damaged quantity");
  const h = parseCount(onHold, "On Hold quantity");
  const classified = a + d + h;
  if (classified > received || (requireBalanced && classified !== received)) {
    throw new ReceiptInspectionError(requireBalanced
      ? `Classified quantities must equal physical Received (${received}).`
      : `Accepted + Damaged + On Hold cannot exceed physical Received (${received}).`);
  }
  return { acceptedQty: a, damagedQty: d, onHoldQty: h };
}

async function assertReceiptDraft(shop: string, receiptId: string, db: Prisma.TransactionClient | typeof prisma) {
  const receipt = await db.receivingReceipt.findFirst({ where: { shop, id: receiptId }, include: { shipment: true } });
  if (!receipt) throw new ReceiptInspectionError("Receipt not found for this Shopify store.");
  if (receipt.status !== "DRAFT") throw new ReceiptInspectionError("Confirmed or cancelled Receipts are immutable.");
  return receipt;
}

/** Materialize valid Received Goods source rows once; malformed rows remain visible exceptions. */
export async function prepareReceiptInspection(input: { shop: string; receiptId: string }, db = prisma) {
  return db.$transaction(async (tx) => {
    const receipt = await tx.receivingReceipt.findFirst({ where: { shop: input.shop, id: input.receiptId }, include: { imports: { where: { shop: input.shop, mode: "RECEIVED" }, include: { rows: { orderBy: { rowNumber: "asc" } } }, orderBy: { createdAt: "asc" } } } });
    if (!receipt) throw new ReceiptInspectionError("Receipt not found for this Shopify store.");
    if (receipt.status !== "DRAFT") throw new ReceiptInspectionError("Only a draft Receipt can be prepared for inspection.");
    let createdLines = 0;
    let preservedErrors = 0;
    for (const attempt of receipt.imports) {
      const mapping = JSON.parse(attempt.mappingJson) as Record<string, string>;
      for (const row of attempt.rows) {
        const validation = JSON.parse(row.validationJson) as string[];
        const raw = JSON.parse(row.rawValuesJson) as Record<string, string>;
        const productName = mapping.productName ? raw[mapping.productName]?.trim() || null : null;
        const existing = await tx.receiptInspectionLine.findUnique({ where: { sourceRowId: row.id }, select: { id: true } });
        if (existing) continue;
        if (validation.length || !row.sku || row.quantity === null || row.quantity < 1) {
          const reason = validation.join(" ") || "SKU and a positive physical quantity are required before this source row can be inspected.";
          await tx.receiptInspectionException.upsert({
            where: { receiptId_sourceRowId_type: { receiptId: receipt.id, sourceRowId: row.id, type: "IMPORT_ROW_ERROR" } },
            create: { id: randomUUID(), shop: input.shop, receiptId: receipt.id, sourceRowId: row.id, type: "IMPORT_ROW_ERROR", quantity: row.quantity, reason },
            update: { reason, quantity: row.quantity, status: "OPEN" },
          });
          preservedErrors += 1;
          continue;
        }
        await tx.receiptInspectionLine.create({ data: {
          id: `insp_${randomUUID()}`, shop: input.shop, receiptId: receipt.id, sourceRowId: row.id,
          sku: row.sku, productName, receivedQty: row.quantity, acceptedQty: 0, damagedQty: 0, onHoldQty: 0,
          matchOutcome: row.outcome, matchedProductId: row.matchedProductId, matchedVariantId: row.matchedVariantId,
        } });
        createdLines += 1;
      }
    }
    return { createdLines, preservedErrors };
  });
}

export async function saveReceiptInspectionLine(input: { shop: string; receiptId: string; lineId: string; acceptedQty: unknown; damagedQty: unknown; onHoldQty: unknown }, db = prisma) {
  return db.$transaction(async (tx) => {
    const receipt = await assertReceiptDraft(input.shop, input.receiptId, tx);
    const line = await tx.receiptInspectionLine.findFirst({ where: { id: input.lineId, shop: input.shop, receiptId: receipt.id } });
    if (!line) throw new ReceiptInspectionError("Inspection line not found for this Receipt and Shopify store.");
    const next = quantities(line.receivedQty, input.acceptedQty, input.damagedQty, input.onHoldQty);
    if (next.acceptedQty > 0 && (line.matchOutcome !== "EXISTING_VARIANT" || !line.matchedVariantId)) {
      throw new ReceiptInspectionError("This SKU has no confirmed existing Shopify Variant. Keep it On Hold until matching is resolved.");
    }
    const updated = await tx.receiptInspectionLine.update({ where: { id: line.id }, data: next });
    await syncLineException(tx, input.shop, receipt.id, line.id, "DAMAGED", next.damagedQty, "Physical goods were classified as damaged.");
    await syncLineException(tx, input.shop, receipt.id, line.id, "ON_HOLD", next.onHoldQty, "Physical goods are awaiting review or classification.");
    return updated;
  });
}

async function syncLineException(tx: Prisma.TransactionClient, shop: string, receiptId: string, lineId: string, type: string, quantity: number, reason: string) {
  const unique = { receiptId_lineId_type: { receiptId, lineId, type } };
  const existing = await tx.receiptInspectionException.findUnique({ where: unique, select: { id: true } });
  if (!quantity) {
    if (existing) await tx.receiptInspectionException.update({ where: unique, data: { status: "RESOLVED", quantity: 0 } });
    return;
  }
  await tx.receiptInspectionException.upsert({
    where: unique,
    create: { id: randomUUID(), shop, receiptId, lineId, type, quantity, reason },
    update: { quantity, reason, status: "OPEN" },
  });
}

export async function markAllEligibleAccepted(input: { shop: string; receiptId: string }, db = prisma) {
  return db.$transaction(async (tx) => {
    const receipt = await assertReceiptDraft(input.shop, input.receiptId, tx);
    const lines = await tx.receiptInspectionLine.findMany({ where: { shop: input.shop, receiptId: receipt.id }, orderBy: { createdAt: "asc" } });
    const eligible = lines.filter((line) => line.matchOutcome === "EXISTING_VARIANT" && Boolean(line.matchedVariantId));
    for (const line of eligible) {
      await tx.receiptInspectionLine.update({ where: { id: line.id }, data: { acceptedQty: line.receivedQty, damagedQty: 0, onHoldQty: 0 } });
      await syncLineException(tx, input.shop, receipt.id, line.id, "DAMAGED", 0, "Physical goods were classified as damaged.");
      await syncLineException(tx, input.shop, receipt.id, line.id, "ON_HOLD", 0, "Physical goods are awaiting review or classification.");
    }
    return { acceptedLines: eligible.length, excludedLines: lines.length - eligible.length };
  });
}

export async function addWrongItemException(input: { shop: string; receiptId: string; requestId: string; description: string; suspectedSku?: string; quantity: unknown; reason: string; disposition: "HOLD" | "RETURN" }, db = prisma) {
  const description = input.description.trim();
  const suspectedSku = input.suspectedSku?.trim() || null;
  const reason = input.reason.trim();
  if (!description || !reason) throw new ReceiptInspectionError("Wrong Item description and reason are required.");
  if (input.disposition !== "HOLD" && input.disposition !== "RETURN") throw new ReceiptInspectionError("Wrong Item disposition must be Hold or Return.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) throw new ReceiptInspectionError("Invalid Wrong Item request identity. Reload and retry.");
  const quantity = parseCount(input.quantity, "Wrong Item quantity");
  if (!quantity) throw new ReceiptInspectionError("Wrong Item quantity must be greater than zero.");
  return db.$transaction(async (tx) => {
    const receipt = await assertReceiptDraft(input.shop, input.receiptId, tx);
    const prior = await tx.receiptInspectionException.findFirst({ where: { shop: input.shop, requestId: input.requestId } });
    if (prior) {
      if (prior.receiptId !== receipt.id || prior.type !== "WRONG_ITEM" || prior.quantity !== quantity || prior.reason !== `${description}: ${reason}` || prior.suspectedSku !== suspectedSku || prior.disposition !== input.disposition) throw new ReceiptInspectionError("This Wrong Item request was already used with different details.");
      return prior;
    }
    return tx.receiptInspectionException.create({ data: { id: `exc_${randomUUID()}`, shop: input.shop, receiptId: receipt.id, requestId: input.requestId, type: "WRONG_ITEM", quantity, suspectedSku, reason: `${description}: ${reason}`, disposition: input.disposition } });
  });
}

type InventorySnapshot = { inventoryItemId: string | null; available: number | null; readAt: Date | null; reason: string | null };

/** Shopify reads only: one fresh available-quantity snapshot per accepted exact-match variant. */
export async function loadReceiptInspectionPreview(admin: AdminApiContext, input: { shop: string; receiptId: string }, db = prisma) {
  const receipt = await db.receivingReceipt.findFirst({ where: { shop: input.shop, id: input.receiptId }, include: {
    shipment: true,
    inspectionLines: { where: { shop: input.shop }, orderBy: { createdAt: "asc" }, include: { sourceRow: true } },
    exceptions: { where: { shop: input.shop, status: "OPEN" }, orderBy: { createdAt: "asc" }, include: { sourceRow: true } },
    inventoryOperations: { where: { shop: input.shop }, orderBy: { createdAt: "asc" } },
  } });
  if (!receipt) throw new ReceiptInspectionError("Receipt not found for this Shopify store.");
  const targets = [...new Set(receipt.inspectionLines.filter((line) => line.acceptedQty > 0 && line.matchOutcome === "EXISTING_VARIANT" && line.matchedVariantId).map((line) => line.matchedVariantId!))];
  const snapshots: Record<string, InventorySnapshot> = {};
  const readAt = new Date();
  for (const variantId of targets) {
    try {
      const response = await admin.graphql(`#graphql
        query StockHubReceiptInventorySnapshot($id: ID!) {
          productVariant(id: $id) {
            id
            inventoryItem {
              id
              inventoryLevels(first: 250) {
                edges { node { location { id } quantities(names: ["available"]) { name quantity } } }
                pageInfo { hasNextPage }
              }
            }
          }
        }
      `, { variables: { id: variantId } });
      const payload = await response.json() as { data?: { productVariant?: { id: string; inventoryItem: { id: string; inventoryLevels: { edges: Array<{ node: { location: { id: string }; quantities: Array<{ name: string; quantity: number }> } }>; pageInfo: { hasNextPage: boolean } } } | null } }; errors?: unknown[] };
      const item = payload.data?.productVariant?.inventoryItem;
      const level = item?.inventoryLevels.edges.find(({ node }) => node.location.id === receipt.locationId);
      const available = level?.node.quantities.find((quantity) => quantity.name === "available")?.quantity;
      snapshots[variantId] = { inventoryItemId: item?.id ?? null, available: typeof available === "number" && Number.isSafeInteger(available) ? available : null, readAt: item ? readAt : null, reason: payload.errors?.length ? "Shopify read failed; inventory level was not available." : !item ? "Inventory Item is not available for this Variant." : item.inventoryLevels.pageInfo.hasNextPage && !level ? "Location inventory levels could not be fully read." : !level ? "No Shopify inventory level was found at this Receipt Location." : available === undefined ? "Shopify did not return an Available quantity." : null };
    } catch {
      snapshots[variantId] = { inventoryItemId: null, available: null, readAt: null, reason: "Shopify read failed; inventory level was not available." };
    }
  }
  const lines = receipt.inspectionLines.map((line) => {
    const snapshot = line.matchedVariantId ? snapshots[line.matchedVariantId] : undefined;
    return { ...line, currentAvailable: snapshot?.available ?? null, inventoryItemId: snapshot?.inventoryItemId ?? null, snapshotTakenAt: snapshot?.readAt ?? null, snapshotReason: snapshot?.reason ?? null, proposedDelta: line.matchOutcome === "EXISTING_VARIANT" && line.matchedVariantId ? line.acceptedQty : null, projectedAvailable: snapshot?.available === null || snapshot?.available === undefined ? null : snapshot.available + line.acceptedQty };
  });
  return { receipt, lines, exceptions: receipt.exceptions, snapshots };
}

export async function confirmReceiptInspection(input: { shop: string; receiptId: string; snapshots: Record<string, InventorySnapshot> }, db = prisma) {
  try {
    return await db.$transaction(async (tx) => {
      const confirmedAt = new Date();
      const confirmationId = `cnf_${createHash("sha256").update(`${input.shop}\0${input.receiptId}`).digest("hex")}`;
      // Compare-and-set the state before reading mutable inspection rows. Only the winner
      // can create operations/events; the transaction rolls the claim back on validation failure.
      const claim = await tx.receivingReceipt.updateMany({
        where: { shop: input.shop, id: input.receiptId, status: "DRAFT" },
        data: { status: "CONFIRMED", confirmedAt, confirmationId },
      });
      if (claim.count === 0) {
        const existing = await tx.receivingReceipt.findFirst({ where: { shop: input.shop, id: input.receiptId } });
        if (!existing) throw new ReceiptInspectionError("Receipt not found for this Shopify store.");
        if (existing.status !== "CONFIRMED") throw new ReceiptInspectionError("Only a draft Receipt can be confirmed.");
        return { alreadyConfirmed: true, receipt: existing, operations: await tx.receiptInventoryOperation.findMany({ where: { shop: input.shop, receiptId: existing.id }, orderBy: { createdAt: "asc" } }) };
      }
      const receipt = await tx.receivingReceipt.findFirst({ where: { shop: input.shop, id: input.receiptId, status: "CONFIRMED", confirmationId }, include: { inspectionLines: { where: { shop: input.shop }, include: { sourceRow: { include: { attempt: true } } } }, exceptions: { where: { shop: input.shop, status: "OPEN" } } } });
      if (!receipt) throw new ReceiptInspectionError("Receipt confirmation claim could not be reloaded.");
      if (!receipt.inspectionLines.length && !receipt.exceptions.some((exception) => exception.type === "IMPORT_ROW_ERROR" || exception.type === "WRONG_ITEM")) throw new ReceiptInspectionError("Prepare and classify Receipt source rows before confirmation.");
      for (const line of receipt.inspectionLines) {
        const source = line.sourceRow;
        if (source.attempt.shop !== input.shop || source.attempt.receiptId !== receipt.id || source.sku !== line.sku || source.quantity !== line.receivedQty || source.outcome !== line.matchOutcome || source.matchedVariantId !== line.matchedVariantId || source.matchedProductId !== line.matchedProductId || JSON.parse(source.validationJson).length) {
          throw new ReceiptInspectionError("Receipt source or Product match changed after inspection was prepared. Refresh and prepare the draft again.");
        }
        quantities(line.receivedQty, line.acceptedQty, line.damagedQty, line.onHoldQty, true);
        if (line.acceptedQty > 0 && (line.matchOutcome !== "EXISTING_VARIANT" || !line.matchedVariantId)) throw new ReceiptInspectionError(`Accepted quantity for SKU ${line.sku ?? "(unknown)"} has no confirmed existing Shopify Variant. Keep it On Hold.`);
      }
      const operations = [];
      for (const line of receipt.inspectionLines.filter((candidate) => candidate.acceptedQty > 0 && candidate.matchOutcome === "EXISTING_VARIANT" && candidate.matchedVariantId)) {
        const operationKey = createHash("sha256").update(`${input.shop}\0${receipt.id}\0${line.sourceRowId}`).digest("hex");
        const snapshot = input.snapshots[line.matchedVariantId!];
        operations.push(await tx.receiptInventoryOperation.upsert({
          where: { shop_lineId: { shop: input.shop, lineId: line.id } },
          create: { id: `op_${operationKey}`, shop: input.shop, receiptId: receipt.id, lineId: line.id, operationKey, locationId: receipt.locationId, targetVariantId: line.matchedVariantId!, inventoryItemId: snapshot?.inventoryItemId ?? null, acceptedDelta: line.acceptedQty, snapshotAvailable: snapshot?.available ?? null, snapshotTakenAt: snapshot?.readAt ?? null, status: "PENDING" },
          update: {},
        }));
      }
      await tx.shipmentEvent.create({ data: { id: randomUUID(), shop: input.shop, shipmentId: receipt.shipmentId, type: "RECEIPT_CONFIRMED", metadata: JSON.stringify({ receiptId: receipt.id, confirmationId, pendingOperations: operations.length }) } });
      return { alreadyConfirmed: false, receipt, operations };
    });
  } catch (error) {
    if (["P2002", "P2034", "P1008", "P2028"].includes((error as { code?: string })?.code ?? "")) {
      const replay = await db.receivingReceipt.findFirst({ where: { shop: input.shop, id: input.receiptId, status: "CONFIRMED" } });
      if (replay) return { alreadyConfirmed: true, receipt: replay, operations: await db.receiptInventoryOperation.findMany({ where: { shop: input.shop, receiptId: replay.id }, orderBy: { createdAt: "asc" } }) };
    }
    throw error;
  }
}

/** Guard S2 matching writes after a physical inspection snapshot has been materialized. */
export async function assertSourceRowNotInspected(rowId: string, db: typeof prisma) {
  const inspectionModel = (db as unknown as { receiptInspectionLine?: Prisma.TransactionClient["receiptInspectionLine"] }).receiptInspectionLine;
  // Lightweight S2 unit fakes predate this additive S3 model; runtime Prisma always has the delegate.
  if (!inspectionModel) return;
  const line = await inspectionModel.findUnique({ where: { sourceRowId: rowId }, select: { id: true } });
  if (line) throw new ReceiptInspectionError("This import row is part of an inspection snapshot; matching is frozen. Start a new Resolution workflow rather than editing the source Receipt.");
}
