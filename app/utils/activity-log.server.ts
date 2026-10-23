import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

export type ActivityActor = {
  actorType: "SHOPIFY_USER" | "UNKNOWN" | "SYSTEM";
  actorId: string | null;
};

type ActivityInput = {
  shop: string;
  eventType: string;
  outcome: "ATTEMPTED" | "SUCCEEDED" | "FAILED" | "UNCERTAIN" | "BLOCKED";
  actor: ActivityActor;
  summary: string;
  importBatchId?: string | null;
  importLineId?: string | null;
  receiptCode?: string | null;
  attemptId?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
  sourceKey?: string;
  occurredAt?: Date;
};

const MAX_METADATA_BYTES = 2048;

/** Attribute a human only when Shopify supplied a reliable online user ID. */
export function actorFromShopifySession(session: {
  isOnline?: boolean;
  userId?: bigint | number | null;
}): ActivityActor {
  if (session.isOnline && session.userId !== null && session.userId !== undefined) {
    return { actorType: "SHOPIFY_USER", actorId: String(session.userId) };
  }
  return { actorType: "UNKNOWN", actorId: null };
}

function safeMetadata(input: ActivityInput["metadata"]) {
  if (!input) return null;
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
    throw new Error("Activity metadata exceeds the bounded event size.");
  }
  return json;
}

export function activityCreateData(input: ActivityInput): Prisma.ActivityLogUncheckedCreateInput {
  return {
    id: randomUUID(),
    shop: input.shop,
    eventType: input.eventType,
    outcome: input.outcome,
    occurredAt: input.occurredAt ?? new Date(),
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    importBatchId: input.importBatchId ?? null,
    importLineId: input.importLineId ?? null,
    receiptCode: input.receiptCode ?? null,
    attemptId: input.attemptId ?? null,
    summary: input.summary.slice(0, 240),
    metadataJson: safeMetadata(input.metadata),
    sourceKey: input.sourceKey ?? randomUUID(),
  };
}

export async function appendActivity(input: ActivityInput, database: PrismaClient) {
  return database.activityLog.create({ data: activityCreateData(input) });
}
