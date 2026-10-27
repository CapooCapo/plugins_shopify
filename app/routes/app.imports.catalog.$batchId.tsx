import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { useEffect, useState } from "react";
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
import { compareCatalogGroups, type CatalogCompareField } from "../utils/catalog-compare.shared";
import { readShopifyCatalogSnapshot } from "../utils/catalog-shopify-read.server";
import { missingScopesForGrant, queryGrantedScopes } from "../utils/shopify-scopes.server";

const labels: Record<(typeof CATALOG_FIELDS)[number], string> = {
  productName: "Product Name", sku: "SKU", price: "Price", description: "Description", productGroupCode: "Product Group Code",
  size: "Size", color: "Color", vendor: "Vendor", productType: "Product Type", imageUrl: "Image URL",
};
type CanonicalInput = { productName: string; sku: string; price: string; priceValid: boolean; priceZeroConfirmed: boolean; description: string; productGroupCode: string; size: string; color: string; vendor: string; productType: string; imageUrl: string; errors: string[] };
const GROUP_PRODUCT_FIELDS = ["productName", "vendor", "productType", "description", "imageUrl"] as const;
type GroupProductField = (typeof GROUP_PRODUCT_FIELDS)[number];
type GroupSelection = { value: string; sourceLineId: string } | null;
type GroupSelections = Partial<Record<GroupProductField, GroupSelection>>;

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
      groups: { where: { state: "ACTIVE" }, include: { lines: { orderBy: { rowNumber: "asc" } } }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!batch) throw new Response("Catalog draft not found", { status: 404 });
  const headers = Array.isArray(batch.sourceHeaders) ? batch.sourceHeaders.map(String) : [];
  const samples = parseCatalogCsv(batch.originalCsv).rows[0]?.values ?? [];
  const groups = batch.groups.map((group) => {
    const lines = group.lines.map((line) => groupingLine(line as unknown as Record<string, unknown>));
    const selections = (group.selections && typeof group.selections === "object" ? group.selections : {}) as GroupSelections;
    const issues = validateGroup(lines, selections, group.source, batch.lines.map((line) => groupingLine(line as unknown as Record<string, unknown>)));
    return { ...group, lines: group.lines, issues, canAccept: issues.length === 0 };
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
  return { batch, groups, headers, samples, fields: CATALOG_FIELDS, labels, quality, warnMissingImage, prepared: new URL(request.url).searchParams.get("prepared") };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin, scopes } = await authenticate.admin(request);
  const body = await readRequestBodyLimited(request, 128 * 1024);
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const form = await new Request(request.url, { method: request.method, headers, body }).formData();
  const batchId = params.batchId;
  const intent = String(form.get("intent") ?? "");
  const version = Number(form.get("draftVersion"));
  if (!batchId || !Number.isSafeInteger(version) || version < 0) return { error: "Reload this draft and try again." };
  try {
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
      const unconfirmedRows = proposals.filter((row) => !row.confirmed || row.quality === "ERROR");
      const snapshot = confirmedRows.length ? await readShopifyCatalogSnapshot((query, options) => admin.graphql(query, options) as Promise<Response>, session.shop) : { variants: [], fetchedAt: new Date().toISOString() };
      const changes = compareCatalogGroups(proposals, snapshot.variants);
      const fingerprint = createHash("sha256").update(JSON.stringify(snapshot.variants)).digest("hex");
      const latest = await prisma.catalogImportBatch.findFirst({ where: { shop: session.shop, id: batchId }, select: { draftVersion: true } });
      if (!latest || latest.draftVersion !== version) throw new Error("This draft changed while Shopify was being read. Reload and compare again.");
      return { compareResult: { draftVersion: current.draftVersion, shop: session.shop, fetchedAt: snapshot.fetchedAt, fingerprint, proposals: changes, totalRows: current.lines.length, totalGroups: current.groups.length, unconfirmedGroups: unconfirmedRows.length ? current.groups.filter((group) => !group.confirmedAt).length : 0 } };
    }
    if (intent === "delete-batch") {
      const deleted = await prisma.catalogImportBatch.deleteMany({ where: { shop: session.shop, id: batchId, draftVersion: version } });
      if (deleted.count !== 1) throw new Error("This draft changed in another tab. Reload before deleting.");
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
    return { error: error instanceof Error ? error.message : "Unable to save this catalog draft." };
  }
};

export default function CatalogImportDetail() {
  const { batch, groups, headers, samples, fields, labels: fieldLabels, quality, warnMissingImage, prepared } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [editingMapping, setEditingMapping] = useState(false);
  const [qualitySearch, setQualitySearch] = useState("");
  const [qualityFilter, setQualityFilter] = useState("ALL");
  const [merchantDecisions, setMerchantDecisions] = useState<Record<string, "ACCEPT_PROPOSAL" | "SKIP">>({});
  const compareResult = actionData && "compareResult" in actionData ? actionData.compareResult : null;
  useEffect(() => { if (compareResult) setMerchantDecisions({}); }, [compareResult]);
  const mappingPreview = actionData && "mappingPreview" in actionData ? actionData.mappingPreview : null;
  const previewMapping = mappingPreview?.mapping;
  const mappingDefaults = Object.fromEntries(headers.map((header, index) => [String(index), previewMapping?.[index] ?? suggestCatalogField(header) ?? ""]));
  const qualityByRow = new Map(quality.rows.map((row) => [row.id, row]));
  const qualityByGroup = new Map(quality.groups.map((group) => [group.id, group]));
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
      {compareResult ? <div className="stockhub-catalog-compare-result" aria-live="polite">
        <p>Draft version {compareResult.draftVersion} · Snapshot {new Date(compareResult.fetchedAt).toLocaleString()} · SHA-256 <code>{compareResult.fingerprint}</code></p>
        <p>{compareResult.proposals.filter((proposal) => proposal.disposition === "CREATE").length} Create candidates · {compareResult.proposals.filter((proposal) => proposal.disposition === "UPDATE").length} Update candidates · {compareResult.proposals.filter((proposal) => proposal.disposition === "SKIP").length} Skipped · {compareResult.proposals.filter((proposal) => proposal.disposition === "CONFLICT").length} Conflicts</p>
        <p>Quality is independent: {compareResult.proposals.filter((proposal) => proposal.quality === "READY").length} Ready · {compareResult.proposals.filter((proposal) => proposal.quality === "WARNING").length} Warning · {compareResult.proposals.filter((proposal) => proposal.quality === "ERROR").length} Error groups</p>
        {!compareResult.proposals.length ? <p>No active product groups are available to compare.</p> : null}
        {compareResult.proposals.map((proposal) => <article key={proposal.groupId} className={`stockhub-catalog-compare-card status-${proposal.disposition.toLowerCase()}`}>
          <header><h3>{proposal.groupTitle}</h3><strong>{proposal.disposition}{proposal.eligible ? " · Eligible" : " · Review required"} · Quality: {proposal.quality ?? "—"}</strong></header>
          <p>{proposal.reason}</p>
          {proposal.productId ? <p>Shopify product <code>{proposal.productId}</code>{proposal.variantId ? ` · variant ${proposal.variantId}` : ""}</p> : null}
          {proposal.changes.length ? <>
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard focus enables horizontal scrolling on narrow screens */}
            <div className="stockhub-catalog-compare-table-wrap" role="region" aria-label={`Field changes for ${proposal.groupTitle}`} tabIndex={0}>
              <table><thead><tr><th>Draft row</th><th>Field</th><th>Current Shopify value</th><th>Proposed CSV value</th><th>Action</th></tr></thead><tbody>{proposal.changes.map((change, index) => <tr key={`${change.rowId ?? "group"}-${change.field}-${index}`}><td>{change.rowNumber ?? "Manual"}</td><th scope="row">{change.field}</th><td>{change.current ?? "(empty)"}</td><td>{change.proposed ?? "(empty)"}</td><td>{change.action}{change.reason ? ` · ${change.reason}` : ""}</td></tr>)}</tbody></table>
            </div>
          </> : null}
          {proposal.disposition === "CREATE" ? <p>No matching Shopify SKU was found. Creation is a proposal only; a future execution must recheck Shopify.</p> : null}
          {proposal.disposition === "CREATE" || proposal.disposition === "UPDATE" ? <div className="stockhub-catalog-merchant-decision"><p>Local review decision: {merchantDecisions[proposal.groupId] === "ACCEPT_PROPOSAL" ? "Accepted for future review" : merchantDecisions[proposal.groupId] === "SKIP" ? "Skipped" : "No decision"}. This choice is in-memory only, does not persist, and does not enable execution.</p><button type="button" onClick={() => setMerchantDecisions((current) => ({ ...current, [proposal.groupId]: "ACCEPT_PROPOSAL" }))}>Accept proposal for review</button> <button type="button" onClick={() => setMerchantDecisions((current) => ({ ...current, [proposal.groupId]: "SKIP" }))}>Skip proposal</button></div> : null}
        </article>)}
        <p>Shopify writes are not available in this review. Candidate groups remain non-eligible until a future explicit execution flow and a fresh server-side recheck.</p>
      </div> : null}
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
