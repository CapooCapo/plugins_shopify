import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../db.server";
import { activityCreateData, type ActivityActor } from "./activity-log.server";

export type PersistImportPreviewInput = {
  shop: string;
  submissionId: string;
  actor: string | null;
  auditActor?: ActivityActor;
  fileName: string;
  checksum: string;
  location: { id: string; name: string };
  currencyCode: string;
  lines: Prisma.ImportLineCreateWithoutBatchInput[];
};

export type PersistImportPreviewResult = {
  batchId: string;
  receiptCode: string;
  duplicateCsv: boolean;
};

export class ImportSubmissionConflictError extends Error {
  constructor() {
    super("This upload form was already used for a different CSV or location. Reload Imports and submit the file again.");
    this.name = "ImportSubmissionConflictError";
  }
}

export function receiptDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

export function formatReceiptCode(dateKey: string, sequence: number) {
  return `IMP-${dateKey}-${String(sequence).padStart(6, "0")}`;
}

function isUniqueConstraintError(error: unknown): error is { code: "P2002" } {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function assertSameSubmission(
  existing: { id: string; receiptCode: string; fileChecksum: string; locationId: string },
  input: PersistImportPreviewInput,
): PersistImportPreviewResult {
  if (existing.fileChecksum !== input.checksum || existing.locationId !== input.location.id) {
    throw new ImportSubmissionConflictError();
  }
  return { batchId: existing.id, receiptCode: existing.receiptCode, duplicateCsv: false };
}

async function hasOtherMatchingCsv(
  database: PrismaClient,
  input: PersistImportPreviewInput,
  batchId: string,
) {
  return Boolean(await database.importBatch.findFirst({
    where: {
      shop: input.shop,
      fileChecksum: input.checksum,
      id: { not: batchId },
    },
    select: { id: true },
  }));
}

/**
 * Persist a preview exactly once per server-issued form token. Distinct tokens
 * always create distinct receipts, even when the CSV checksum is identical.
 */
export async function persistImportPreview(
  input: PersistImportPreviewInput,
  database: PrismaClient = prisma,
): Promise<PersistImportPreviewResult> {
  try {
    return await database.$transaction(async (transaction) => {
      const existing = await transaction.importBatch.findUnique({
        where: { shop_submissionId: { shop: input.shop, submissionId: input.submissionId } },
        select: { id: true, receiptCode: true, fileChecksum: true, locationId: true },
      });
      if (existing) {
        const result = assertSameSubmission(existing, input);
        return {
          ...result,
          duplicateCsv: Boolean(await transaction.importBatch.findFirst({
            where: {
              shop: input.shop,
              fileChecksum: input.checksum,
              id: { not: existing.id },
            },
            select: { id: true },
          })),
        };
      }

      const duplicateCsv = Boolean(await transaction.importBatch.findFirst({
        where: { shop: input.shop, fileChecksum: input.checksum },
        select: { id: true },
      }));
      const dateKey = receiptDateKey();
      const counter = await transaction.importReceiptCounter.upsert({
        where: { shop_dateKey: { shop: input.shop, dateKey } },
        create: { shop: input.shop, dateKey, lastSequence: 1 },
        update: { lastSequence: { increment: 1 } },
        select: { lastSequence: true },
      });
      const receiptCode = formatReceiptCode(dateKey, counter.lastSequence);
      const batch = await transaction.importBatch.create({
        data: {
          id: randomUUID(),
          shop: input.shop,
          submissionId: input.submissionId,
          receiptCode,
          fileChecksum: input.checksum,
          fileName: input.fileName,
          locationId: input.location.id,
          locationName: input.location.name,
          currencyCode: input.currencyCode,
          status: "PREVIEWED",
          actor: input.actor,
          lines: { create: input.lines },
        },
        select: { id: true, receiptCode: true },
      });
      if (input.auditActor) {
        await transaction.activityLog.create({
          data: activityCreateData({
            shop: input.shop,
            eventType: "IMPORT_PREVIEWED",
            outcome: "SUCCEEDED",
            actor: input.auditActor,
            importBatchId: batch.id,
            receiptCode: batch.receiptCode,
            sourceKey: `batch:${batch.id}:preview`,
            summary: "CSV validated and import preview saved.",
            metadata: {
              rowCount: input.lines.length,
              blockedRows: input.lines.filter((line) => line.status === "BLOCKED").length,
              createDraftRows: input.lines.filter((line) => line.operationType === "CREATE_DRAFT").length,
              inventoryAddRows: input.lines.filter((line) => line.operationType === "ADJUST").length,
            },
          }),
        });
      }
      return { batchId: batch.id, receiptCode: batch.receiptCode, duplicateCsv };
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    // A concurrent request can pass the first token lookup before either
    // transaction commits. The unique token index chooses the winner; return
    // it only when its payload agrees with this request.
    const winner = await database.importBatch.findUnique({
      where: { shop_submissionId: { shop: input.shop, submissionId: input.submissionId } },
      select: { id: true, receiptCode: true, fileChecksum: true, locationId: true },
    });
    if (!winner) throw error;
    const result = assertSameSubmission(winner, input);
    return {
      ...result,
      duplicateCsv: await hasOtherMatchingCsv(database, input, winner.id),
    };
  }
}
