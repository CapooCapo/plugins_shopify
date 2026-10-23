import { createHash, randomUUID } from "node:crypto";
import prisma from "../db.server.ts";
import { parseReceivingCsv, type ReceivingCsvField, type ReceivingCsvPreview } from "./csv.server.ts";
import { classifyReceivingMatch } from "./csv.server.ts";
import { MAX_GRAPHQL_INT } from "./csv-limits.js";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { assertSourceRowNotInspected } from "./receiving-inspection.server.ts";

export class ReceivingImportError extends Error {
  constructor(message: string) { super(message); this.name = "ReceivingImportError"; }
}

export async function createReceivingImport(input: {
  shop: string; shipmentId: string; receiptId?: string | null; mode: "EXPECTED" | "RECEIVED";
  fileName: string; source: string; mapping?: Partial<Record<ReceivingCsvField, string>>;
}, db = prisma): Promise<{ duplicateWarning: boolean; attemptId: string | null; status: string | null; preview: ReceivingCsvPreview }> {
  if (!input.fileName.trim() || !input.source.trim()) throw new ReceivingImportError("Choose a CSV file with data.");
  const preview = parseReceivingCsv(input.source, input.mapping);
  if (preview.fileErrors.length) throw new ReceivingImportError(preview.fileErrors.join(" "));
  if (input.mode === "RECEIVED" && !input.receiptId) throw new ReceivingImportError("Received Goods import must be linked to a Receipt draft.");
  if (input.mode === "EXPECTED" && input.receiptId) throw new ReceivingImportError("Expected Goods cannot be attached to a physical Receipt.");
  const shipment = await db.shipment.findFirst({ where: { id: input.shipmentId, shop: input.shop } });
  if (!shipment || shipment.status === "CLOSED") throw new ReceivingImportError("An open Shipment belonging to this Shopify store is required.");
  if (input.receiptId) {
    const receipt = await db.receivingReceipt.findFirst({ where: { id: input.receiptId, shipmentId: shipment.id, shop: input.shop, status: "DRAFT" } });
    if (!receipt) throw new ReceivingImportError("Choose a draft Receipt belonging to this Shipment and Shopify store.");
  }
  const checksum = createHash("sha256").update(input.source, "utf8").digest("hex");
  const dedupeKey = createHash("sha256").update([input.shipmentId, input.receiptId ?? "", input.mode, checksum].join("\0"), "utf8").digest("hex");
  const duplicate = await db.receivingImportAttempt.findFirst({ where: { shop: input.shop, shipmentId: shipment.id, receiptId: input.receiptId ?? null, mode: input.mode, fileChecksum: checksum }, select: { id: true, status: true, mappingJson: true } });
  if (duplicate) return { duplicateWarning: true, attemptId: duplicate.id, status: duplicate.status, preview: parseReceivingCsv(input.source, JSON.parse(duplicate.mappingJson) as Partial<Record<ReceivingCsvField, string>>) };
  const attemptId = `imp_${randomUUID()}`;
  try { await db.$transaction(async (tx) => {
    if (input.mode === "RECEIVED") {
      // Production Prisma provides these delegates; optional delegates keep narrow pre-S1/S3 unit fakes usable.
      const s3Models = tx as unknown as {
        receivingReceipt?: { findFirst(args: Record<string, unknown>): Promise<{ id: string } | null> };
        receiptInspectionLine?: { findFirst(args: Record<string, unknown>): Promise<unknown> };
        receiptInspectionException?: { findFirst(args: Record<string, unknown>): Promise<unknown> };
      };
      if (s3Models.receivingReceipt) {
        const receipt = await s3Models.receivingReceipt.findFirst({ where: { id: input.receiptId ?? "", shop: input.shop, shipmentId: shipment.id, status: "DRAFT" }, select: { id: true } });
        if (!receipt) throw new ReceivingImportError("Choose a draft Receipt belonging to this Shipment and Shopify store.");
        const [inspectionLine, inspectionException] = await Promise.all([
          s3Models.receiptInspectionLine?.findFirst({ where: { shop: input.shop, receiptId: receipt.id }, select: { id: true } }) ?? null,
          s3Models.receiptInspectionException?.findFirst({ where: { shop: input.shop, receiptId: receipt.id }, select: { id: true } }) ?? null,
        ]);
        if (inspectionLine || inspectionException) throw new ReceivingImportError("Inspection has already started for this Receipt. Additional Received Goods imports are blocked; continue the existing inspection or use a linked Resolution later.");
      }
    }
    await tx.receivingImportAttempt.create({ data: {
      id: attemptId, shop: input.shop, shipmentId: shipment.id, receiptId: input.receiptId ?? null,
      mode: input.mode, fileName: input.fileName.slice(0, 255), fileChecksum: checksum, dedupeKey,
      mappingJson: JSON.stringify(preview.mapping), status: input.mode === "EXPECTED" ? "AWAITING_CONFIRMATION" : preview.rows.some((row) => row.errors.length) ? "PARTIAL" : preview.rows.some((row) => row.duplicateDecisionRequired) ? "NEEDS_REVIEW" : "READY",
      rows: { create: preview.rows.map((row) => ({
        id: randomUUID(), rowNumber: row.rowNumber, rawValuesJson: JSON.stringify(row.rawValues),
        sku: row.sku, quantity: row.quantity, productGroup: row.productGroup,
        validationJson: JSON.stringify(row.errors), outcome: row.errors.length ? "BLOCKED" : "NEEDS_REVIEW",
        decision: row.duplicateDecisionRequired && !row.duplicateConflict ? "MERGE_REQUIRED" : null,
      })) },
    } });
  }); } catch (error) {
    if ((error as { code?: string })?.code === "P2002") {
      const replay = await db.receivingImportAttempt.findFirst({ where: { shop: input.shop, dedupeKey }, select: { id: true, status: true, mappingJson: true } });
      if (replay) return { duplicateWarning: true, attemptId: replay.id, status: replay.status, preview: parseReceivingCsv(input.source, JSON.parse(replay.mappingJson) as Partial<Record<ReceivingCsvField, string>>) };
    }
    throw error;
  }
  return { duplicateWarning: false, attemptId, status: input.mode === "EXPECTED" ? "AWAITING_CONFIRMATION" : preview.rows.some((row) => row.errors.length) ? "PARTIAL" : preview.rows.some((row) => row.duplicateDecisionRequired) ? "NEEDS_REVIEW" : "READY", preview };
}

/** Applies a merchant-confirmed Expected Goods preview once; Receipt/import source rows remain unchanged. */
export async function confirmExpectedGoods(input: { shop: string; attemptId: string }, db = prisma) {
  return db.$transaction(async (tx) => {
    const attempt = await tx.receivingImportAttempt.findFirst({ where: { id: input.attemptId, shop: input.shop, mode: "EXPECTED", receiptId: null }, include: { rows: { orderBy: { rowNumber: "asc" } }, shipment: true } });
    if (!attempt) throw new ReceivingImportError("Expected Goods preview was not found for this Shopify store.");
    if (attempt.status === "EXPECTED_CONFIRMED") return { alreadyConfirmed: true, appliedSkus: 0, skippedRows: 0 };
    if (attempt.status !== "AWAITING_CONFIRMATION") throw new ReceivingImportError("This Expected Goods attempt is stale or not awaiting confirmation; review the current saved preview.");
    if (attempt.shipment.status === "CLOSED") throw new ReceivingImportError("Expected Goods cannot update a closed Shipment.");
    const expectedBySku = new Map<string, number>();
    const rowsBySku = new Map<string, typeof attempt.rows>();
    for (const row of attempt.rows) if (row.sku) rowsBySku.set(row.sku, [...(rowsBySku.get(row.sku) ?? []), row]);
    for (const [sku, duplicates] of rowsBySku) {
      if (duplicates.length === 1) {
        const [row] = duplicates;
        if (row && !JSON.parse(row.validationJson).length && row.quantity !== null && Number.isSafeInteger(row.quantity) && row.quantity > 0 && row.quantity <= MAX_GRAPHQL_INT) expectedBySku.set(sku, row.quantity);
        continue;
      }
      if (duplicates.some((row) => JSON.parse(row.validationJson).length) || !duplicates.every((row) => row.decision === "MERGE_DUPLICATES_CONFIRMED")) continue;
      const summary = duplicates[0]?.proposalJson ? JSON.parse(duplicates[0].proposalJson) as { sku?: string; aggregateQuantity?: number; sourceRows?: number[] } : null;
      const sourceRows = duplicates.map((row) => row.rowNumber);
      const realQuantity = duplicates.reduce((sum, row) => sum + (row.quantity ?? 0), 0);
      if (!summary || summary.sku !== sku || summary.aggregateQuantity !== realQuantity || JSON.stringify(summary.sourceRows) !== JSON.stringify(sourceRows) || !Number.isSafeInteger(realQuantity) || realQuantity < 1 || realQuantity > MAX_GRAPHQL_INT) continue;
      expectedBySku.set(sku, realQuantity);
    }
    for (const [sku, expectedQty] of expectedBySku) await tx.shipmentExpectation.upsert({
      where: { shipmentId_sku: { shipmentId: attempt.shipmentId, sku } },
      create: { id: randomUUID(), shipmentId: attempt.shipmentId, sku, expectedQty },
      update: { expectedQty },
    });
    await tx.receivingImportAttempt.update({ where: { id: attempt.id }, data: { status: "EXPECTED_CONFIRMED" } });
    const includedRows = new Set([...expectedBySku.keys()]);
    return { alreadyConfirmed: false, appliedSkus: expectedBySku.size, skippedRows: attempt.rows.filter((row) => !row.sku || !includedRows.has(row.sku)).length };
  });
}

export async function recordReceivingMatchDecision(input: { shop: string; attemptId: string; rowId: string; decision: string; productId?: string | null; variantId?: string | null }, db = prisma) {
  const row = await db.receivingImportRow.findFirst({ where: { id: input.rowId, attemptId: input.attemptId, attempt: { shop: input.shop } }, include: { proposalGroup: true } });
  if (!row) throw new ReceivingImportError("Import row not found for this Shopify store.");
  await assertSourceRowNotInspected(row.id, db);
  if (row.proposalGroupId) throw new ReceivingImportError("Split this source row from its Product proposal group before changing its match.");
  if (row.decision && row.decision !== "MERGE_REQUIRED") throw new ReceivingImportError("A confirmed matching decision is immutable.");
  if (row.validationJson && JSON.parse(row.validationJson).length) throw new ReceivingImportError("Correct row-level CSV validation errors before confirming a match.");
  const allowed = new Set(["EXISTING_VARIANT", "NEW_VARIANT", "NEW_PRODUCT", "NEEDS_REVIEW", "BLOCKED", "MERGE_DUPLICATES"]);
  if (!allowed.has(input.decision)) throw new ReceivingImportError("Unknown matching decision.");
  if (input.decision === "MERGE_DUPLICATES") throw new ReceivingImportError("Use the duplicate-group confirmation action so every source row receives the same decision.");
  if (input.decision === "EXISTING_VARIANT") throw new ReceivingImportError("Use the exact-match confirmation action to validate this Shopify Variant.");
  if (input.decision === "NEW_VARIANT" && (row.outcome !== "NEW_VARIANT" || !row.matchedProductId || !row.proposalJson)) throw new ReceivingImportError("Select a parent Product and validate a new option combination before confirming this proposal.");
  if (input.decision === "NEW_PRODUCT" && (!row.proposalGroupId || row.outcome !== "NEW_PRODUCT" || row.proposalGroup?.status !== "CONFIRMED_PROPOSAL")) throw new ReceivingImportError("Save and confirm an explicit Product group before confirming this proposal.");
  if ((input.productId && input.productId !== row.matchedProductId) || (input.variantId && input.variantId !== row.matchedVariantId)) throw new ReceivingImportError("Matching IDs must remain the server-validated selection for this row.");
  return db.receivingImportRow.update({ where: { id: row.id }, data: { decision: input.decision, matchedProductId: input.productId ?? row.matchedProductId, matchedVariantId: input.variantId ?? row.matchedVariantId } });
}

export async function confirmDuplicateSkuMerge(input: { shop: string; attemptId: string; rowId: string }, db = prisma) {
  const row = await db.receivingImportRow.findFirst({ where: { id: input.rowId, attemptId: input.attemptId, attempt: { shop: input.shop } }, include: { attempt: true } });
  if (!row?.sku || row.decision !== "MERGE_REQUIRED") throw new ReceivingImportError("This row is not part of a compatible duplicate-SKU group.");
  await assertSourceRowNotInspected(row.id, db);
  if (row.attempt.mode === "EXPECTED" && row.attempt.status === "EXPECTED_CONFIRMED") throw new ReceivingImportError("This Expected Goods preview is already confirmed; duplicate merge cannot change the Shipment plan after confirmation.");
  const rows = await db.receivingImportRow.findMany({ where: { attemptId: row.attemptId, sku: row.sku }, orderBy: { rowNumber: "asc" } });
  if (rows.length < 2 || rows.some((candidate) => JSON.parse(candidate.validationJson).length || candidate.decision !== "MERGE_REQUIRED")) {
    throw new ReceivingImportError("Duplicate rows are conflicting or invalid and cannot be merged.");
  }
  for (const candidate of rows) await assertSourceRowNotInspected(candidate.id, db);
  const sku = row.sku;
  const aggregateQuantity = rows.reduce((total, candidate) => total + (candidate.quantity ?? 0), 0);
  if (!Number.isSafeInteger(aggregateQuantity) || aggregateQuantity < 1 || aggregateQuantity > MAX_GRAPHQL_INT) throw new ReceivingImportError("Merged quantity must be a positive whole number within Shopify's supported integer range.");
  const summary = JSON.stringify({ sku, aggregateQuantity, sourceRows: rows.map((candidate) => candidate.rowNumber) });
  await db.$transaction(async (tx) => {
    for (const candidate of rows) await tx.receivingImportRow.update({ where: { id: candidate.id }, data: { decision: "MERGE_DUPLICATES_CONFIRMED", proposalJson: summary, decisionReason: "Explicit merge confirmed; original source rows remain individually preserved." } });
  });
  return { count: rows.length, aggregateQuantity, sourceRows: rows.map((candidate) => candidate.rowNumber) };
}

export async function lookupReceivingRowMatch(admin: AdminApiContext, input: { shop: string; attemptId: string; rowId: string }, db = prisma) {
  const row = await db.receivingImportRow.findFirst({ where: { id: input.rowId, attemptId: input.attemptId, attempt: { shop: input.shop } }, include: { attempt: true } });
  if (!row) throw new ReceivingImportError("Import row not found for this Shopify store.");
  await assertSourceRowNotInspected(row.id, db);
  if (row.proposalGroupId) throw new ReceivingImportError("Split this source row from its Product proposal group before changing its match.");
  if (row.decision && row.decision !== "MERGE_REQUIRED") throw new ReceivingImportError("A confirmed matching decision is immutable.");
  if (JSON.parse(row.validationJson).length) return { ...await db.receivingImportRow.update({ where: { id: row.id }, data: { outcome: "BLOCKED", decisionReason: "Correct the row-level CSV validation errors before product matching." } }), candidates: [], parentCandidates: [] };
  if (!row.sku) return { ...await db.receivingImportRow.update({ where: { id: row.id }, data: { outcome: "BLOCKED", decisionReason: "SKU is missing; no Shopify lookup is possible." } }), candidates: [], parentCandidates: [] };
  const response = await admin.graphql(`#graphql
    query StockHubReceivingSkuMatch($query: String!) {
      productVariants(first: 20, query: $query) {
        nodes { id sku title product { id title status } }
        pageInfo { hasNextPage }
      }
    }
  `, { variables: { query: `sku:${JSON.stringify(row.sku)}` } });
  const payload = await response.json() as { data?: { productVariants?: { nodes: Array<{ id: string; sku: string | null; title: string; product: { id: string; title: string; status: string } }>; pageInfo: { hasNextPage: boolean } } }; errors?: unknown[] };
  if (payload.errors || !payload.data?.productVariants) {
    const updated = await db.receivingImportRow.update({ where: { id: row.id }, data: { outcome: "NEEDS_REVIEW", decisionReason: "Shopify lookup did not complete; retry the read-only lookup before selecting a match." } });
    throw new ReceivingImportError(`Shopify lookup did not complete. Row remains ${updated.outcome}; no match was selected.`);
  }
  const exact = payload.data.productVariants.nodes.filter((variant) => variant.sku === row.sku);
  const lookupComplete = !payload.data.productVariants.pageInfo.hasNextPage;
  const raw = JSON.parse(row.rawValuesJson) as Record<string, string>;
  const mapping = JSON.parse(row.attempt.mappingJson) as Partial<Record<ReceivingCsvField, string>>;
  const productName = mapping.productName ? raw[mapping.productName] ?? null : null;
  const size = mapping.size ? raw[mapping.size] ?? null : null;
  const color = mapping.color ? raw[mapping.color] ?? null : null;
  const category = classifyReceivingMatch({
    variants: exact.map((variant) => ({ productId: variant.product.id, variantId: variant.id, sku: variant.sku })),
    lookupComplete: !payload.data.productVariants.pageInfo.hasNextPage,
    productName: productName || null,
    productGroup: row.productGroup,
    size: size || null,
    color: color || null,
  });
  let parentCandidates: Array<{ id: string; title: string }> = [];
  let parentLookupComplete = true;
  if (lookupComplete && (category.outcome === "NEW_VARIANT" || category.outcome === "NEW_PRODUCT")) {
    const titleQuery = productName ? `title:${JSON.stringify(productName)}` : "";
    if (titleQuery) {
      const searchResponse = await admin.graphql(`#graphql
        query StockHubReceivingParentSuggestions($query: String!) {
          products(first: 20, query: $query) { nodes { id title } pageInfo { hasNextPage } }
        }
      `, { variables: { query: titleQuery } });
      const searchPayload = await searchResponse.json() as { data?: { products?: { nodes: Array<{ id: string; title: string }>; pageInfo: { hasNextPage: boolean } } }; errors?: unknown[] };
      if (!searchPayload.data?.products || searchPayload.errors) parentLookupComplete = false;
      else {
        parentLookupComplete = !searchPayload.data.products.pageInfo.hasNextPage;
        parentCandidates = parentLookupComplete ? searchPayload.data.products.nodes : [];
      }
    }
  }
  const outcome = !lookupComplete || !parentLookupComplete ? "NEEDS_REVIEW" : category.outcome === "EXISTING_VARIANT" ? "EXISTING_VARIANT" : exact.length === 0 && productName ? "NEW_PRODUCT" : category.outcome === "NEW_VARIANT" ? "NEEDS_REVIEW" : category.outcome;
  const updated = await db.receivingImportRow.update({ where: { id: row.id }, data: {
    outcome,
    decisionReason: outcome === "NEEDS_REVIEW" ? !lookupComplete ? "Shopify returned more exact-SKU results than were fully read; retry/refine before proposing a match." : !parentLookupComplete ? "Parent Product title search was incomplete or unavailable; retry before creating a proposal." : exact.length > 1 ? "Multiple Shopify variants share this exact SKU; select a parent/variant manually." : !productName ? "Product Name is missing; cannot safely select a parent or create a grouped Product proposal." : "Lookup is incomplete or product identity data is insufficient; do not infer a product match." : outcome === "BLOCKED" ? !productName ? "Product Name is missing; a new Product or parent proposal cannot be identified from this CSV row." : "Required product identity data is missing or conflicting." : null,
    matchedProductId: category.candidateVariantId ? exact.find((candidate) => candidate.id === category.candidateVariantId)?.product.id ?? null : null,
    matchedVariantId: category.candidateVariantId,
    proposalJson: JSON.stringify({ candidates: exact.map(({ id, sku, title, product }) => ({ id, sku, title, product })), parentCandidates, lookupComplete, parentLookupComplete }),
  } });
  return { ...updated, candidates: exact.map(({ id, sku, title, product }) => ({ id, sku, title, product })), parentCandidates };
}

export async function confirmExistingVariantMatch(admin: AdminApiContext, input: { shop: string; attemptId: string; rowId: string; productId: string; variantId: string }, db = prisma) {
  const row = await db.receivingImportRow.findFirst({ where: { id: input.rowId, attemptId: input.attemptId, attempt: { shop: input.shop } } });
  if (!row?.sku) throw new ReceivingImportError("A valid import row with SKU is required.");
  await assertSourceRowNotInspected(row.id, db);
  if (row.proposalGroupId) throw new ReceivingImportError("Split this source row from its Product proposal group before changing its match.");
  if (row.decision && row.decision !== "EXISTING_VARIANT_CONFIRMED") throw new ReceivingImportError("A prior matching decision is immutable; retain this row and create a new resolution workflow.");
  if (row.decision) throw new ReceivingImportError("A confirmed row decision is immutable.");
  const prior = row.proposalJson ? JSON.parse(row.proposalJson) as { candidates?: Array<{ id: string; product: { id: string } }>; lookupComplete?: boolean } : null;
  if (!prior?.lookupComplete || !prior.candidates?.some((candidate) => candidate.id === input.variantId && candidate.product.id === input.productId)) throw new ReceivingImportError("Select a candidate from a complete read-only lookup for this row.");
  const response = await admin.graphql(`#graphql
    query StockHubConfirmExistingVariant($query: String!) {
      productVariants(first: 20, query: $query) { nodes { id sku product { id } } pageInfo { hasNextPage } }
    }
  `, { variables: { query: `sku:${JSON.stringify(row.sku)}` } });
  const payload = await response.json() as { data?: { productVariants?: { nodes: Array<{ id: string; sku: string | null; product: { id: string } }>; pageInfo: { hasNextPage: boolean } } } };
  const exact = payload.data?.productVariants;
  const candidate = exact?.nodes.find((variant) => variant.id === input.variantId && variant.product.id === input.productId && variant.sku === row.sku);
  if (!candidate || exact?.pageInfo.hasNextPage) {
    throw new ReceivingImportError("Selection is no longer a complete exact-SKU Shopify match; row remains unresolved.");
  }
  return db.receivingImportRow.update({ where: { id: row.id }, data: { outcome: "EXISTING_VARIANT", decision: "EXISTING_VARIANT_CONFIRMED", matchedProductId: candidate.product.id, matchedVariantId: candidate.id, decisionReason: prior.candidates.length > 1 ? "User explicitly resolved an ambiguous exact-SKU match." : null } });
}

export async function proposeNewVariant(admin: AdminApiContext, input: { shop: string; attemptId: string; rowId: string; productId: string; optionValuesJson: string }, db = prisma) {
  const row = await db.receivingImportRow.findFirst({ where: { id: input.rowId, attemptId: input.attemptId, attempt: { shop: input.shop } } });
  if (!row?.sku) throw new ReceivingImportError("A valid import row with SKU is required.");
  await assertSourceRowNotInspected(row.id, db);
  if (row.proposalGroupId) throw new ReceivingImportError("Split this source row from its Product proposal group before changing its match.");
  const lookup = row.proposalJson ? JSON.parse(row.proposalJson) as { lookupComplete?: boolean; parentCandidates?: Array<{ id: string }> } : null;
  if (!lookup?.lookupComplete || !lookup.parentCandidates?.some((candidate) => candidate.id === input.productId)) throw new ReceivingImportError("Select a suggested parent from a complete read-only lookup before proposing a variant.");
  let values: Record<string, string>;
  try { values = JSON.parse(input.optionValuesJson) as Record<string, string>; } catch { throw new ReceivingImportError("Enter option values as a JSON object, e.g. {\"Size\":\"XL\",\"Color\":\"Blue\"}."); }
  const response = await admin.graphql(`#graphql
    query StockHubValidateVariantProposal($id: ID!) {
      product(id: $id) {
        id title options { name values }
        variants(first: 100) { nodes { id selectedOptions { name value } } pageInfo { hasNextPage } }
      }
    }
  `, { variables: { id: input.productId } });
  const payload = await response.json() as { data?: { product?: { id: string; title: string; options: Array<{ name: string; values: string[] }>; variants: { nodes: Array<{ id: string; selectedOptions: Array<{ name: string; value: string }> }>; pageInfo: { hasNextPage: boolean } } } } };
  const product = payload.data?.product;
  if (!product || !product.options.length || product.options.some((option) => typeof values[option.name] !== "string" || !values[option.name]!.trim()) || Object.keys(values).length !== product.options.length) {
    throw new ReceivingImportError("Option values must provide exactly one non-empty value for every option on the selected parent Product.");
  }
  const combination = product.options.map((option) => values[option.name]!.trim());
  if (product.variants.pageInfo.hasNextPage) {
    await db.receivingImportRow.update({ where: { id: row.id }, data: { outcome: "NEEDS_REVIEW", decisionReason: "Parent Product has more than 100 variants; duplicate-option validation is incomplete." } });
    throw new ReceivingImportError("Cannot safely validate this Product's full variant set; row remains NEEDS_REVIEW.");
  }
  const duplicate = product.variants.nodes.find((variant) => product.options.every((option, index) => variant.selectedOptions.find((selected) => selected.name === option.name)?.value === combination[index]));
  if (duplicate) {
    await db.receivingImportRow.update({ where: { id: row.id }, data: { outcome: "NEEDS_REVIEW", decisionReason: "This option combination already exists on the selected Product." } });
    throw new ReceivingImportError("That option combination already exists; duplicate variant proposal blocked.");
  }
  return db.receivingImportRow.update({ where: { id: row.id }, data: { outcome: "NEW_VARIANT", matchedProductId: product.id, matchedVariantId: null, decision: null, decisionReason: null, proposalJson: JSON.stringify({ productId: product.id, productTitle: product.title, optionValues: values, sku: row.sku }) } });
}

export async function saveProductProposalGroup(input: { shop: string; attemptId: string; rowId: string; groupKey: string; productName: string }, db = prisma) {
  const key = input.groupKey.trim();
  const name = input.productName.trim();
  if (!key || !name) throw new ReceivingImportError("Group key and Product name are required.");
  const row = await db.receivingImportRow.findFirst({ where: { id: input.rowId, attemptId: input.attemptId, attempt: { shop: input.shop } } });
  if (!row) throw new ReceivingImportError("A valid row for this store is required.");
  await assertSourceRowNotInspected(row.id, db);
  if (row.proposalGroupId) throw new ReceivingImportError("Split this source row before assigning it to another Product proposal group.");
  if (row.decision) throw new ReceivingImportError("A confirmed row decision is immutable.");
  if (JSON.parse(row.validationJson).length) throw new ReceivingImportError("Rows with validation errors cannot join a Product proposal group.");
  const lookup = row.proposalJson ? JSON.parse(row.proposalJson) as { lookupComplete?: boolean; parentLookupComplete?: boolean; candidates?: unknown[] } : null;
  if (row.outcome !== "NEW_PRODUCT" || !lookup?.lookupComplete || lookup.parentLookupComplete !== true || !Array.isArray(lookup.candidates) || lookup.candidates.length !== 0) throw new ReceivingImportError("Only a server-verified NEW_PRODUCT row with complete lookups and zero exact-SKU candidates can join a Product proposal group.");
  const priorGroup = await db.receivingImportProposalGroup.findUnique({ where: { attemptId_groupKey: { attemptId: input.attemptId, groupKey: key } } });
  if (priorGroup?.status === "CONFIRMED_PROPOSAL") throw new ReceivingImportError("A confirmed proposal group is immutable; create a new group key for a revised proposal.");
  if (priorGroup && priorGroup.productName !== name) throw new ReceivingImportError("Rows assigned to one Product group must use the same Product name; split the group or choose a separate key.");
  const group = await db.receivingImportProposalGroup.upsert({ where: { attemptId_groupKey: { attemptId: input.attemptId, groupKey: key } }, create: { id: randomUUID(), attemptId: input.attemptId, groupKey: key, productName: name }, update: { status: "DRAFT", decision: null } });
  await db.receivingImportRow.update({ where: { id: row.id }, data: { proposalGroupId: group.id, outcome: "NEW_PRODUCT", decision: null, matchedProductId: null, matchedVariantId: null, decisionReason: null } });
  return group;
}

export async function splitProductProposalRow(input: { shop: string; attemptId: string; rowId: string }, db = prisma) {
  const row = await db.receivingImportRow.findFirst({ where: { id: input.rowId, attemptId: input.attemptId, attempt: { shop: input.shop }, proposalGroupId: { not: null } }, include: { attempt: true, proposalGroup: true } });
  if (!row) throw new ReceivingImportError("This row is not part of a product proposal group.");
  await assertSourceRowNotInspected(row.id, db);
  if (row.proposalGroup?.status === "CONFIRMED_PROPOSAL") throw new ReceivingImportError("A confirmed Product proposal is immutable; preserve it and create a new import for a revised grouping.");
  const formerGroupId = row.proposalGroupId!;
  return db.$transaction(async (tx) => {
    await tx.receivingImportRow.update({ where: { id: row.id }, data: { proposalGroupId: null, outcome: "NEEDS_REVIEW", decision: null, decisionReason: "Split from the Product proposal group; rerun matching before assigning a new proposal." } });
    const remaining = await tx.receivingImportRow.count({ where: { proposalGroupId: formerGroupId } });
    if (remaining === 0) await tx.receivingImportProposalGroup.update({ where: { id: formerGroupId }, data: { status: "EMPTY", decision: "SPLIT_ALL_ROWS" } });
    return { splitRowId: row.id, formerGroupId, remainingRows: remaining };
  });
}

export async function confirmProductProposalGroup(input: { shop: string; attemptId: string; groupId: string }, db = prisma) {
  const group = await db.receivingImportProposalGroup.findFirst({ where: { id: input.groupId, attemptId: input.attemptId, attempt: { shop: input.shop } }, include: { rows: true } });
  if (!group || !group.rows.length) throw new ReceivingImportError("Product proposal group is empty or not owned by this Shopify store.");
  for (const row of group.rows) await assertSourceRowNotInspected(row.id, db);
  const optionKeys = new Set<string>();
  const attempt = await db.receivingImportAttempt.findUniqueOrThrow({ where: { id: input.attemptId } });
  const mapping = JSON.parse(attempt.mappingJson) as Partial<Record<ReceivingCsvField, string>>;
  for (const row of group.rows) {
    const lookup = row.proposalJson ? JSON.parse(row.proposalJson) as { lookupComplete?: boolean; parentLookupComplete?: boolean; candidates?: unknown[] } : null;
    if (row.proposalGroupId !== group.id || row.outcome !== "NEW_PRODUCT" || JSON.parse(row.validationJson).length > 0 || !lookup?.lookupComplete || lookup.parentLookupComplete !== true || !Array.isArray(lookup.candidates) || lookup.candidates.length !== 0) {
      throw new ReceivingImportError("This Product group contains a stale or invalid row; every source row must still have a valid, complete zero-match NEW_PRODUCT lookup before confirmation.");
    }
    if (row.decision && !(group.status === "CONFIRMED_PROPOSAL" && row.decision === "NEW_PRODUCT_CONFIRMED")) throw new ReceivingImportError("This Product group contains a row with a conflicting confirmed decision.");
    const raw = JSON.parse(row.rawValuesJson) as Record<string, string>;
    const size = mapping.size ? raw[mapping.size]?.trim() ?? "" : "";
    const color = mapping.color ? raw[mapping.color]?.trim() ?? "" : "";
    if (group.rows.length > 1 && !size && !color) {
      await db.receivingImportRow.updateMany({ where: { proposalGroupId: group.id }, data: { outcome: "NEEDS_REVIEW", decisionReason: "Multiple variants lack mapped Size/Color values; unique option combinations cannot be proven." } });
      await db.receivingImportProposalGroup.update({ where: { id: group.id }, data: { status: "NEEDS_REVIEW", decision: null } });
      throw new ReceivingImportError("Multiple new variants require mapped Size or Color values to validate unique option combinations; keep rows in NEEDS_REVIEW or split the proposal.");
    }
    const key = `${size}\0${color}`;
    if (size || color) {
      if (optionKeys.has(key)) {
        await db.receivingImportRow.updateMany({ where: { proposalGroupId: group.id }, data: { outcome: "NEEDS_REVIEW", decisionReason: "Duplicate Size/Color option combination within the proposed Product group." } });
        await db.receivingImportProposalGroup.update({ where: { id: group.id }, data: { status: "NEEDS_REVIEW", decision: null } });
        throw new ReceivingImportError("Two rows in this proposed Product group have the same Size/Color option combination.");
      }
      optionKeys.add(key);
    }
  }
  if (group.status === "CONFIRMED_PROPOSAL" && group.rows.every((row) => row.decision === "NEW_PRODUCT_CONFIRMED")) return group;
  return db.$transaction(async (tx) => {
    const currentGroup = await tx.receivingImportProposalGroup.findFirst({ where: { id: input.groupId, attemptId: input.attemptId, attempt: { shop: input.shop } }, include: { rows: true } });
    if (!currentGroup || !currentGroup.rows.length) throw new ReceivingImportError("Product proposal group changed or is no longer owned by this Shopify store.");
    const currentKeys = new Set<string>();
    for (const row of currentGroup.rows) {
      const lookup = row.proposalJson ? JSON.parse(row.proposalJson) as { lookupComplete?: boolean; parentLookupComplete?: boolean; candidates?: unknown[] } : null;
      if (row.proposalGroupId !== currentGroup.id || row.outcome !== "NEW_PRODUCT" || JSON.parse(row.validationJson).length > 0 || !lookup?.lookupComplete || lookup.parentLookupComplete !== true || !Array.isArray(lookup.candidates) || lookup.candidates.length !== 0 || row.decision !== null) {
        throw new ReceivingImportError("Product group membership, validation, lookup, or decision changed during confirmation; reload and review the group again.");
      }
      const raw = JSON.parse(row.rawValuesJson) as Record<string, string>;
      const size = mapping.size ? raw[mapping.size]?.trim() ?? "" : "";
      const color = mapping.color ? raw[mapping.color]?.trim() ?? "" : "";
      if (currentGroup.rows.length > 1 && !size && !color) throw new ReceivingImportError("Multiple new variants require mapped Size or Color values to validate unique option combinations.");
      const key = `${size}\0${color}`;
      if ((size || color) && currentKeys.has(key)) throw new ReceivingImportError("Two rows in this proposed Product group have the same Size/Color option combination.");
      if (size || color) currentKeys.add(key);
    }
    const rowsConfirmed = await tx.receivingImportRow.updateMany({ where: { attemptId: input.attemptId, proposalGroupId: currentGroup.id, outcome: "NEW_PRODUCT", decision: null }, data: { decision: "NEW_PRODUCT_CONFIRMED", decisionReason: null } });
    if (rowsConfirmed.count !== currentGroup.rows.length) throw new ReceivingImportError("Product proposal membership or row decisions changed during confirmation; reload and review the group again.");
    const confirmed = await tx.receivingImportProposalGroup.update({ where: { id: currentGroup.id }, data: { status: "CONFIRMED_PROPOSAL", decision: "USER_CONFIRMED_GROUP" } });
    return confirmed;
  });
}
