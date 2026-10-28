import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { Fragment, useEffect, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { normalizeCatalogRows, parseCatalogCsv, validateCatalogMapping } from "../utils/catalog-import.server";
import { CATALOG_FIELDS, suggestCatalogField } from "../utils/catalog-import.shared";
import { normalizeCatalogGroupingValue, proposeCatalogProductGroups, validateCatalogVariantOptions, type CatalogGroupingLine, type GroupingIssue } from "../utils/catalog-grouping.shared";
import { evaluateCatalogQuality, type CatalogQualityRow } from "../utils/catalog-quality.shared";
import { readRequestBodyLimited } from "../utils/request-body.server";
import { compareCatalogGroups, type CatalogChangeProposal, type CatalogCompareField, type CatalogShopifyVariant } from "../utils/catalog-compare.shared";
import { readShopifyCatalogSnapshot } from "../utils/catalog-shopify-read.server";
import { missingScopesForGrant, queryGrantedScopes } from "../utils/shopify-scopes.server";
import { archiveCatalogReviewVersion, executeConfirmedCatalogReview, validateCatalogExecutionGateConfig, verifyCatalogExecutionDatabase } from "../utils/catalog-execution.server";

const labels: Record<(typeof CATALOG_FIELDS)[number], string> = {
  productName: "Product Name", sku: "SKU", price: "Price", description: "Description", productGroupCode: "Product Group Code",
  size: "Size", color: "Color", vendor: "Vendor", productType: "Product Type", imageUrl: "Image URL",
};
type CanonicalInput = { productName: string; sku: string; price: string; priceValid: boolean; priceZeroConfirmed: boolean; description: string; productGroupCode: string; size: string; color: string; vendor: string; productType: string; imageUrl: string; errors: string[] };
const GROUP_PRODUCT_FIELDS = ["productName", "vendor", "productType", "description", "imageUrl"] as const;
type GroupProductField = (typeof GROUP_PRODUCT_FIELDS)[number];
type GroupSelection = { value: string; sourceLineId: string } | null;
type GroupSelections = Partial<Record<GroupProductField, GroupSelection>>;
const PRODUCT_REVIEW_FIELDS = ["title", "description", "vendor", "productType"] as const;
const VARIANT_REVIEW_FIELDS = ["sku", "price", "size", "color"] as const;
type ReviewFieldChoice = "KEEP_SHOPIFY" | "USE_CSV" | "SKIP";
type CatalogReviewDecisions = {
  schemaVersion: 1;
  group: "CONFIRM" | "SKIP";
  productFields: Record<(typeof PRODUCT_REVIEW_FIELDS)[number], ReviewFieldChoice>;
  variants: Record<string, { operation: "CREATE" | "UPDATE" | "SKIP"; fields: Record<(typeof VARIANT_REVIEW_FIELDS)[number], ReviewFieldChoice> }>;
};
type CatalogReviewDisplayProposal = CatalogChangeProposal & {
  reviewId: string;
  reviewVersion: number;
  reviewStatus: string;
  reviewDraftVersion: number;
  snapshotFingerprint: string;
  snapshotCapturedAt: Date;
  decisions: unknown;
  stale: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return keys.length === Object.keys(value).length && keys.every((key) => Object.hasOwn(value, key));
}

function parseReviewDecisions(raw: unknown, lineIds: string[]): CatalogReviewDecisions {
  let value: unknown;
  try { value = JSON.parse(String(raw ?? "")); } catch { throw new Error("Review decisions are malformed. Reload and choose each decision again."); }
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "group", "productFields", "variants"]) || value.schemaVersion !== 1 || !["CONFIRM", "SKIP"].includes(String(value.group)) ||
    !isRecord(value.productFields) || !exactKeys(value.productFields, PRODUCT_REVIEW_FIELDS) || !isRecord(value.variants)) {
    throw new Error("Review decisions are incomplete or unsupported.");
  }
  const validChoices = new Set(["KEEP_SHOPIFY", "USE_CSV", "SKIP"]);
  for (const field of PRODUCT_REVIEW_FIELDS) {
    if (!validChoices.has(String(value.productFields[field]))) throw new Error(`Choose a supported decision for ${field}.`);
  }
  const knownLineIds = new Set(lineIds);
  const variantIds = Object.keys(value.variants);
  if (variantIds.some((id) => !knownLineIds.has(id))) throw new Error("Review decisions contain a row outside this product group.");
  if (variantIds.length !== knownLineIds.size || lineIds.some((id) => !Object.hasOwn(value.variants as object, id))) {
    throw new Error("Choose an explicit review decision for every row in this product group.");
  }
  for (const lineId of lineIds) {
    const variant = (value.variants as Record<string, unknown>)[lineId];
    if (!isRecord(variant) || !exactKeys(variant, ["operation", "fields"]) || !["CREATE", "UPDATE", "SKIP"].includes(String(variant.operation)) || !isRecord(variant.fields) || !exactKeys(variant.fields, VARIANT_REVIEW_FIELDS)) {
      throw new Error("Variant review decisions are incomplete or unsupported.");
    }
    for (const field of VARIANT_REVIEW_FIELDS) {
      if (!validChoices.has(String(variant.fields[field]))) throw new Error(`Choose a supported decision for ${field}.`);
    }
  }
  return value as unknown as CatalogReviewDecisions;
}

function snapshotForReview(proposal: CatalogChangeProposal, lines: Array<{ id: string; sku: string | null }>, variants: CatalogShopifyVariant[]) {
  const skus = new Set(lines.filter((line) => proposal.rowIds.includes(line.id)).map((line) => line.sku?.trim()).filter((sku): sku is string => Boolean(sku)));
  const title = proposal.groupTitle.trim().toLocaleLowerCase();
  const relevantVariants = variants.filter((variant) => proposal.productId
    ? variant.productId === proposal.productId
    : Boolean(variant.sku?.trim() && skus.has(variant.sku.trim())) || variant.productTitle.trim().toLocaleLowerCase() === title);
  const snapshot = { variants: relevantVariants };
  const fingerprint = createHash("sha256").update(JSON.stringify(snapshot.variants)).digest("hex");
  return { snapshot, fingerprint, matchedVariantIds: [...new Set(relevantVariants.map((variant) => variant.id))] };
}

function savedProposalForReview(snapshot: unknown, groupId: string, operation: string, lineIds: string[]): CatalogChangeProposal {
  const proposal = isRecord(snapshot) && isRecord(snapshot.proposal) ? snapshot.proposal : null;
  const proposalLineIds = proposal && Array.isArray(proposal.rowIds) && proposal.rowIds.every((id) => typeof id === "string")
    ? new Set(proposal.rowIds as string[])
    : null;
  if (!proposal || proposal.groupId !== groupId || proposal.disposition !== operation || typeof proposal.groupTitle !== "string" ||
    !(proposal.productId === null || typeof proposal.productId === "string") || !proposalLineIds || proposalLineIds.size !== lineIds.length ||
    lineIds.some((id) => !proposalLineIds.has(id))) {
    throw new Error("The saved Shopify comparison is incomplete. Compare this group again before confirming.");
  }
  return proposal as unknown as CatalogChangeProposal;
}

function validateProposedReviewChoices(
  decisions: CatalogReviewDecisions,
  lines: Array<Record<string, unknown>>,
  selections: GroupSelections,
  mapping: unknown,
) {
  const mappedFields = new Set(Object.values(isRecord(mapping) ? mapping : {}).filter((field): field is string => typeof field === "string"));
  const requireProposedValue = (decision: ReviewFieldChoice, mappedField: string, value: unknown, label: string) => {
    if (decision === "USE_CSV" && (!mappedFields.has(mappedField) || typeof value !== "string" || !value.trim())) {
      throw new Error(`“Use CSV” is unavailable for ${label}; the source value is empty or unmapped. Keep Shopify’s current value instead.`);
    }
  };
  const productFieldSources = {
    title: "productName", description: "description", vendor: "vendor", productType: "productType",
  } as const;
  for (const field of PRODUCT_REVIEW_FIELDS) {
    const sourceField = productFieldSources[field];
    const selection = selections[sourceField as GroupProductField];
    const selectedLine = selection ? lines.find((line) => line.id === selection.sourceLineId) : undefined;
    const value = selection?.value ?? selectedLine?.[sourceField] ?? lines.find((line) => typeof line[sourceField] === "string" && String(line[sourceField]).trim())?.[sourceField];
    requireProposedValue(decisions.productFields[field], sourceField, value, field);
  }
  for (const [lineId, decision] of Object.entries(decisions.variants)) {
    const line = lines.find((candidate) => candidate.id === lineId);
    if (!line) throw new Error("Review decisions contain a row outside this product group.");
    for (const field of VARIANT_REVIEW_FIELDS) {
      const raw = line[field];
      const value = raw == null ? null : typeof raw === "string" ? raw : String(raw);
      requireProposedValue(decision.fields[field], field, value, `${field} on row ${lineId}`);
    }
  }
}

function validateCreateReviewInputs(
  decisions: CatalogReviewDecisions,
  lines: Array<Record<string, unknown>>,
  mapping: unknown,
  snapshot: unknown,
) {
  const snapshotVariants = isRecord(snapshot) ? snapshot.variants : null;
  if (!Array.isArray(snapshotVariants)) {
    throw new Error("The saved CREATE comparison is incomplete. Compare this group with Shopify again before confirming.");
  }
  if (snapshotVariants.length) {
    throw new Error("This CREATE comparison contains current Shopify values. Compare this group again before confirming.");
  }

  const mappedFields = new Set(Object.values(isRecord(mapping) ? mapping : {}).filter((field): field is string => typeof field === "string"));
  const activeVariants = Object.entries(decisions.variants).filter(([, decision]) => decision.operation !== "SKIP");
  if (!activeVariants.length) throw new Error("Choose Create for at least one variant, or skip the whole group.");

  if (decisions.productFields.title !== "USE_CSV" || !mappedFields.has("productName") || !lines.some((line) => typeof line.productName === "string" && line.productName.trim())) {
    throw new Error("A new product needs a non-empty mapped CSV title. Choose Use CSV for Product title before confirming.");
  }

  const activeLines = activeVariants.map(([lineId]) => lines.find((line) => line.id === lineId)).filter((line): line is Record<string, unknown> => Boolean(line));
  const requiredOptionFields = (["size", "color"] as const).filter((field) => activeLines.some((line) => typeof line[field] === "string" && line[field].trim()));
  if (activeLines.length > 1 && !requiredOptionFields.length) {
    throw new Error("Multiple new variants need mapped Size or Color values. Add option values before confirming.");
  }

  for (const [lineId, decision] of activeVariants) {
    const line = lines.find((candidate) => candidate.id === lineId);
    if (!line) throw new Error("A selected CREATE variant is no longer in this group. Compare again before confirming.");
    const row = line.sourceRowNumber ?? line.rowNumber ?? lineId;
    for (const field of ["sku", "price"] as const) {
      const raw = line[field];
      const value = raw == null ? "" : String(raw).trim();
      if (decision.fields[field] !== "USE_CSV" || !mappedFields.has(field) || !value) {
        throw new Error(`A new variant needs a non-empty mapped CSV ${field.toUpperCase()}. Choose Use CSV for ${field} on row ${row} before confirming.`);
      }
      if (field === "price" && !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(value)) {
        throw new Error(`A new variant needs a valid non-negative CSV price. Correct the price on row ${row} before confirming.`);
      }
      if (field === "price" && /^0(?:\.0{1,6})?$/.test(value) && line.priceZeroConfirmed !== true) {
        throw new Error(`Confirm that the zero price is intentional on row ${row} before confirming this new product.`);
      }
    }
    for (const field of requiredOptionFields) {
      const value = line[field];
      if (decision.fields[field] !== "USE_CSV" || !mappedFields.has(field) || typeof value !== "string" || !value.trim()) {
        throw new Error(`A new variant needs a non-empty mapped CSV ${field === "size" ? "Size" : "Color"}. Choose Use CSV on row ${row} before confirming.`);
      }
    }
  }
}

async function lockCurrentDraft(tx: Prisma.TransactionClient, shop: string, batchId: string, draftVersion: number, staleMessage = "This catalog draft changed or is stale. Reload before saving review decisions.") {
  // A no-op version update obtains the batch row lock without changing draftVersion.
  // Draft edits use the same row, so review saves/confirms serialize with edits.
  const locked = await tx.catalogImportBatch.updateMany({
    where: { shop, id: batchId, draftVersion, status: "DRAFT" },
    data: { draftVersion: { increment: 0 } },
  });
  if (locked.count !== 1) throw new Error(staleMessage);
  const inFlightExecution = await tx.catalogExecutionOperation.findFirst({ where: { shop, batchId, status: { in: ["RUNNING", "RECONCILING", "UNKNOWN"] } }, select: { id: true, status: true } });
  if (inFlightExecution) throw new Error("A catalog execution has an unresolved Shopify outcome. Reconcile it before changing or re-comparing this draft.");
}

function groupingLine(line: Record<string, unknown>): CatalogGroupingLine {
  return {
    id: String(line.id), shop: String(line.shop), batchId: String(line.batchId),
    productName: line.productName as string | null, sku: line.sku as string | null,
    productGroupCode: line.productGroupCode as string | null, size: line.size as string | null,
    color: line.color as string | null, vendor: line.vendor as string | null,
    productType: line.productType as string | null, description: line.description as string | null,
    imageUrl: line.imageUrl as string | null, status: line.status as string,
    errors: line.errors, sourceRowNumber: line.sourceRowNumber as number | null,
    sourceValues: line.sourceValues,
  };
}

function initialSelections(lines: CatalogGroupingLine[]): GroupSelections {
  const selections: GroupSelections = {};
  for (const field of GROUP_PRODUCT_FIELDS) {
    const values = new Map<string, CatalogGroupingLine>();
    const distinct = new Set<string>();
    for (const line of lines) {
      const value = typeof line[field] === "string" ? String(line[field]).trim() : "";
      const normalized = normalizeCatalogGroupingValue(value);
      if (normalized) { distinct.add(normalized); values.set(normalized, line); }
    }
    if (distinct.size === 1) {
      const line = values.values().next().value as CatalogGroupingLine | undefined;
      if (line) selections[field] = { value: String(line[field]).trim(), sourceLineId: line.id };
    } else selections[field] = null;
  }
  return selections;
}

function validateGroup(lines: CatalogGroupingLine[], selections: GroupSelections, source = "productName", batchLines: CatalogGroupingLine[] = lines): GroupingIssue[] {
  const issues: GroupingIssue[] = [];
  const proposals = proposeCatalogProductGroups(lines);
  if (source !== "MANUAL" && proposals.length !== 1) {
    issues.push({ code: "GROUPING_KEY_CONFLICT", message: "Rows no longer share one suggested grouping key. Review the membership before accepting this group.", lineIds: lines.map((line) => line.id), field: "productGroupCode" });
  }
  for (const proposal of proposals) {
    for (const issue of proposal.issues) {
      if (issue.code === "PRODUCT_FIELD_CONFLICT" && issue.field && GROUP_PRODUCT_FIELDS.includes(issue.field as GroupProductField)) {
        const selection = selections[issue.field as GroupProductField];
        const selectedLine = lines.find((line) => line.id === selection?.sourceLineId);
        const selectedValue = selectedLine?.[issue.field];
        if (selection && selectedLine && typeof selectedValue === "string" && selection.value === selectedValue.trim()) continue;
      }
      issues.push(issue);
    }
  }
  // MANUAL groups may intentionally combine rows whose original suggestion
  // keys differ. Validate option dimensions over the merged membership itself,
  // rather than independently validating those now-obsolete source groups.
  if (source === "MANUAL" && proposals.length > 1 && lines.length > 1) {
    issues.push(...validateCatalogVariantOptions(lines));
  }
  const groupLineIds = new Set(lines.map((line) => line.id));
  const skuMatches = new Map<string, CatalogGroupingLine[]>();
  for (const line of batchLines) {
    const sku = normalizeCatalogGroupingValue(line.sku);
    if (sku) skuMatches.set(sku, [...(skuMatches.get(sku) ?? []), line]);
  }
  for (const duplicateRows of skuMatches.values()) {
    if (duplicateRows.length > 1 && duplicateRows.some((line) => groupLineIds.has(line.id))) {
      const duplicateIdSet = new Set(duplicateRows.map((line) => line.id));
      if (!issues.some((issue) => issue.code === "DUPLICATE_SKU" && issue.lineIds.some((id) => duplicateIdSet.has(id)))) {
        issues.push({ code: "DUPLICATE_SKU", message: `SKU “${String(duplicateRows[0].sku)}” appears more than once in this batch.`, lineIds: duplicateRows.map((line) => line.id), field: "sku" });
      }
    }
  }
  for (const line of lines) {
    const errors = Array.isArray(line.errors) ? line.errors : [];
    if (line.status === "ERROR" && errors.length) {
      for (const error of errors) issues.push({ code: "SOURCE_ROW_ERROR", message: `Source row ${line.sourceRowNumber ?? "manual"}: ${String(error)}`, lineIds: [line.id] });
    }
  }
  for (const field of GROUP_PRODUCT_FIELDS) {
    const values = new Set(lines.map((line) => normalizeCatalogGroupingValue(typeof line[field] === "string" ? String(line[field]) : "")).filter(Boolean));
    if (values.size > 1) {
      const selection = selections[field];
      const selectedLine = lines.find((line) => line.id === selection?.sourceLineId);
      const selectedValue = selectedLine?.[field];
      if (!selection || !selectedLine || typeof selectedValue !== "string" || selection.value !== selectedValue.trim()) {
        if (!issues.some((issue) => issue.code === "PRODUCT_FIELD_CONFLICT" && issue.field === field)) {
          issues.push({ code: "PRODUCT_FIELD_CONFLICT", message: `Choose the ${field} value from one of the source rows.`, lineIds: lines.filter((line) => Boolean(line[field])).map((line) => line.id), field });
        }
      }
    }
  }
  return issues;
}

async function suggestUnassignedGroups(tx: Prisma.TransactionClient, shop: string, batchId: string) {
  const rows = await tx.catalogImportLine.findMany({ where: { shop, batchId, groupId: null }, orderBy: { rowNumber: "asc" } });
  const lines = rows.map((line) => groupingLine(line as unknown as Record<string, unknown>));
  for (const proposal of proposeCatalogProductGroups(lines)) {
    const groupId = randomUUID();
    const selections = initialSelections(proposal.lines);
    const validation = validateGroup(proposal.lines, selections, proposal.source, lines);
    await tx.catalogImportGroup.create({ data: {
      id: groupId, shop, batchId, source: proposal.source, groupingKey: proposal.normalizedValue,
      reason: proposal.reason, selections: selections as object, validation: validation as object,
      state: "ACTIVE", confirmedAt: null,
    } });
    await tx.catalogImportLine.updateMany({
      where: { shop, batchId, id: { in: proposal.lines.map((line) => line.id) }, groupId: null },
      data: { groupId },
    });
  }
}

async function refreshGroupValidation(tx: Prisma.TransactionClient, shop: string, batchId: string, groupId: string) {
  const group = await tx.catalogImportGroup.findFirst({
    where: { shop, batchId, id: groupId, state: "ACTIVE" },
    include: { lines: { orderBy: { rowNumber: "asc" } } },
  });
  if (!group) return;
  const lines = group.lines.map((line) => groupingLine(line as unknown as Record<string, unknown>));
  const selections = (group.selections && typeof group.selections === "object" ? group.selections : {}) as GroupSelections;
  const allRows = await tx.catalogImportLine.findMany({ where: { shop, batchId }, orderBy: { rowNumber: "asc" } });
  const validation = validateGroup(lines, selections, group.source, allRows.map((line) => groupingLine(line as unknown as Record<string, unknown>)));
  await tx.catalogImportGroup.update({ where: { id: groupId }, data: { validation: validation as object, confirmedAt: null } });
}

async function createManualGroup(
  tx: Prisma.TransactionClient,
  shop: string,
  batchId: string,
  lineIds: string[],
  reason: string,
) {
  const lines = await tx.catalogImportLine.findMany({ where: { shop, batchId, id: { in: lineIds } }, orderBy: { rowNumber: "asc" } });
  if (lines.length !== new Set(lineIds).size || !lines.length) throw new Error("Select rows from this draft only.");
  const groupId = randomUUID();
  const groupingLines = lines.map((line) => groupingLine(line as unknown as Record<string, unknown>));
  const selections = initialSelections(groupingLines);
  const validation = validateGroup(groupingLines, selections, "MANUAL", groupingLines);
  await tx.catalogImportGroup.create({ data: {
    id: groupId, shop, batchId, source: "MANUAL", groupingKey: `manual:${groupId}`,
    reason, selections: selections as object, validation: validation as object, state: "ACTIVE", confirmedAt: null,
  } });
  await tx.catalogImportLine.updateMany({ where: { shop, batchId, id: { in: lineIds } }, data: { groupId } });
  return groupId;
}

async function handleGroupingAction(
  tx: Prisma.TransactionClient,
  shop: string,
  batchId: string,
  _version: number,
  form: FormData,
  intent: string,
) {
  const groupId = String(form.get("groupId") ?? "");
  if (intent === "accept-group") {
    const group = await tx.catalogImportGroup.findFirst({ where: { shop, batchId, id: groupId, state: "ACTIVE" }, include: { lines: { orderBy: { rowNumber: "asc" } } } });
    if (!group) throw new Error("Product group not found in this draft.");
    const selections = (group.selections && typeof group.selections === "object" ? group.selections : {}) as GroupSelections;
    const groupLines = group.lines.map((line) => groupingLine(line as unknown as Record<string, unknown>));
    const allRows = await tx.catalogImportLine.findMany({ where: { shop, batchId }, orderBy: { rowNumber: "asc" } });
    const issues = validateGroup(groupLines, selections, group.source, allRows.map((line) => groupingLine(line as unknown as Record<string, unknown>)));
    if (issues.length) throw new Error("Resolve all group and row validation issues before accepting this group.");
    await tx.catalogImportGroup.update({ where: { id: groupId }, data: { confirmedAt: new Date(), validation: [] } });
    return;
  }
  if (intent === "resolve-field") {
    const field = String(form.get("field") ?? "") as GroupProductField;
    if (!GROUP_PRODUCT_FIELDS.includes(field)) throw new Error("Choose a supported product-level field.");
    const sourceLineId = String(form.get("sourceLineId") ?? "");
    const group = await tx.catalogImportGroup.findFirst({ where: { shop, batchId, id: groupId, state: "ACTIVE" }, include: { lines: true } });
    if (!group || !group.lines.some((line) => line.id === sourceLineId)) throw new Error("Choose a source row from this product group.");
    const source = group.lines.find((line) => line.id === sourceLineId)!;
    const sourceValue = source[field];
    if (typeof sourceValue !== "string" || !sourceValue.trim()) throw new Error("The selected source row has no value for this field.");
    const selections = (group.selections && typeof group.selections === "object" ? group.selections : {}) as GroupSelections;
    selections[field] = { value: sourceValue.trim(), sourceLineId };
    await tx.catalogImportGroup.update({ where: { id: groupId }, data: { selections: selections as object, confirmedAt: null } });
    await refreshGroupValidation(tx, shop, batchId, groupId);
    return;
  }
  if (intent === "merge-groups") {
    let groupIds: unknown;
    try { groupIds = JSON.parse(String(form.get("groupIds") ?? "[]")); } catch { throw new Error("Choose at least two groups to merge."); }
    if (!Array.isArray(groupIds) || groupIds.length < 2 || groupIds.some((id) => typeof id !== "string") || new Set(groupIds).size !== groupIds.length) throw new Error("Choose at least two distinct groups to merge.");
    const groups = await tx.catalogImportGroup.findMany({ where: { shop, batchId, id: { in: groupIds as string[] }, state: "ACTIVE" }, include: { lines: true } });
    if (groups.length !== groupIds.length) throw new Error("All selected groups must belong to this shop and draft.");
    const lineIds = groups.flatMap((group) => group.lines.map((line) => line.id));
    if (!lineIds.length) throw new Error("Selected groups contain no rows.");
    await tx.catalogImportGroup.updateMany({ where: { shop, batchId, id: { in: groupIds as string[] }, state: "ACTIVE" }, data: { state: "SUPERSEDED", confirmedAt: null } });
    await createManualGroup(tx, shop, batchId, lineIds, "Merchant merged these groups. Review all rows and explicitly accept the result.");
    return;
  }
  if (intent === "split-selected") {
    let lineIds: unknown;
    try { lineIds = JSON.parse(String(form.get("lineIds") ?? "[]")); } catch { throw new Error("Select one or more rows to split."); }
    if (!Array.isArray(lineIds) || lineIds.length < 1 || lineIds.some((id) => typeof id !== "string") || new Set(lineIds).size !== lineIds.length) throw new Error("Select one or more distinct rows to split.");
    const group = await tx.catalogImportGroup.findFirst({ where: { shop, batchId, id: groupId, state: "ACTIVE" }, include: { lines: true } });
    if (!group) throw new Error("Product group not found in this draft.");
    if (lineIds.some((id) => !group.lines.some((line) => line.id === id))) throw new Error("Only rows in this product group can be split.");
    await createManualGroup(tx, shop, batchId, lineIds as string[], "Merchant split these rows into a separate product proposal. Review and explicitly accept it.");
    const remainder = await tx.catalogImportLine.count({ where: { shop, batchId, groupId } });
    if (!remainder) await tx.catalogImportGroup.update({ where: { id: groupId }, data: { state: "SUPERSEDED", confirmedAt: null } });
    else await refreshGroupValidation(tx, shop, batchId, groupId);
    return;
  }
  throw new Error("Unknown grouping action.");
}

function readCanonical(form: FormData): CanonicalInput {
  const value = (key: keyof CanonicalInput) => String(form.get(key) ?? "").trim();
  const fields = Object.fromEntries(CATALOG_FIELDS.map((key) => [key, value(key)])) as Record<(typeof CATALOG_FIELDS)[number], string>;
  const price = fields.price;
  const errors: string[] = [];
  if (!fields.productName) errors.push("Product Name is required.");
  if (!fields.sku) errors.push("SKU is required.");
  const priceValid = !price || /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(price);
  if (!priceValid) errors.push(`Price must be a non-negative decimal with up to 14 integer digits and 6 fractional digits. The attempted value was “${price.slice(0, 128)}”.`);
  const priceZeroConfirmed = form.get("priceZeroConfirmed") === "on";
  if (price && /^0(?:\.0{1,6})?$/.test(price) && !priceZeroConfirmed) errors.push("Confirm that zero price is intentional.");
  return { ...fields, price, priceValid, priceZeroConfirmed, errors };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const batch = await prisma.catalogImportBatch.findFirst({
    where: { shop: session.shop, id: params.batchId },
    include: {
      lines: { orderBy: { rowNumber: "asc" } },
      groups: { include: { lines: { orderBy: { rowNumber: "asc" } }, reviewRecords: { orderBy: { createdAt: "desc" } }, reviewHistory: { orderBy: { archivedAt: "desc" } }, executionOperations: { orderBy: { createdAt: "desc" }, include: { items: { orderBy: { createdAt: "asc" } }, attempts: { orderBy: { startedAt: "asc" } } } } }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!batch) throw new Response("Catalog draft not found", { status: 404 });
  const headers = Array.isArray(batch.sourceHeaders) ? batch.sourceHeaders.map(String) : [];
  const samples = parseCatalogCsv(batch.originalCsv).rows[0]?.values ?? [];
  const reviewHistory = batch.groups.flatMap((group) => [
    ...group.reviewRecords.map((record) => {
      const snapshot = isRecord(record.snapshot) ? record.snapshot : {};
      const stale = record.draftVersion !== batch.draftVersion || record.status === "STALE";
      return { ...record, proposal: isRecord(snapshot.proposal) ? snapshot.proposal as unknown as CatalogChangeProposal : null, stale, effectiveStatus: stale ? "STALE" : record.status, archived: false, archivedAt: null };
    }),
    ...group.reviewHistory.map((record) => {
      const snapshot = isRecord(record.snapshot) ? record.snapshot : {};
      return { ...record, proposal: isRecord(snapshot.proposal) ? snapshot.proposal as unknown as CatalogChangeProposal : null, stale: true, effectiveStatus: "STALE", archived: true };
    }),
  ]).sort((left, right) => (right.archivedAt ?? right.updatedAt).getTime() - (left.archivedAt ?? left.updatedAt).getTime());
  const groups = batch.groups.filter((group) => group.state === "ACTIVE").map((group) => {
    const lines = group.lines.map((line) => groupingLine(line as unknown as Record<string, unknown>));
    const selections = (group.selections && typeof group.selections === "object" ? group.selections : {}) as GroupSelections;
    const issues = validateGroup(lines, selections, group.source, batch.lines.map((line) => groupingLine(line as unknown as Record<string, unknown>)));
    const reviewRecords = reviewHistory.filter((record) => record.groupId === group.id);
    return { ...group, lines: group.lines, issues, canAccept: issues.length === 0, reviewRecords, executionOperations: group.executionOperations };
  });
  const warnMissingImage = new URL(request.url).searchParams.get("warnMissingImage") === "1";
  const quality = evaluateCatalogQuality(
    batch.lines.map((line) => ({ ...groupingLine(line as unknown as Record<string, unknown>), price: line.price?.toString() ?? null, priceZeroConfirmed: line.priceZeroConfirmed, groupId: line.groupId } as CatalogQualityRow)),
    groups.map((group) => ({
      id: group.id,
      lines: group.lines.map((line) => ({ ...groupingLine(line as unknown as Record<string, unknown>), price: line.price?.toString() ?? null, priceZeroConfirmed: line.priceZeroConfirmed, groupId: line.groupId } as CatalogQualityRow)),
      issues: group.issues,
      confirmedAt: group.confirmedAt,
      optionDimensions: [
        ...(group.lines.some((line) => normalizeCatalogGroupingValue(line.size)) ? ["Size"] : []),
        ...(group.lines.some((line) => normalizeCatalogGroupingValue(line.color)) ? ["Color"] : []),
      ],
    })),
    { warnMissingImage },
  );
  return { batch, groups, reviewHistory, headers, samples, fields: CATALOG_FIELDS, labels, quality, warnMissingImage, prepared: new URL(request.url).searchParams.get("prepared") };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const body = await readRequestBodyLimited(request.clone(), 128 * 1024);
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const form = await new Request(request.url, { method: request.method, headers, body }).formData();
  const batchId = params.batchId;
  const intent = String(form.get("intent") ?? "");
  const executionIntent = ["execute-catalog", "retry-catalog", "reconcile-catalog", "resume-catalog"].includes(intent);
  if (executionIntent) {
    try {
      const expectedStore = process.env.STOCKHUB_CATALOG_EXECUTION_EXPECTED_DEV_STORE ?? "";
      const config = validateCatalogExecutionGateConfig(expectedStore, process.env);
      await verifyCatalogExecutionDatabase(prisma, config);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Catalog execution is blocked by the local development safety gate." };
    }
  }
  const { session, admin, scopes } = await authenticate.admin(request);
  const version = Number(form.get("draftVersion"));
  if (!batchId || !Number.isSafeInteger(version) || version < 0) return { error: "Reload this draft and try again." };
  try {
    if (["execute-catalog", "retry-catalog", "reconcile-catalog", "resume-catalog"].includes(intent)) {
      const groupId = String(form.get("groupId") ?? "");
      const expectedReviewVersion = Number(form.get("reviewVersion"));
      const expectedFingerprint = String(form.get("snapshotFingerprint") ?? "");
      if (!groupId || !Number.isSafeInteger(expectedReviewVersion) || expectedReviewVersion < 0 || !/^[a-f0-9]{64}$/i.test(expectedFingerprint)) {
        throw new Error("Reload the confirmed catalog review and try again.");
      }
      const executionResult = await executeConfirmedCatalogReview({
        shop: session.shop, batchId, groupId, draftVersion: version, expectedReviewVersion, expectedFingerprint,
        admin: admin as unknown as { graphql: (query: string, options?: { variables?: Record<string, unknown>; signal?: AbortSignal; tries?: number }) => Promise<Response> },
        // Keep legacy resume-catalog posts read-only. An expired lease cannot
        // prove that its previous Shopify request stopped before dispatch.
        scopes, prisma, reconcileOnly: intent === "reconcile-catalog" || intent === "resume-catalog",
      });
      return { executionResult };
    }
    const batch = await prisma.catalogImportBatch.findFirst({ where: { shop: session.shop, id: batchId } });
    if (!batch) throw new Error("Catalog draft not found.");
    if (batch.draftVersion !== version) throw new Error("This draft changed in another tab. Reload before saving.");
    if (intent === "compare-shopify") {
      if (batch.status !== "DRAFT") throw new Error("Only a mapped catalog draft can be compared.");
      let grantedScopes: string[];
      try { grantedScopes = await queryGrantedScopes(scopes); }
      catch { throw new Error("StockHub could not verify the current Shopify read permission. No catalog query was run; refresh and retry."); }
      if (missingScopesForGrant(grantedScopes, ["read_products"]).length) throw new Error("Shopify has not granted read_products. No catalog query was run.");
      const current = await prisma.catalogImportBatch.findFirst({ where: { shop: session.shop, id: batchId }, include: { lines: true, groups: { where: { state: "ACTIVE" }, include: { lines: true } } } });
      if (!current || current.draftVersion !== version) throw new Error("This draft changed. Reload before comparing.");
      const mapping = current.mapping && typeof current.mapping === "object" ? current.mapping as Record<string, unknown> : {};
      const mappedFields = new Set(Object.values(mapping).filter((field): field is string => typeof field === "string"));
      const mapped = (field: string) => mappedFields.has(field);
      const qualityRows = current.lines.map((line) => ({ ...groupingLine(line as unknown as Record<string, unknown>), price: line.price?.toString() ?? null, priceZeroConfirmed: line.priceZeroConfirmed, groupId: line.groupId } as CatalogQualityRow));
      const activeGroups = current.groups.map((group) => ({
        id: group.id,
        lines: group.lines.map((line) => ({ ...groupingLine(line as unknown as Record<string, unknown>), price: line.price?.toString() ?? null, priceZeroConfirmed: line.priceZeroConfirmed, groupId: line.groupId } as CatalogQualityRow)),
        issues: Array.isArray(group.validation) ? group.validation as unknown as GroupingIssue[] : [],
        confirmedAt: group.confirmedAt,
        optionDimensions: [...(group.lines.some((line) => normalizeCatalogGroupingValue(line.size)) ? ["Size"] : []), ...(group.lines.some((line) => normalizeCatalogGroupingValue(line.color)) ? ["Color"] : [])],
      }));
      const quality = evaluateCatalogQuality(qualityRows, activeGroups, { warnMissingImage: form.get("warnMissingImage") === "1" });
      const lineQuality = new Map(quality.rows.map((row) => [row.id, row.state]));
      const proposals = current.groups.map((group) => {
        const selections = (group.selections && typeof group.selections === "object" ? group.selections : {}) as GroupSelections;
        const rows = group.lines.map((line) => {
          const mappedValue = (field: string, value: unknown) => ({ value: value == null ? null : String(value), mapped: mapped(field) });
          const productNameSelection = selections.productName;
          const selectedProductNameLine = group.lines.find((line) => line.id === productNameSelection?.sourceLineId);
          const title = selectedProductNameLine?.productName ?? line.productName ?? "";
          const source = Array.isArray(line.sourceValues) ? line.sourceValues as unknown[] : [];
          const fieldMap: Partial<Record<CatalogCompareField, { value: string | null; mapped: boolean }>> = {
            title: mappedValue("productName", title), description: mappedValue("description", selections.description?.value ?? line.description),
            vendor: mappedValue("vendor", selections.vendor?.value ?? line.vendor), productType: mappedValue("productType", selections.productType?.value ?? line.productType),
            sku: mappedValue("sku", line.sku), price: mappedValue("price", line.price?.toString()), size: mappedValue("size", line.size), color: mappedValue("color", line.color),
          };
          // The source positional values are deliberately retained; an empty mapped cell means preserve, not clear.
          void source;
          return { id: line.id, groupId: group.id, sourceRowNumber: line.sourceRowNumber, title, sku: String(line.sku ?? ""), price: line.price?.toString() ?? null, size: line.size, color: line.color, description: line.description, vendor: line.vendor, productType: line.productType, confirmed: Boolean(group.confirmedAt), quality: lineQuality.get(line.id) ?? "ERROR", fields: fieldMap };
        });
        return rows;
      }).flat();
      const confirmedRows = proposals.filter((row) => row.confirmed && row.quality !== "ERROR");
      const snapshot = confirmedRows.length ? await readShopifyCatalogSnapshot((query, options) => admin.graphql(query, options) as Promise<Response>, session.shop) : { variants: [], fetchedAt: new Date().toISOString() };
      const changes = compareCatalogGroups(proposals, snapshot.variants);
      const fingerprint = createHash("sha256").update(JSON.stringify(snapshot.variants)).digest("hex");
      const savedReviews = await prisma.$transaction(async (tx) => {
        await lockCurrentDraft(tx, session.shop, batchId, version, "This catalog draft changed while Shopify was being read. Reload before comparing.");
        const records = [];
        for (const proposal of changes) {
          const group = current.groups.find((candidate) => candidate.id === proposal.groupId);
          if (!group) continue;
          const reviewSnapshot = snapshotForReview(proposal, group.lines, snapshot.variants);
          const storedSnapshot = { ...reviewSnapshot.snapshot, fetchedAt: snapshot.fetchedAt, proposal } as Prisma.InputJsonObject;
          const existing = await tx.catalogImportReview.findFirst({ where: { shop: session.shop, batchId, groupId: group.id, draftVersion: version } });
          let record;
          if (!existing) {
            record = await tx.catalogImportReview.create({ data: {
              id: randomUUID(), shop: session.shop, batchId, groupId: group.id, draftVersion: version,
              reviewVersion: 0, operation: proposal.disposition,
              status: proposal.disposition === "CONFLICT" ? "CONFLICT" : "PENDING",
              snapshotFingerprint: reviewSnapshot.fingerprint, snapshot: storedSnapshot,
              shopifyProductId: proposal.productId, matchedVariantIds: reviewSnapshot.matchedVariantIds as Prisma.InputJsonArray,
              decisions: {} as Prisma.InputJsonObject, snapshotCapturedAt: new Date(snapshot.fetchedAt),
            } });
          } else if (existing.snapshotFingerprint === reviewSnapshot.fingerprint && existing.status !== "STALE") {
            record = await tx.catalogImportReview.update({ where: { id: existing.id }, data: {
              snapshot: storedSnapshot, operation: proposal.disposition, shopifyProductId: proposal.productId,
              matchedVariantIds: reviewSnapshot.matchedVariantIds as Prisma.InputJsonArray,
              snapshotCapturedAt: new Date(snapshot.fetchedAt),
            } });
          } else {
            await tx.catalogImportReviewHistory.create({ data: {
              id: existing.id, shop: existing.shop, batchId: existing.batchId, groupId: existing.groupId,
              draftVersion: existing.draftVersion, reviewVersion: existing.reviewVersion, operation: existing.operation,
              status: existing.status, snapshotFingerprint: existing.snapshotFingerprint, snapshot: existing.snapshot as Prisma.InputJsonValue,
              shopifyProductId: existing.shopifyProductId, matchedVariantIds: existing.matchedVariantIds as Prisma.InputJsonValue,
              decisions: existing.decisions as Prisma.InputJsonValue, snapshotCapturedAt: existing.snapshotCapturedAt,
              reviewedAt: existing.reviewedAt, createdAt: existing.createdAt, updatedAt: existing.updatedAt,
            } });
            record = await tx.catalogImportReview.update({ where: { id: existing.id }, data: {
              reviewVersion: { increment: 1 }, operation: proposal.disposition,
              status: proposal.disposition === "CONFLICT" ? "CONFLICT" : "PENDING",
              snapshotFingerprint: reviewSnapshot.fingerprint, snapshot: storedSnapshot,
              shopifyProductId: proposal.productId, matchedVariantIds: reviewSnapshot.matchedVariantIds as Prisma.InputJsonArray,
              decisions: {} as Prisma.InputJsonObject, reviewedAt: null, snapshotCapturedAt: new Date(snapshot.fetchedAt),
            } });
          }
          records.push(record);
        }
        return records;
      });
      const reviewsByGroup = new Map(savedReviews.map((review) => [review.groupId, review]));
      const proposalsWithReview = changes.map((proposal) => {
        const review = reviewsByGroup.get(proposal.groupId);
        return review ? { ...proposal, reviewId: review.id, reviewVersion: review.reviewVersion, reviewStatus: review.status, reviewDraftVersion: review.draftVersion, snapshotFingerprint: review.snapshotFingerprint, snapshotCapturedAt: review.snapshotCapturedAt, decisions: review.decisions, stale: false } : proposal;
      });
      return { compareResult: { draftVersion: current.draftVersion, shop: session.shop, fetchedAt: snapshot.fetchedAt, fingerprint, proposals: proposalsWithReview, totalRows: current.lines.length, totalGroups: current.groups.length, unconfirmedGroups: current.groups.filter((group) => !group.confirmedAt).length } };
    }
    let confirmationSnapshotFingerprint: string | null = null;
    if (intent === "confirm-review") {
      if (batch.status !== "DRAFT") throw new Error("Only a current catalog draft can confirm a Shopify review.");
      const groupId = String(form.get("groupId") ?? "");
      const reviewVersion = Number(form.get("reviewVersion"));
      if (!groupId || !Number.isSafeInteger(reviewVersion) || reviewVersion < 0) throw new Error("Reload this catalog review and try again.");
      const candidate = await prisma.catalogImportReview.findFirst({ where: { shop: session.shop, batchId, groupId, draftVersion: version } });
      const candidateGroup = candidate ? await prisma.catalogImportGroup.findFirst({
        where: { shop: session.shop, batchId, id: groupId, state: "ACTIVE" },
        include: { lines: { orderBy: { rowNumber: "asc" } } },
      }) : null;
      if (!candidate || !candidateGroup) throw new Error("Catalog review not found for this shop and draft. Compare again before reviewing.");
      if (candidate.reviewVersion !== reviewVersion) throw new Error("This catalog review changed in another tab. Reload before confirming.");
      if (candidate.status === "CONFIRMED") throw new Error("This review is already confirmed. Compare again to start a new review.");
      if (candidate.operation === "CONFLICT" || candidate.operation === "SKIP") throw new Error("Resolve the Shopify match conflict and compare again before confirmation.");
      let decisions: CatalogReviewDecisions;
      try { decisions = parseReviewDecisions(JSON.stringify(candidate.decisions), candidateGroup.lines.map((line) => line.id)); }
      catch { throw new Error("Save explicit field and group decisions before confirming this review."); }
      if (decisions.group !== "CONFIRM") throw new Error("Choose Confirm for the product group before confirming this review.");
      if (!candidateGroup.confirmedAt) throw new Error("Accept this product group before confirming its Shopify review.");
      const selections = (candidateGroup.selections && typeof candidateGroup.selections === "object" ? candidateGroup.selections : {}) as GroupSelections;
      validateProposedReviewChoices(decisions, candidateGroup.lines as unknown as Array<Record<string, unknown>>, selections, batch.mapping);
      if (candidate.operation === "CREATE") {
        validateCreateReviewInputs(decisions, candidateGroup.lines as unknown as Array<Record<string, unknown>>, batch.mapping, candidate.snapshot);
      }
      let grantedScopes: string[];
      try { grantedScopes = await queryGrantedScopes(scopes); }
      catch { throw new Error("StockHub could not verify the current Shopify read permission. No confirmation was recorded; compare again and retry."); }
      if (missingScopesForGrant(grantedScopes, ["read_products"]).length) throw new Error("Shopify has not granted read_products. No confirmation was recorded.");
      const proposal = savedProposalForReview(candidate.snapshot, groupId, candidate.operation, candidateGroup.lines.map((line) => line.id));
      const freshSnapshot = await readShopifyCatalogSnapshot((query, options) => admin.graphql(query, options) as Promise<Response>, session.shop);
      confirmationSnapshotFingerprint = snapshotForReview(proposal, candidateGroup.lines, freshSnapshot.variants).fingerprint;
      if (confirmationSnapshotFingerprint !== candidate.snapshotFingerprint) {
        await prisma.$transaction(async (tx) => {
          await lockCurrentDraft(tx, session.shop, batchId, version, "This catalog draft changed while Shopify was being checked. Reload and compare again before confirming.");
          const currentReview = await tx.catalogImportReview.findFirst({ where: { shop: session.shop, batchId, groupId, draftVersion: version } });
          if (!currentReview || currentReview.id !== candidate.id || currentReview.reviewVersion !== reviewVersion || currentReview.snapshotFingerprint !== candidate.snapshotFingerprint || currentReview.status !== candidate.status) {
            throw new Error("This catalog review changed while Shopify was being checked. Reload and compare again.");
          }
          await archiveCatalogReviewVersion(tx, currentReview);
          const invalidated = await tx.catalogImportReview.updateMany({
            where: { id: candidate.id, shop: session.shop, batchId, groupId, draftVersion: version, reviewVersion, snapshotFingerprint: candidate.snapshotFingerprint, status: candidate.status },
            data: { status: "STALE", reviewVersion: { increment: 1 }, reviewedAt: null },
          });
          if (invalidated.count !== 1) throw new Error("This catalog review changed while Shopify was being checked. Reload and compare again.");
        });
        return { error: "Shopify changed since this comparison. Your saved decisions are preserved, but this review is now stale. Compare again and save fresh decisions before confirming." };
      }
    }
    if (intent === "save-review" || intent === "confirm-review") {
      const groupId = String(form.get("groupId") ?? "");
      const reviewVersion = Number(form.get("reviewVersion"));
      if (!groupId || !Number.isSafeInteger(reviewVersion) || reviewVersion < 0) throw new Error("Reload this catalog review and try again.");
      await prisma.$transaction(async (tx) => {
        await lockCurrentDraft(tx, session.shop, batchId, version);
        const group = await tx.catalogImportGroup.findFirst({
          where: { shop: session.shop, batchId, id: groupId, state: "ACTIVE" },
          include: { lines: { orderBy: { rowNumber: "asc" } } },
        });
        const review = await tx.catalogImportReview.findFirst({ where: { shop: session.shop, batchId, groupId, draftVersion: version } });
        if (!group || !review) throw new Error("Catalog review not found for this shop and draft. Compare again before reviewing.");
        if (review.reviewVersion !== reviewVersion) throw new Error("This catalog review changed in another tab. Reload before saving.");
        if (review.status === "CONFIRMED") throw new Error("This review is already confirmed. Compare again to start a new review.");
        if (intent === "save-review" && review.status === "STALE") throw new Error("This Shopify comparison is stale. Compare again before saving review decisions.");
        if (intent === "confirm-review" && (!confirmationSnapshotFingerprint || review.snapshotFingerprint !== confirmationSnapshotFingerprint)) {
          throw new Error("This Shopify comparison changed while confirmation was being prepared. Compare again before confirming.");
        }
        if (intent === "save-review") {
          const decisions = parseReviewDecisions(form.get("decisions"), group.lines.map((line) => line.id));
          const selections = (group.selections && typeof group.selections === "object" ? group.selections : {}) as GroupSelections;
          validateProposedReviewChoices(decisions, group.lines as unknown as Array<Record<string, unknown>>, selections, batch.mapping);
          const status = review.operation === "CONFLICT" ? "CONFLICT" : decisions.group === "SKIP" ? "SKIPPED" : "PENDING";
          const saved = await tx.catalogImportReview.updateMany({
            where: { id: review.id, shop: session.shop, batchId, groupId, draftVersion: version, reviewVersion, status: { not: "CONFIRMED" } },
            data: { decisions: decisions as unknown as Prisma.InputJsonObject, status, reviewVersion: { increment: 1 }, reviewedAt: null },
          });
          if (saved.count !== 1) throw new Error("This catalog review changed in another tab. Reload before saving.");
          return;
        }
        let decisions: CatalogReviewDecisions;
        try { decisions = parseReviewDecisions(JSON.stringify(review.decisions), group.lines.map((line) => line.id)); }
        catch { throw new Error("Save explicit field and group decisions before confirming this review."); }
        if (decisions.group !== "CONFIRM") throw new Error("Choose Confirm for the product group before confirming this review.");
        if (review.operation === "CONFLICT" || review.operation === "SKIP") throw new Error("Resolve the Shopify match conflict and compare again before confirmation.");
        const selections = (group.selections && typeof group.selections === "object" ? group.selections : {}) as GroupSelections;
        validateProposedReviewChoices(decisions, group.lines as unknown as Array<Record<string, unknown>>, selections, batch.mapping);
        if (review.operation === "CREATE") {
          validateCreateReviewInputs(decisions, group.lines as unknown as Array<Record<string, unknown>>, batch.mapping, review.snapshot);
        }
        if (!group.confirmedAt) throw new Error("Accept this product group before confirming its Shopify review.");
        const groupLines = group.lines.map((line) => groupingLine(line as unknown as Record<string, unknown>));
        const allRows = await tx.catalogImportLine.findMany({ where: { shop: session.shop, batchId }, orderBy: { rowNumber: "asc" } });
        const issues = validateGroup(groupLines, selections, group.source, allRows.map((line) => groupingLine(line as unknown as Record<string, unknown>)));
        const quality = evaluateCatalogQuality(
          group.lines.map((line) => ({ ...groupingLine(line as unknown as Record<string, unknown>), price: line.price?.toString() ?? null, priceZeroConfirmed: line.priceZeroConfirmed, groupId: line.groupId } as CatalogQualityRow)),
          [{
            id: group.id,
            lines: group.lines.map((line) => ({ ...groupingLine(line as unknown as Record<string, unknown>), price: line.price?.toString() ?? null, priceZeroConfirmed: line.priceZeroConfirmed, groupId: line.groupId } as CatalogQualityRow)),
            issues, confirmedAt: group.confirmedAt,
            optionDimensions: [...(group.lines.some((line) => normalizeCatalogGroupingValue(line.size)) ? ["Size"] : []), ...(group.lines.some((line) => normalizeCatalogGroupingValue(line.color)) ? ["Color"] : [])],
          }],
          { warnMissingImage: false },
        );
        if (issues.length || quality.rows.some((row) => row.state === "ERROR")) throw new Error("Resolve all group, quality, and conflict issues before confirming this review.");
        for (const [lineId, decision] of Object.entries(decisions.variants)) {
          if (decision.operation !== "SKIP" && decision.operation !== review.operation) {
            throw new Error(`The operation for row ${lineId} no longer matches this comparison. Compare again before confirming.`);
          }
        }
        const confirmed = await tx.catalogImportReview.updateMany({
          where: { id: review.id, shop: session.shop, batchId, groupId, draftVersion: version, reviewVersion, status: "PENDING" },
          data: { status: "CONFIRMED", reviewVersion: { increment: 1 }, reviewedAt: new Date() },
        });
        if (confirmed.count !== 1) throw new Error("This catalog review changed in another tab. Reload before confirming.");
      });
      return redirect(`/app/imports/catalog/${encodeURIComponent(batchId)}`);
    }
    if (intent === "delete-batch") {
      await prisma.$transaction(async (tx) => {
        const locked = await tx.catalogImportBatch.updateMany({ where: { shop: session.shop, id: batchId, draftVersion: version }, data: { draftVersion: { increment: 0 } } });
        if (locked.count !== 1) throw new Error("This draft changed in another tab. Reload before deleting.");
        const reviewCount = await tx.catalogImportReview.count({ where: { shop: session.shop, batchId } });
        const reviewHistoryCount = await tx.catalogImportReviewHistory.count({ where: { shop: session.shop, batchId } });
        if (reviewCount || reviewHistoryCount) throw new Error("This catalog draft has retained Shopify review history and cannot be deleted.");
        const executionCount = await tx.catalogExecutionOperation.count({ where: { shop: session.shop, batchId } });
        if (executionCount) throw new Error("This catalog draft has retained execution history and cannot be deleted.");
        const deleted = await tx.catalogImportBatch.deleteMany({ where: { shop: session.shop, id: batchId, draftVersion: version } });
        if (deleted.count !== 1) throw new Error("This draft changed in another tab. Reload before deleting.");
      });
      return redirect("/app/imports/catalog");
    }
    if (intent === "preview-mapping" || intent === "save-mapping") {
      if (batch.status !== "MAPPING") throw new Error("Column mapping is already complete.");
      const headers = Array.isArray(batch.sourceHeaders) ? batch.sourceHeaders.map(String) : [];
      const parsed = parseCatalogCsv(batch.originalCsv);
      const rawMapping = JSON.parse(String(form.get("mapping") ?? "{}")) as unknown;
      const mapping = validateCatalogMapping(headers, rawMapping);
      const normalizedRows = normalizeCatalogRows(parsed, mapping);
      if (intent === "preview-mapping") {
        return { mappingPreview: { mapping, rows: normalizedRows } };
      }
      await prisma.$transaction(async (tx) => {
        const locked = await tx.catalogImportBatch.updateMany({ where: { shop: session.shop, id: batchId, draftVersion: version, status: "MAPPING" }, data: { mapping: mapping as object, status: "DRAFT", draftVersion: { increment: 1 } } });
        if (locked.count !== 1) throw new Error("This draft changed in another tab. Reload before saving.");
        await tx.catalogImportLine.createMany({ data: normalizedRows.map((row) => ({
          id: randomUUID(), shop: session.shop, batchId, rowNumber: row.rowNumber, sourceRowNumber: row.rowNumber,
          sourceValues: row.sourceValues, productName: row.normalized.productName?.trim() || null, sku: row.normalized.sku?.trim() || null,
          price: row.price, description: row.normalized.description || null, productGroupCode: row.normalized.productGroupCode || null,
          size: row.normalized.size || null, color: row.normalized.color || null, vendor: row.normalized.vendor || null,
          productType: row.normalized.productType || null, imageUrl: row.normalized.imageUrl || null,
          status: row.status, errors: row.errors,
        })) });
        await suggestUnassignedGroups(tx, session.shop, batchId);
      });
      return redirect(`/app/imports/catalog/${encodeURIComponent(batchId)}`);
    }
    if (batch.status !== "DRAFT") throw new Error("Only a mapped draft can be edited.");
    const lineId = String(form.get("lineId") ?? "");
      await prisma.$transaction(async (tx) => {
        const advanced = await tx.catalogImportBatch.updateMany({ where: { shop: session.shop, id: batchId, draftVersion: version, status: "DRAFT" }, data: { draftVersion: { increment: 1 } } });
        if (advanced.count !== 1) throw new Error("This draft changed in another tab. Reload before saving.");
        const inFlightExecution = await tx.catalogExecutionOperation.findFirst({ where: { shop: session.shop, batchId, status: { in: ["RUNNING", "RECONCILING", "UNKNOWN"] } }, select: { id: true, status: true } });
        if (inFlightExecution) throw new Error("A catalog execution has an unresolved Shopify outcome. Reconcile it before editing this draft.");
        if (intent === "suggest-groups") {
        const activeCount = await tx.catalogImportGroup.count({ where: { shop: session.shop, batchId, state: "ACTIVE" } });
        if (activeCount) throw new Error("Grouping suggestions already exist for this draft.");
        await suggestUnassignedGroups(tx, session.shop, batchId);
        return;
      }
      if (["accept-group", "resolve-field", "merge-groups", "split-selected"].includes(intent)) {
        await handleGroupingAction(tx, session.shop, batchId, version, form, intent);
        return;
      }
      const existingLine = intent === "add" ? null : await tx.catalogImportLine.findFirst({ where: { shop: session.shop, batchId, id: lineId } });
      if (intent === "delete") {
        const deleted = await tx.catalogImportLine.deleteMany({ where: { shop: session.shop, batchId, id: lineId } });
        if (deleted.count !== 1) throw new Error("Catalog row not found.");
        if (existingLine?.groupId) {
          const remaining = await tx.catalogImportLine.count({ where: { shop: session.shop, batchId, groupId: existingLine.groupId } });
          if (!remaining) await tx.catalogImportGroup.updateMany({ where: { shop: session.shop, batchId, id: existingLine.groupId, state: "ACTIVE" }, data: { state: "SUPERSEDED", confirmedAt: null } });
          else await refreshGroupValidation(tx, session.shop, batchId, existingLine.groupId);
        }
        return;
      }
      const input = readCanonical(form);
      const errors = input.errors;
      const priceValue = input.priceValid ? input.price || null : undefined;
      const data = {
        productName: input.productName || null, sku: input.sku || null, price: priceValue,
        priceZeroConfirmed: input.priceZeroConfirmed, description: input.description || null,
        productGroupCode: input.productGroupCode || null, size: input.size || null, color: input.color || null,
        vendor: input.vendor || null, productType: input.productType || null, imageUrl: input.imageUrl || null,
        errors, status: errors.length ? "ERROR" : "READY",
      };
      if (intent === "add") {
        const max = await tx.catalogImportLine.aggregate({ where: { shop: session.shop, batchId }, _max: { rowNumber: true } });
        await tx.catalogImportLine.create({ data: { id: randomUUID(), shop: session.shop, batchId, rowNumber: (max._max.rowNumber ?? 0) + 1, sourceRowNumber: null, sourceValues: [], ...data } });
        await suggestUnassignedGroups(tx, session.shop, batchId);
      } else if (intent === "edit") {
        const updated = await tx.catalogImportLine.updateMany({ where: { shop: session.shop, batchId, id: lineId }, data });
        if (updated.count !== 1) throw new Error("Catalog row not found.");
        if (existingLine?.groupId) await refreshGroupValidation(tx, session.shop, batchId, existingLine.groupId);
      } else throw new Error("Unknown catalog draft action.");
    });
    return redirect(`/app/imports/catalog/${encodeURIComponent(batchId)}`);
  } catch (error) {
    if (executionIntent && error instanceof Error && error.name !== "Error") {
      return { error: "Catalog execution could not be completed safely. Reload its status and reconcile before taking further action." };
    }
    return { error: error instanceof Error ? error.message : "Unable to save this catalog draft." };
  }
};

export default function CatalogImportDetail() {
  const { batch, groups, reviewHistory, headers, samples, fields, labels: fieldLabels, quality, warnMissingImage, prepared } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [editingMapping, setEditingMapping] = useState(false);
  const [qualitySearch, setQualitySearch] = useState("");
  const [qualityFilter, setQualityFilter] = useState("ALL");
  const [unsavedReviewIds, setUnsavedReviewIds] = useState<Record<string, boolean>>({});
  const compareResult = actionData && "compareResult" in actionData ? actionData.compareResult : null;
  useEffect(() => { if (compareResult) setUnsavedReviewIds({}); }, [compareResult]);
  const mappingPreview = actionData && "mappingPreview" in actionData ? actionData.mappingPreview : null;
  const executionResult = actionData && "executionResult" in actionData ? actionData.executionResult : null;
  const previewMapping = mappingPreview?.mapping;
  const mappingDefaults = Object.fromEntries(headers.map((header, index) => [String(index), previewMapping?.[index] ?? suggestCatalogField(header) ?? ""]));
  const qualityByRow = new Map(quality.rows.map((row) => [row.id, row]));
  const qualityByGroup = new Map(quality.groups.map((group) => [group.id, group]));
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const persistedReviewProposals: CatalogReviewDisplayProposal[] = reviewHistory.filter((record) => record.proposal).map((record) => ({
    ...record.proposal!, reviewId: record.id, reviewVersion: record.reviewVersion, reviewStatus: record.effectiveStatus,
    reviewDraftVersion: record.draftVersion, snapshotFingerprint: record.snapshotFingerprint,
    snapshotCapturedAt: record.snapshotCapturedAt, decisions: record.decisions, stale: record.stale,
  } as CatalogReviewDisplayProposal));
  const displayedReviews: CatalogReviewDisplayProposal[] = compareResult
    ? compareResult.proposals.filter((proposal) => "reviewId" in proposal).map((proposal) => proposal as CatalogReviewDisplayProposal)
    : persistedReviewProposals;
  const visibleLines = batch.lines.filter((line) => {
    const evaluated = qualityByRow.get(line.id);
    const state = evaluated?.state ?? "READY";
    const search = qualitySearch.trim().toLocaleLowerCase();
    const matchesSearch = !search || [line.productName, line.sku, line.size, line.color, line.vendor, line.productType].some((value) => String(value ?? "").toLocaleLowerCase().includes(search));
    return matchesSearch && (qualityFilter === "ALL" || state === qualityFilter);
  });
  const visibleGroups = groups.filter((group) => {
    const search = qualitySearch.trim().toLocaleLowerCase();
    const matchesSearch = !search || [group.groupingKey, group.reason, ...group.lines.flatMap((line) => [line.productName, line.sku, line.size, line.color])].some((value) => String(value ?? "").toLocaleLowerCase().includes(search));
    const state = qualityByGroup.get(group.id)?.state ?? "READY";
    return matchesSearch && (qualityFilter === "ALL" || state === qualityFilter);
  });
  const createMapping = (event: React.FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const data = new FormData(form);
    const values = Object.fromEntries(headers.map((_, index) => [String(index), data.get(`column-${index}`) || null]));
    const input = form.querySelector<HTMLInputElement>('input[name="mapping"]');
    if (input) input.value = JSON.stringify(values);
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value === "preview-mapping") setEditingMapping(false);
  };
  const prepareReviewDecisions = (event: React.FormEvent<HTMLFormElement>, proposal: CatalogReviewDisplayProposal) => {
    const form = event.currentTarget;
    const productFields = Object.fromEntries(PRODUCT_REVIEW_FIELDS.map((field) => [field, "KEEP_SHOPIFY"])) as Record<(typeof PRODUCT_REVIEW_FIELDS)[number], ReviewFieldChoice>;
    const reviewScope = `${proposal.reviewId ?? "review"}-${proposal.reviewVersion ?? "unknown"}`;
    const variants = Object.fromEntries(proposal.rowIds.map((id) => [id, {
      operation: proposal.disposition === "CREATE" || proposal.disposition === "UPDATE" ? proposal.disposition : "SKIP",
      fields: Object.fromEntries(VARIANT_REVIEW_FIELDS.map((field) => [field, "KEEP_SHOPIFY"])) as Record<(typeof VARIANT_REVIEW_FIELDS)[number], ReviewFieldChoice>,
    }])) as CatalogReviewDecisions["variants"];
    const groupChoice = form.querySelector<HTMLSelectElement>("[data-review-group-choice]")?.value;
    for (const input of document.querySelectorAll<HTMLSelectElement>(`[data-review-scope="${reviewScope}"][data-review-product-field]`)) {
      const field = input.dataset.reviewProductField as (typeof PRODUCT_REVIEW_FIELDS)[number];
      if (PRODUCT_REVIEW_FIELDS.includes(field)) productFields[field] = input.value as ReviewFieldChoice;
    }
    for (const input of document.querySelectorAll<HTMLSelectElement>(`[data-review-scope="${reviewScope}"][data-review-variant-id]`)) {
      const id = input.dataset.reviewVariantId ?? "";
      const field = input.dataset.reviewVariantField as (typeof VARIANT_REVIEW_FIELDS)[number];
      if (variants[id] && VARIANT_REVIEW_FIELDS.includes(field)) variants[id]!.fields[field] = input.value as ReviewFieldChoice;
    }
    for (const input of document.querySelectorAll<HTMLSelectElement>(`[data-review-scope="${reviewScope}"][data-review-operation-id]`)) {
      const id = input.dataset.reviewOperationId ?? "";
      if (variants[id]) variants[id]!.operation = input.value as "CREATE" | "UPDATE" | "SKIP";
    }
    const decisions = { schemaVersion: 1 as const, group: groupChoice === "SKIP" ? "SKIP" as const : "CONFIRM" as const, productFields, variants };
    const hidden = form.querySelector<HTMLInputElement>('input[name="decisions"]');
    if (hidden) hidden.value = JSON.stringify(decisions);
  };
  return <main className="stockhub-import-new stockhub-catalog-imports">
    <header className="stockhub-import-page-header"><div><div className="stockhub-overview-eyebrow">Product Catalog · Draft</div><h1>{batch.fileName}</h1><p>Draft only; catalog data is not sent to Shopify. Version {batch.draftVersion} · SHA-256 {batch.fileChecksum}</p></div><div><Link to="/app/imports/catalog">All catalog drafts</Link><Form method="post" onSubmit={(event) => { if (!confirm("Delete this catalog draft and its retained source CSV?")) event.preventDefault(); }}><input type="hidden" name="intent" value="delete-batch" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><button type="submit">Delete draft</button></Form></div></header>
    {prepared === "inventory" ? <p role="status">Inventory import values were copied into this product draft. Review and complete the draft; this does not create a Shopify product.</p> : null}
    {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
    {batch.status === "DRAFT" ? <section className="stockhub-panel stockhub-catalog-quality" aria-labelledby="catalog-quality-heading">
      <h2 id="catalog-quality-heading">Product data quality</h2>
      <p>Quality is recalculated from the current draft. Group acceptance is a separate review decision and does not change these statuses.</p>
      <div className="stockhub-catalog-quality-counts" aria-label="Catalog quality summary">
        <div><strong>{quality.counts.ready}</strong><span>Ready rows</span></div><div><strong>{quality.counts.warning}</strong><span>Warning rows</span></div><div><strong>{quality.counts.error}</strong><span>Error rows</span></div>
      </div>
      <p className="stockhub-catalog-quality-totals"><strong>{quality.counts.totalRows}</strong> total rows · <strong>{quality.counts.totalGroups}</strong> product groups · <strong>{quality.counts.totalIssues}</strong> quality issues</p>
      <Form method="get" className="stockhub-catalog-quality-options"><label><input type="checkbox" name="warnMissingImage" value="1" defaultChecked={warnMissingImage} onChange={(event) => event.currentTarget.form?.requestSubmit()} /> Warn when an optional image URL is missing</label></Form>
      <div className="stockhub-catalog-quality-filters"><label>Search draft rows and groups<input type="search" value={qualitySearch} onChange={(event) => setQualitySearch(event.currentTarget.value)} /></label><label>Quality status<select value={qualityFilter} onChange={(event) => setQualityFilter(event.currentTarget.value)}><option value="ALL">All statuses</option><option value="READY">Ready</option><option value="WARNING">Warning</option><option value="ERROR">Error</option></select></label></div>
    </section> : null}
    {batch.status === "DRAFT" ? <section className="stockhub-panel stockhub-catalog-compare" aria-labelledby="catalog-compare-heading">
      <h2 id="catalog-compare-heading">Shopify change review</h2>
      <p>Read-only comparison against the authenticated shop catalog. Preview is tied to draft version and snapshot fingerprint; any draft edit invalidates it. This does not write products, variants, prices, or inventory.</p>
      <p>Unmapped fields and mapped empty cells preserve Shopify’s current values. Non-empty mapped values appear as proposed replacements; clearing a field is not supported here.</p>
      <Form method="post"><input type="hidden" name="intent" value="compare-shopify" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="warnMissingImage" value={warnMissingImage ? "1" : "0"} /><button type="submit">Compare confirmed groups with Shopify</button></Form>
      {executionResult ? <p role="status"><strong>{executionResult.status}:</strong> {executionResult.message}{executionResult.productId ? <> · Product <code>{executionResult.productId}</code></> : null}</p> : null}
      {displayedReviews.length ? <div className="stockhub-catalog-compare-result" aria-live="polite">
        {compareResult ? <>
          <p>Draft version {compareResult.draftVersion} · Snapshot {new Date(compareResult.fetchedAt).toLocaleString()} · SHA-256 <code>{compareResult.fingerprint}</code></p>
          <p>{compareResult.proposals.filter((proposal) => proposal.disposition === "CREATE").length} Create candidates · {compareResult.proposals.filter((proposal) => proposal.disposition === "UPDATE").length} Update candidates · {compareResult.proposals.filter((proposal) => proposal.disposition === "SKIP").length} Skipped · {compareResult.proposals.filter((proposal) => proposal.disposition === "CONFLICT").length} Conflicts</p>
        </> : <p>Persisted comparison history · current draft version {batch.draftVersion}</p>}
        {!displayedReviews.length ? <p>No active product groups are available to compare.</p> : null}
        {displayedReviews.map((proposal) => {
          const storedDecisions = isRecord(proposal.decisions) ? proposal.decisions : {};
          const storedProductFields = isRecord(storedDecisions.productFields) ? storedDecisions.productFields : {};
          const storedVariants = isRecord(storedDecisions.variants) ? storedDecisions.variants : {};
          const storedGroupDecision = storedDecisions.group === "SKIP" ? "SKIP" : "CONFIRM";
          const saved = storedDecisions.schemaVersion === 1;
          const stale = Boolean(proposal.stale) || proposal.reviewStatus === "STALE" || proposal.reviewDraftVersion !== batch.draftVersion;
          const reviewStatus = stale ? "STALE" : String(proposal.reviewStatus ?? (proposal.disposition === "CONFLICT" ? "CONFLICT" : "PENDING"));
          const activeGroup = groupsById.get(proposal.groupId);
          const reviewScope = `${proposal.reviewId ?? "review"}-${proposal.reviewVersion ?? "unknown"}`;
          const execution = activeGroup?.executionOperations.find((candidate) => candidate.reviewId === proposal.reviewId && candidate.reviewVersion === proposal.reviewVersion);
          const qualityError = proposal.quality === "ERROR" || activeGroup?.issues.some((issue) => issue.code.includes("ERROR"));
          const canSave = !stale && reviewStatus !== "CONFIRMED" && Boolean(proposal.reviewId);
          const canConfirm = canSave && reviewStatus === "PENDING" && saved && storedGroupDecision === "CONFIRM" && Boolean(activeGroup?.confirmedAt) && Boolean(activeGroup?.canAccept) && !qualityError && proposal.disposition !== "CONFLICT" && proposal.disposition !== "SKIP";
          const savedVariant = (lineId: string) => isRecord(storedVariants[lineId]) ? storedVariants[lineId] as Record<string, unknown> : {};
          const savedVariantFields = (lineId: string) => isRecord(savedVariant(lineId).fields) ? savedVariant(lineId).fields as Record<string, unknown> : {};
          const choiceForSelect = (choice: unknown) => ["KEEP_SHOPIFY", "USE_CSV", "SKIP"].includes(String(choice)) ? String(choice) : "KEEP_SHOPIFY";
          const defaultOperation = proposal.disposition === "CREATE" || proposal.disposition === "UPDATE" ? proposal.disposition : "SKIP";
          const reviewFormId = proposal.reviewId ? `catalog-review-${reviewScope}` : undefined;
          const mappedReviewFields = new Set(Object.values(isRecord(batch.mapping) ? batch.mapping : {}).filter((field): field is string => typeof field === "string"));
          const productSourceField = { title: "productName", description: "description", vendor: "vendor", productType: "productType" } as const;
          const canUseProductCsv = (field: (typeof PRODUCT_REVIEW_FIELDS)[number]) => {
            if (!activeGroup) return false;
            const sourceField = productSourceField[field];
            const selections = isRecord(activeGroup.selections) ? activeGroup.selections : {};
            const selection = isRecord(selections[sourceField]) ? selections[sourceField] : {};
            const selectedLine = typeof selection.sourceLineId === "string" ? activeGroup.lines.find((line) => line.id === selection.sourceLineId) : undefined;
            const value = selection.value ?? selectedLine?.[sourceField] ?? activeGroup.lines.find((line) => typeof line[sourceField] === "string" && String(line[sourceField]).trim())?.[sourceField];
            return mappedReviewFields.has(sourceField) && typeof value === "string" && Boolean(value.trim());
          };
          const canUseVariantCsv = (lineId: string, field: (typeof VARIANT_REVIEW_FIELDS)[number]) => {
            if (proposal.disposition === "UPDATE" && (field === "size" || field === "color")) return false;
            const line = activeGroup?.lines.find((candidate) => candidate.id === lineId);
            const value = line?.[field];
            return mappedReviewFields.has(field) && value != null && Boolean(String(value).trim());
          };
          return <article key={`${proposal.groupId}-${proposal.reviewId ?? "review"}-${proposal.reviewVersion ?? "version"}`} className={`stockhub-catalog-compare-card status-${proposal.disposition.toLowerCase()}`}>
            <header><h3>{proposal.groupTitle}</h3><strong>{proposal.disposition} · Quality: {proposal.quality ?? "—"}</strong></header>
            <p>{proposal.reason}</p>
            <p>Review status: <strong>{unsavedReviewIds[reviewScope] ? "Unsaved changes" : reviewStatus === "CONFIRMED" ? "Confirmed" : reviewStatus === "STALE" ? "Stale" : reviewStatus === "CONFLICT" || proposal.disposition === "CONFLICT" ? "Conflict · needs resolution" : saved ? storedGroupDecision === "SKIP" ? "Saved · skipped" : "Saved · pending confirmation" : "No decisions saved"}</strong>
              {Number.isSafeInteger(proposal.reviewVersion) ? ` · Review version ${proposal.reviewVersion}` : ""}{Number.isSafeInteger(proposal.reviewDraftVersion) ? ` · Draft version ${proposal.reviewDraftVersion}` : ""}
              {proposal.snapshotCapturedAt ? ` · Snapshot ${new Date(proposal.snapshotCapturedAt).toLocaleString()}` : ""}{proposal.snapshotFingerprint ? <> · SHA-256 <code>{proposal.snapshotFingerprint}</code></> : null}
            </p>
            {proposal.productId ? <p>Shopify product <code>{proposal.productId}</code>{proposal.variantId ? ` · variant ${proposal.variantId}` : ""}</p> : null}
            {proposal.disposition === "UPDATE" ? <p>Size and Color are Shopify variant options. Updating these options on existing products is not supported; choose Keep Shopify. A direct Use CSV request is blocked as a conflict.</p> : null}
            {execution ? <div className="stockhub-catalog-execution-status" role="status">
              <p>Catalog execution: <strong>{execution.status}</strong> · Operation <code>{execution.id}</code>{execution.productId ? <> · Product <code>{execution.productId}</code></> : null}</p>
              <p>{execution.items.filter((item) => item.status === "SUCCEEDED").length} item(s) succeeded · {execution.items.filter((item) => ["FAILED", "UNKNOWN", "CONFLICT"].includes(item.status)).length} item(s) need attention · {execution.attempts.length} recorded API attempt(s)</p>
              {execution.errorDetail ? <p>{execution.errorDetail}</p> : null}
            </div> : null}
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard focus enables horizontal scrolling on narrow screens */}
            <div className="stockhub-catalog-compare-table-wrap" role="region" aria-label={`Field decisions for ${proposal.groupTitle}`} tabIndex={0} onChange={() => proposal.reviewId && setUnsavedReviewIds((current) => ({ ...current, [reviewScope]: true }))}>
              <table><thead><tr><th>Draft row</th><th>Field</th><th>Current Shopify value</th><th>Proposed CSV value</th><th>Comparison</th><th>Decision</th></tr></thead><tbody>
                {PRODUCT_REVIEW_FIELDS.map((field) => {
                  const change = proposal.changes.find((candidate) => candidate.field === field);
                  return <tr key={`product-${field}`}><td>Product</td><th scope="row">{field}</th><td>{change?.current ?? "(no current value)"}</td><td>{change?.proposed ?? "No non-empty mapped proposal"}</td><td>{change?.action ?? "PRESERVE"}</td><td><label>{field} decision<select form={reviewFormId} data-review-scope={reviewScope} data-review-product-field={field} defaultValue={choiceForSelect(storedProductFields[field])} disabled={!canSave}><option value="KEEP_SHOPIFY">Keep Shopify</option><option value="USE_CSV" disabled={!canUseProductCsv(field)}>Use CSV</option><option value="SKIP">Skip field</option></select></label></td></tr>;
                })}
                {proposal.rowIds.map((lineId) => {
                  const sourceLine = activeGroup?.lines.find((line) => line.id === lineId);
                  const lineNumber = sourceLine?.sourceRowNumber ?? proposal.changes.find((change) => change.rowId === lineId)?.rowNumber ?? "Manual";
                  return <Fragment key={`variant-${lineId}`}>
                    {VARIANT_REVIEW_FIELDS.map((field) => {
                      const change = proposal.changes.find((candidate) => candidate.rowId === lineId && candidate.field === field);
                      return <tr key={`${lineId}-${field}`}><td>Row {lineNumber} · {sourceLine?.sku ?? "Variant"}</td><th scope="row">{field}</th><td>{change?.current ?? "(no current value)"}</td><td>{change?.proposed ?? "No non-empty mapped proposal"}</td><td>{change?.action ?? "PRESERVE"}</td><td><label>{field} decision<select form={reviewFormId} data-review-scope={reviewScope} data-review-variant-id={lineId} data-review-variant-field={field} defaultValue={choiceForSelect(savedVariantFields(lineId)[field])} disabled={!canSave}><option value="KEEP_SHOPIFY">Keep Shopify</option><option value="USE_CSV" disabled={!canUseVariantCsv(lineId, field)}>Use CSV</option><option value="SKIP">Skip field</option></select></label></td></tr>;
                    })}
                    <tr key={`${lineId}-operation`}><td>Row {lineNumber}</td><th scope="row">Operation</th><td colSpan={3}>{proposal.disposition} comparison</td><td><label>Variant operation<select form={reviewFormId} data-review-scope={reviewScope} data-review-operation-id={lineId} defaultValue={String(savedVariant(lineId).operation ?? defaultOperation)} disabled={!canSave}><option value="CREATE">Create</option><option value="UPDATE">Update</option><option value="SKIP">Skip</option></select></label></td></tr>
                  </Fragment>;
                })}
              </tbody></table>
            </div>
            {proposal.disposition === "CREATE" ? <p>No matching Shopify SKU was found. Creation is a proposal only; a future execution must recheck Shopify.</p> : null}
            {proposal.reviewId && !stale && reviewStatus !== "CONFIRMED" ? <>
              <Form id={reviewFormId} method="post" onSubmit={(event) => prepareReviewDecisions(event, proposal)}>
                <input type="hidden" name="intent" value="save-review" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="groupId" value={proposal.groupId} /><input type="hidden" name="reviewVersion" value={proposal.reviewVersion} /><input type="hidden" name="decisions" value="{}" />
                <label>Group review decision<select data-review-group-choice onChange={() => setUnsavedReviewIds((current) => ({ ...current, [reviewScope]: true }))} defaultValue={saved ? storedGroupDecision : proposal.disposition === "CREATE" || proposal.disposition === "UPDATE" ? "CONFIRM" : "SKIP"} disabled={!canSave}><option value="CONFIRM">Keep reviewing this proposal</option><option value="SKIP">Skip this group</option></select></label>
                <button type="submit" disabled={!canSave}>Save review choices</button>
              </Form>
              <Form method="post"><input type="hidden" name="intent" value="confirm-review" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="groupId" value={proposal.groupId} /><input type="hidden" name="reviewVersion" value={proposal.reviewVersion} /><button type="submit" disabled={!canConfirm}>Confirm saved review</button></Form>
            </> : null}
            {proposal.reviewId && reviewStatus === "CONFIRMED" && activeGroup?.confirmedAt && activeGroup.canAccept && !qualityError && !stale ? <>
              {!execution ? <Form method="post"><input type="hidden" name="intent" value="execute-catalog" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="groupId" value={proposal.groupId} /><input type="hidden" name="reviewVersion" value={proposal.reviewVersion} /><input type="hidden" name="snapshotFingerprint" value={proposal.snapshotFingerprint} /><button type="submit">Execute approved catalog changes</button></Form> : null}
              {execution?.status === "FAILED" ? <Form method="post"><input type="hidden" name="intent" value="retry-catalog" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="groupId" value={proposal.groupId} /><input type="hidden" name="reviewVersion" value={proposal.reviewVersion} /><input type="hidden" name="snapshotFingerprint" value={proposal.snapshotFingerprint} /><button type="submit">Retry rejected operation</button></Form> : null}
              {execution?.status === "RUNNING" || execution?.status === "RECONCILING" ? <Form method="post"><input type="hidden" name="intent" value="reconcile-catalog" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="groupId" value={proposal.groupId} /><input type="hidden" name="reviewVersion" value={proposal.reviewVersion} /><input type="hidden" name="snapshotFingerprint" value={proposal.snapshotFingerprint} /><button type="submit">Check operation status</button></Form> : null}
              {execution?.status === "UNKNOWN" ? <>
                <Form method="post"><input type="hidden" name="intent" value="reconcile-catalog" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="groupId" value={proposal.groupId} /><input type="hidden" name="reviewVersion" value={proposal.reviewVersion} /><input type="hidden" name="snapshotFingerprint" value={proposal.snapshotFingerprint} /><button type="submit">Reconcile Shopify result (read only)</button></Form>
                {execution.plan === "UPDATE" ? <p>Uncertain updates are reconciled read-only. If Shopify still shows the original values, do not retry from StockHub: a prior request may still complete later, so this operation requires manual investigation before any later execution.</p> : null}
              </> : null}
              {execution?.status === "READY" ? <Form method="post"><input type="hidden" name="intent" value="execute-catalog" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="groupId" value={proposal.groupId} /><input type="hidden" name="reviewVersion" value={proposal.reviewVersion} /><input type="hidden" name="snapshotFingerprint" value={proposal.snapshotFingerprint} /><button type="submit">Continue approved catalog operation</button></Form> : null}
            </> : null}
            {stale ? <p role="status">This comparison is stale because the catalog draft or Shopify state changed. Compare the current draft again before saving or confirming.</p> : null}
          </article>;
        })}
        <p>Execution is disabled unless the server verifies an explicitly pinned Development App, development store, and isolated loopback PostgreSQL database. Shopify CLI or Vite being active is not sufficient authorization. Product creation defaults to Draft; this workflow never deletes products or variants and never changes inventory quantities.</p>
      </div> : compareResult ? <div className="stockhub-catalog-compare-result" aria-live="polite"><p>Draft version {compareResult.draftVersion} · Snapshot {new Date(compareResult.fetchedAt).toLocaleString()} · SHA-256 <code>{compareResult.fingerprint}</code></p><p>No active product groups are available to compare.</p></div> : reviewHistory.length ? <p>Saved comparison history is shown below the next comparison result.</p> : null}
    </section> : null}
    {batch.status === "DRAFT" ? <section className="stockhub-panel stockhub-catalog-groups"><s-section heading="Product Groups">
      <p>Grouping suggestions never create Shopify products or variants. Review the proposed variants and explicitly accept each valid group.</p>
      {!groups.length ? <><p>No grouping proposals exist yet. Older drafts can create safe suggestions from the current draft rows.</p><Form method="post"><input type="hidden" name="intent" value="suggest-groups" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><button type="submit">Suggest product groups</button></Form></> : <>
        <div className="stockhub-catalog-groups-toolbar">
          <label>Select groups to merge<select multiple aria-label="Select product groups to merge" defaultValue={[]}>{groups.map((group) => <option key={group.id} value={group.id}>{group.reason}</option>)}</select></label>
          <Form method="post" id="catalog-merge-groups-form" onSubmit={(event) => {
            const select = document.querySelector<HTMLSelectElement>('[aria-label="Select product groups to merge"]');
            const selected = select ? Array.from(select.selectedOptions, (option) => option.value) : [];
            if (selected.length < 2) { event.preventDefault(); return; }
            const input = event.currentTarget.querySelector<HTMLInputElement>('input[name="groupIds"]');
            if (input) input.value = JSON.stringify(selected);
          }}><input type="hidden" name="intent" value="merge-groups" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input id="catalog-merge-group-ids" type="hidden" name="groupIds" value="[]" /><button type="submit">Merge selected groups</button></Form>
        </div>
        {visibleGroups.map((group) => <article className="stockhub-catalog-group-card" key={group.id}>
          <header><div><h3>{group.source === "productGroupCode" ? "Group Code" : group.source === "productName" ? "Product Name" : "Merchant-defined group"}: {group.groupingKey}</h3><p>{group.reason}</p></div><span className={`status-${(qualityByGroup.get(group.id)?.state ?? "READY").toLowerCase()}`}>{qualityByGroup.get(group.id)?.state ?? "READY"} · {group.confirmedAt ? "Accepted" : "Unconfirmed"}</span></header>
          <p>{group.lines.length} row{group.lines.length === 1 ? "" : "s"} · {group.lines.map((line) => line.sku || "Missing SKU").join(", ")}</p>
          {qualityByGroup.get(group.id)?.issues.length ? <div role="status" className="stockhub-catalog-group-issues"><strong>Issues and suggested corrections:</strong><ul>{qualityByGroup.get(group.id)!.issues.map((issue, index) => <li key={`${issue.code}-${issue.rowId ?? "group"}-${index}`}>{issue.message}<br /><small>Suggested fix: {issue.suggestion}</small></li>)}</ul></div> : <p>No data-quality issues for this group.</p>}
          {GROUP_PRODUCT_FIELDS.map((field) => {
            const selection = (group.selections as GroupSelections)?.[field];
            const source = group.lines.find((line) => line.id === selection?.sourceLineId);
            const conflicting = new Set(group.lines.map((line) => normalizeCatalogGroupingValue(typeof line[field] === "string" ? String(line[field]) : "")).filter(Boolean)).size > 1;
            return conflicting && selection && source ? <p className="stockhub-catalog-group-resolution" key={`resolved-${field}`}>Selected {fieldLabels[field]}: <strong>{selection.value}</strong> · source row {source.sourceRowNumber ?? "manual"}</p> : null;
          })}
          {GROUP_PRODUCT_FIELDS.filter((field) => new Set(group.lines.map((line) => normalizeCatalogGroupingValue(typeof line[field] === "string" ? String(line[field]) : "")).filter(Boolean)).size > 1).map((field) => <Form method="post" className="stockhub-catalog-resolve-field" key={field}>
            <input type="hidden" name="intent" value="resolve-field" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="groupId" value={group.id} /><input type="hidden" name="field" value={field} />
            <label>{fieldLabels[field]} differs between source rows; select the product-level value<select name="sourceLineId" required defaultValue=""><option value="" disabled>Select a source row</option>{group.lines.filter((line) => typeof line[field] === "string" && String(line[field]).trim()).map((line) => <option key={line.id} value={line.id}>Row {line.sourceRowNumber ?? "manual"}: {String(line[field])}</option>)}</select></label><button type="submit">Use selected value</button>
          </Form>)}
          <div className="stockhub-catalog-group-variants"><table><thead><tr><th>Source row</th><th>SKU</th><th>Size</th><th>Color</th><th>Validation</th></tr></thead><tbody>{group.lines.map((line) => <tr key={line.id}><td>{line.sourceRowNumber ?? "Manual"}</td><td>{line.sku || "Missing"}</td><td>{line.size || "—"}</td><td>{line.color || "—"}</td><td>{line.status}{Array.isArray(line.errors) && line.errors.length ? ` · ${(line.errors as string[]).join(" ")}` : ""}</td></tr>)}</tbody></table><div className="stockhub-catalog-group-variant-cards">{group.lines.map((line) => <article key={line.id}><strong>Row {line.sourceRowNumber ?? "Manual"} · {line.status}</strong><dl><div><dt>SKU</dt><dd>{line.sku || "Missing"}</dd></div><div><dt>Size</dt><dd>{line.size || "—"}</dd></div><div><dt>Color</dt><dd>{line.color || "—"}</dd></div></dl>{Array.isArray(line.errors) && line.errors.length ? <p role="alert">{(line.errors as string[]).join(" ")}</p> : null}</article>)}</div></div>
          <Form method="post" className="stockhub-catalog-split-form" onSubmit={(event) => {
            const form = event.currentTarget;
            const selected = Array.from(form.querySelectorAll<HTMLInputElement>('input[data-split-row]:checked'), (input) => input.value);
            if (!selected.length) { event.preventDefault(); return; }
            const hidden = form.querySelector<HTMLInputElement>('input[name="lineIds"]');
            if (hidden) hidden.value = JSON.stringify(selected);
          }}><input type="hidden" name="intent" value="split-selected" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="groupId" value={group.id} /><input type="hidden" name="lineIds" value="[]" /><fieldset><legend>Select rows to move into a standalone product proposal</legend>{group.lines.map((line) => <label key={line.id}><input type="checkbox" data-split-row value={line.id} /> Row {line.sourceRowNumber ?? "manual"} · {line.sku || "Missing SKU"}</label>)}</fieldset><button type="submit">Split selected rows</button></Form>
          <div className="stockhub-catalog-group-actions"><Form method="post"><input type="hidden" name="intent" value="accept-group" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="groupId" value={group.id} /><button type="submit" disabled={!group.canAccept || Boolean(group.confirmedAt)}>Accept Group</button></Form>{group.confirmedAt ? <p>Accepted {new Date(group.confirmedAt).toLocaleString()}. Any membership or row edits require review again.</p> : null}</div>
        </article>)}
      </>}
    </s-section></section> : null}
    {batch.status === "MAPPING" ? <section className="stockhub-panel"><s-section heading="Map source columns">
      <p>Map Product Name and SKU. Other fields are optional. Duplicate source headers remain separate by column position. Quantity is not a catalog field.</p>
      {mappingPreview && !editingMapping ? <>
        <p>Review normalized values and original source provenance before creating this draft.</p>
        <div className="stockhub-catalog-preview-cards" aria-label="Normalized catalog preview cards">{mappingPreview.rows.map((row) => <article className="stockhub-catalog-preview-card" key={`card-${row.rowNumber}`}>
          <h3>Source row {row.rowNumber} · {row.errors.length ? "Error" : "Ready"}</h3>
          <dl>
            <div><dt>Product Name</dt><dd>{row.normalized.productName || "Missing"}</dd></div>
            <div><dt>SKU</dt><dd>{row.normalized.sku || "Missing"}</dd></div>
            <div><dt>Price</dt><dd>{row.price ?? "Not provided"}</dd></div>
            {Object.entries(row.normalized).filter(([field]) => !["productName", "sku", "price"].includes(field)).map(([field, value]) => <div key={field}><dt>{fieldLabels[field as keyof typeof fieldLabels]}</dt><dd>{value || "—"}</dd></div>)}
          </dl>
          {row.errors.length ? <p className="stockhub-catalog-preview-errors" role="status">{row.errors.join(" ")}</p> : null}
          <details><summary>Original source values and mapping</summary>
            <dl>{Object.entries(mappingPreview.mapping).filter(([, field]) => field !== null).map(([index, field]) => <div key={index}><dt>{headers[Number(index)].replace(/^\uFEFF/, "") || `Column ${Number(index) + 1}`} · column {Number(index) + 1}</dt><dd>{fieldLabels[field as keyof typeof fieldLabels]}: {row.sourceValues[Number(index)] ?? "Missing"}</dd></div>)}</dl>
            <pre>{JSON.stringify(row.sourceValues, null, 2)}</pre>
          </details>
        </article>)}</div>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable region enables keyboard horizontal scrolling */}
        <div className="stockhub-catalog-table-wrap stockhub-catalog-preview-table-wrap" role="region" aria-label="Normalized catalog preview; scroll horizontally to see all columns" tabIndex={0}><table className="stockhub-catalog-table stockhub-catalog-preview-table"><thead><tr><th>Source row</th><th>Product Name</th><th>SKU</th><th>Price</th><th>Other mapped values</th><th>Source provenance</th><th>Validation</th></tr></thead><tbody>{mappingPreview.rows.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.normalized.productName ?? ""}</td><td>{row.normalized.sku ?? ""}</td><td>{row.price ?? "—"}</td><td>{Object.entries(row.normalized).filter(([field]) => !["productName", "sku", "price"].includes(field)).map(([field, value]) => `${field}: ${value}`).join(" · ")}</td><td>{Object.entries(mappingPreview.mapping).filter(([, field]) => field !== null).map(([index, field]) => `${headers[Number(index)] || `Column ${Number(index) + 1}`} → ${field}: ${row.sourceValues[Number(index)] ?? ""}`).join(" · ")}</td><td>{row.errors.length ? row.errors.join(" ") : "Ready"}</td></tr>)}</tbody></table></div>
        <p>Preview retains original source cells by column position, including duplicate header names.</p>
        <Form method="post"><input type="hidden" name="intent" value="save-mapping" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="mapping" value={JSON.stringify(mappingPreview.mapping)} /><button type="submit">Confirm mapping and create draft</button> <button type="button" onClick={() => setEditingMapping(true)}>Edit mapping</button></Form>
      </> : <Form method="post" onSubmit={createMapping}><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="mapping" value="{}" />
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable region enables keyboard horizontal scrolling */}
        <div className="stockhub-catalog-table-wrap" role="region" aria-label="Source column mappings; scroll horizontally to see all columns" tabIndex={0}><table className="stockhub-catalog-table"><thead><tr><th>Source column</th><th>Suggested mapping</th><th>Sample</th></tr></thead><tbody>{headers.map((header, index) => <tr key={index}><td>{header.replace(/^\uFEFF/, "") || `(blank header · column ${index + 1})`} <small>Column {index + 1}</small></td><td><select name={`column-${index}`} defaultValue={mappingDefaults[String(index)] as string}><option value="">Ignore</option>{fields.map((field) => <option key={field} value={field}>{fieldLabels[field]}</option>)}</select></td><td>{String(samples[index] ?? "")}</td></tr>)}</tbody></table></div>
        <button type="submit" name="intent" value="preview-mapping">Preview normalized data</button>
      </Form>}
    </s-section></section> : <>
      <section className="stockhub-panel"><s-section heading="Normalized preview"><p>Source row and original positional values are retained for traceability. Correct invalid rows before any future catalog operation.</p>
        {!visibleLines.length ? <p role="status">No rows match the current search and quality filter.</p> : null}
        {visibleLines.map((line) => { const evaluated = qualityByRow.get(line.id); return <article key={line.id} className="stockhub-catalog-row-card">
          <p><strong>Row {line.sourceRowNumber ?? "Manual"} · {evaluated?.state ?? "READY"}</strong></p>
          {evaluated?.issues.length ? <ul className="stockhub-catalog-row-issues">{evaluated.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><strong>{issue.field ? fieldLabels[issue.field as keyof typeof fieldLabels] ?? issue.field : "Draft"}:</strong> {issue.message} <small>Suggested fix: {issue.suggestion}</small></li>)}</ul> : <p>No quality issues.</p>}
          {line.sourceRowNumber !== null ? <details><summary>Original source values</summary><pre>{JSON.stringify(line.sourceValues, null, 2)}</pre></details> : null}
          <Form method="post" className="stockhub-catalog-fields"><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="lineId" value={line.id} /><input type="hidden" name="intent" value="edit" />
            {fields.map((field) => <label key={field} className="stockhub-catalog-field">{fieldLabels[field]}<input name={field} defaultValue={field === "price" ? line.price?.toString() ?? "" : String(line[field] ?? "")} /></label>)}
            <label className="stockhub-catalog-confirm-zero"><input type="checkbox" name="priceZeroConfirmed" defaultChecked={line.priceZeroConfirmed} /> Confirm zero price is intentional</label> <button type="submit">Save row</button>
          </Form>
          <Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="draftVersion" value={batch.draftVersion} /><input type="hidden" name="lineId" value={line.id} /><button type="submit">Delete row</button></Form>
        </article>; })}
      </s-section></section>
      <section className="stockhub-panel"><s-section heading="Add manual row"><Form method="post" className="stockhub-catalog-fields"><input type="hidden" name="intent" value="add" /><input type="hidden" name="draftVersion" value={batch.draftVersion} />{fields.map((field) => <label key={field} className="stockhub-catalog-field">{fieldLabels[field]}<input name={field} /></label>)}<label className="stockhub-catalog-confirm-zero"><input type="checkbox" name="priceZeroConfirmed" /> Confirm zero price is intentional</label><button type="submit">Add row</button></Form></s-section></section>
    </>}
  </main>;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
