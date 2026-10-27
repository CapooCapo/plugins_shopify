import { redirect } from "react-router";
import { checksumCatalogCsv, normalizeCatalogRows, parseCatalogCsv, validateCatalogMapping } from "../../app/utils/catalog-import.server";
import { CATALOG_FIELDS } from "../../app/utils/catalog-import.shared";
import { proposeCatalogProductGroups } from "../../app/utils/catalog-grouping.shared";
import { evaluateCatalogQuality } from "../../app/utils/catalog-quality.shared";

const labels = {
  productName: "Product Name", sku: "SKU", price: "Price", description: "Description", productGroupCode: "Product Group Code",
  size: "Size", color: "Color", vendor: "Vendor", productType: "Product Type", imageUrl: "Image URL",
};

type CatalogLine = {
  id: string; shop: string; batchId: string; rowNumber: number; sourceRowNumber: number | null; sourceValues: string[];
  productName: string | null; sku: string | null; price: string | null; priceZeroConfirmed: boolean; description: string | null;
  productGroupCode: string | null; size: string | null; color: string | null; vendor: string | null; productType: string | null;
  imageUrl: string | null; status: string; errors: string[]; groupId?: string | null;
};
type CatalogGroup = { id: string; source: string; groupingKey: string; reason: string; lineIds: string[]; selections: Record<string, { value: string; sourceLineId: string } | null>; confirmedAt: string | null; state: "ACTIVE" | "SUPERSEDED" };
type CatalogBatch = {
  id: string; shop: string; submissionId: string; fileName: string; fileChecksum: string; originalCsv: string;
  sourceHeaders: string[]; mapping: Record<string, string | null> | null; status: string; draftVersion: number;
  createdAt: Date; updatedAt: Date; lines: CatalogLine[]; groups?: CatalogGroup[];
};

const shop = "example-outfitters.myshopify.com";
const batches = new Map<string, CatalogBatch>();
let nextId = 1;

const storageKey = "stockhub-visual-catalog-fixtures";
function persist() {
  localStorage.setItem(storageKey, JSON.stringify({ nextId, batches: [...batches.values()] }));
}

function ensureSuggestedGroups(batch: CatalogBatch) {
  const unassigned = batch.lines.filter((line) => !line.groupId);
  for (const proposal of proposeCatalogProductGroups(unassigned)) {
    makeFixtureGroup(batch, batch.lines.filter((line) => proposal.lines.some((member) => member.id === line.id)), proposal.source, proposal.normalizedValue, proposal.reason);
  }
}

function makeFixtureGroup(batch: CatalogBatch, lines: CatalogLine[], source: string, key: string, reason: string) {
  const groupId = `visual-group-${nextId++}`;
  const selections: CatalogGroup["selections"] = {};
  for (const field of ["productName", "vendor", "productType", "description", "imageUrl"]) {
    const values = new Map<string, CatalogLine>();
    for (const line of lines) {
      const value = String(line[field as keyof CatalogLine] ?? "").trim();
      if (value) values.set(value.toLocaleLowerCase(), line);
    }
    const selected = values.size === 1 ? values.values().next().value : null;
    selections[field] = selected ? { value: String(selected[field as keyof CatalogLine] ?? ""), sourceLineId: selected.id } : null;
  }
  const group: CatalogGroup = { id: groupId, source, groupingKey: key, reason, lineIds: lines.map((line) => line.id), selections, confirmedAt: null, state: "ACTIVE" };
  batch.groups ??= [];
  batch.groups.push(group);
  for (const line of batch.lines) if (group.lineIds.includes(line.id)) line.groupId = groupId;
  return group;
}

function fixtureGroupIssues(group: CatalogGroup, lines: CatalogLine[]) {
  return proposeCatalogProductGroups(lines).flatMap((proposal) => proposal.issues).filter((issue) => {
    if (issue.code !== "PRODUCT_FIELD_CONFLICT" || !issue.field) return true;
    const selection = group.selections[issue.field];
    const source = lines.find((line) => line.id === selection?.sourceLineId);
    return !selection || !source || String(source[issue.field as keyof CatalogLine] ?? "").trim() !== selection.value;
  });
}

function detailData(batch: CatalogBatch, warnMissingImage = false) {
  const groups = (batch.groups ?? []).filter((group) => group.state === "ACTIVE").map((group) => {
    const lines = batch.lines.filter((line) => group.lineIds.includes(line.id));
    const issues = fixtureGroupIssues(group, lines);
    for (const line of lines) if (line.status === "ERROR") for (const error of line.errors) issues.push({ code: "SOURCE_ROW_ERROR", message: String(error), lineIds: [line.id] });
    return { ...group, lines, issues, canAccept: issues.length === 0 };
  });
  const quality = evaluateCatalogQuality(batch.lines, groups.map((group) => ({
    id: group.id,
    lines: group.lines,
    issues: group.issues,
    confirmedAt: group.confirmedAt,
    optionDimensions: [
      ...(group.lines.some((line) => String(line.size ?? "").trim()) ? ["Size"] : []),
      ...(group.lines.some((line) => String(line.color ?? "").trim()) ? ["Color"] : []),
    ],
  })), { warnMissingImage });
  return { batch, groups, headers: batch.sourceHeaders, samples: parseCatalogCsv(batch.originalCsv).rows[0]?.values ?? [], fields: CATALOG_FIELDS, labels, quality, warnMissingImage };
}

export function resetCatalogFixtures() { batches.clear(); nextId = 1; localStorage.removeItem(storageKey); }
export function hydrateCatalogFixtures() {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return;
  try {
    const state = JSON.parse(saved) as { nextId?: number; batches?: Array<CatalogBatch & { createdAt: string; updatedAt: string }> };
    batches.clear();
    for (const batch of state.batches ?? []) batches.set(batch.id, {
      ...batch, createdAt: new Date(batch.createdAt), updatedAt: new Date(batch.updatedAt),
    });
    nextId = Number.isSafeInteger(state.nextId) && (state.nextId ?? 0) > 0 ? state.nextId! : 1;
  } catch {
    batches.clear();
    nextId = 1;
  }
}

export async function catalogListLoader() {
  return {
    shop,
    batches: [...batches.values()].map((batch) => ({
      id: batch.id, fileName: batch.fileName, status: batch.status, draftVersion: batch.draftVersion,
      createdAt: batch.updatedAt, _count: { lines: batch.lines.length },
    })),
  };
}

export async function catalogListAction({ request }: { request: Request }) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return { error: "Choose a CSV file first." };
  const originalCsv = await file.text();
  const parsed = parseCatalogCsv(originalCsv);
  const id = `visual-catalog-${nextId++}`;
  const now = new Date("2026-10-27T12:00:00Z");
  batches.set(id, {
    id, shop, submissionId: `visual-submit-${id}`, fileName: file.name, fileChecksum: checksumCatalogCsv(originalCsv),
    originalCsv, sourceHeaders: parsed.headers, mapping: null, status: "MAPPING", draftVersion: 0,
    createdAt: now, updatedAt: now, lines: [],
  });
  persist();
  return redirect(`/app/imports/catalog/${id}`);
}

export async function catalogDetailLoader({ params, request }: { params: { batchId?: string }; request: Request }) {
  const batch = params.batchId ? batches.get(params.batchId) : null;
  if (!batch) throw new Response("Fixture catalog draft not found", { status: 404 });
  return detailData(batch, new URL(request.url).searchParams.get("warnMissingImage") === "1");
}

function canonicalValues(form: FormData) {
  const price = String(form.get("price") ?? "").trim();
  const zeroConfirmed = form.get("priceZeroConfirmed") === "on";
  const errors: string[] = [];
  const productName = String(form.get("productName") ?? "").trim();
  const sku = String(form.get("sku") ?? "").trim();
  if (!productName) errors.push("Product Name is required.");
  if (!sku) errors.push("SKU is required.");
  if (price && !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(price)) errors.push(`Price must be a non-negative decimal. The attempted value was “${price.slice(0, 128)}”.`);
  if (/^0(?:\.0{1,6})?$/.test(price) && !zeroConfirmed) errors.push("Confirm that zero price is intentional.");
  return {
    productName, sku, price: !price || (price && !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(price)) ? null : price,
    priceZeroConfirmed: zeroConfirmed, description: String(form.get("description") ?? ""),
    productGroupCode: String(form.get("productGroupCode") ?? ""), size: String(form.get("size") ?? ""),
    color: String(form.get("color") ?? ""), vendor: String(form.get("vendor") ?? ""),
    productType: String(form.get("productType") ?? ""), imageUrl: String(form.get("imageUrl") ?? ""),
    errors, status: errors.length ? "ERROR" : "READY",
  };
}

export async function catalogDetailAction({ request, params }: { request: Request; params: { batchId?: string } }) {
  const batch = params.batchId ? batches.get(params.batchId) : null;
  if (!batch) return { error: "Fixture catalog draft not found." };
  const form = await request.formData();
  const version = Number(form.get("draftVersion"));
  if (version !== batch.draftVersion) return { error: "This draft changed in another tab. Reload before saving." };
  const intent = String(form.get("intent") ?? "");
  if (intent === "preview-mapping" || intent === "save-mapping") {
    const headers = batch.sourceHeaders;
    const rawMapping = JSON.parse(String(form.get("mapping") ?? "{}")) as unknown;
    let mapping: ReturnType<typeof validateCatalogMapping>;
    try {
      mapping = validateCatalogMapping(headers, rawMapping);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Invalid catalog mapping." };
    }
    const rows = normalizeCatalogRows(parseCatalogCsv(batch.originalCsv), mapping);
    if (intent === "preview-mapping") return { mappingPreview: { mapping, rows } };
    batch.mapping = mapping as Record<string, string | null>;
    batch.status = "DRAFT";
    batch.draftVersion++;
    batch.updatedAt = new Date();
    batch.lines = rows.map((row) => ({
      id: `visual-line-${nextId++}`, shop, batchId: batch.id, rowNumber: row.rowNumber, sourceRowNumber: row.rowNumber,
      sourceValues: row.sourceValues, productName: row.normalized.productName?.trim() || null, sku: row.normalized.sku?.trim() || null,
      price: row.price && /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(row.price) ? row.price : null,
      priceZeroConfirmed: false, description: row.normalized.description || null, productGroupCode: row.normalized.productGroupCode || null,
      size: row.normalized.size || null, color: row.normalized.color || null, vendor: row.normalized.vendor || null,
      productType: row.normalized.productType || null, imageUrl: row.normalized.imageUrl || null, status: row.status, errors: row.errors,
    }));
    batch.groups = [];
    ensureSuggestedGroups(batch);
    persist();
    return redirect(`/app/imports/catalog/${batch.id}`);
  }
  if (intent === "delete-batch") { batches.delete(batch.id); persist(); return redirect("/app/imports/catalog"); }
  if (batch.status !== "DRAFT") return { error: "Only a mapped draft can be edited." };
  if (intent === "compare-shopify") {
    const data = detailData(batch);
    const qualityByGroup = new Map(data.quality.groups.map((group) => [group.id, group.state]));
    const proposals = (batch.groups ?? []).filter((group) => group.state === "ACTIVE").map((group) => {
      const confirmed = Boolean(group.confirmedAt);
      return {
        groupId: group.id, groupTitle: group.groupingKey, disposition: confirmed ? "CREATE" as const : "SKIP" as const,
        eligible: false, quality: qualityByGroup.get(group.id) ?? "READY" as const,
        reason: confirmed ? "Fixture: no exact SKU match. Candidate only; future execution must recheck Shopify state." : "Group is not confirmed; confirm it before it can be eligible.",
        productId: null, variantId: null, changes: [], rowIds: group.lineIds,
      };
    });
    return { compareResult: {
      draftVersion: batch.draftVersion, shop, fetchedAt: new Date("2026-10-27T12:05:00Z").toISOString(),
      fingerprint: checksumCatalogCsv(`${batch.fileChecksum}:${batch.draftVersion}`), proposals,
      totalRows: batch.lines.length, totalGroups: proposals.length, unconfirmedGroups: proposals.filter((proposal) => proposal.disposition === "SKIP").length,
    } };
  }
  if (intent === "suggest-groups") {
    if ((batch.groups ?? []).some((group) => group.state === "ACTIVE")) return { error: "Grouping suggestions already exist for this draft." };
    ensureSuggestedGroups(batch);
  } else if (intent === "accept-group") {
    const group = batch.groups?.find((item) => item.id === form.get("groupId") && item.state === "ACTIVE");
    if (!group) return { error: "Product group not found in this draft." };
    const lines = batch.lines.filter((line) => group.lineIds.includes(line.id));
    if (fixtureGroupIssues(group, lines).length || lines.some((line) => line.status === "ERROR")) return { error: "Resolve all group and row validation issues before accepting this group." };
    group.confirmedAt = new Date().toISOString();
  } else if (intent === "resolve-field") {
    const group = batch.groups?.find((item) => item.id === form.get("groupId") && item.state === "ACTIVE");
    const field = String(form.get("field") ?? "");
    const line = batch.lines.find((item) => item.id === form.get("sourceLineId") && group?.lineIds.includes(item.id));
    if (!group || !["productName", "vendor", "productType", "description", "imageUrl"].includes(field) || !line) return { error: "Choose a value from a source row in this group." };
    group.selections[field] = { value: String(line[field as keyof CatalogLine] ?? "").trim(), sourceLineId: line.id };
    group.confirmedAt = null;
  } else if (intent === "merge-groups") {
    let ids: string[];
    try { ids = JSON.parse(String(form.get("groupIds") ?? "[]")) as string[]; } catch { return { error: "Choose at least two groups." }; }
    const selected = batch.groups?.filter((group) => group.state === "ACTIVE" && ids.includes(group.id)) ?? [];
    if (ids.length < 2 || selected.length !== ids.length) return { error: "Choose at least two active groups from this draft." };
    const lines = batch.lines.filter((line) => selected.some((group) => group.lineIds.includes(line.id)));
    for (const group of selected) { group.state = "SUPERSEDED"; group.confirmedAt = null; }
    makeFixtureGroup(batch, lines, "MANUAL", `manual:${nextId}`, "Merchant merged these groups. Review all rows and explicitly accept the result.");
  } else if (intent === "split-selected") {
    const group = batch.groups?.find((item) => item.id === form.get("groupId") && item.state === "ACTIVE");
    let ids: string[];
    try { ids = JSON.parse(String(form.get("lineIds") ?? "[]")) as string[]; } catch { return { error: "Select rows to split." }; }
    if (!group || !ids.length || ids.some((id) => !group.lineIds.includes(id))) return { error: "Only rows in this group can be split." };
    const moved = batch.lines.filter((line) => ids.includes(line.id));
    group.lineIds = group.lineIds.filter((id) => !ids.includes(id));
    group.confirmedAt = null;
    if (!group.lineIds.length) group.state = "SUPERSEDED";
    makeFixtureGroup(batch, moved, "MANUAL", `manual:${nextId}`, "Merchant split these rows into a separate product proposal. Review and explicitly accept it.");
  } else if (intent === "delete") {
    const removed = batch.lines.find((line) => line.id === form.get("lineId"));
    if (removed?.groupId) {
      const group = batch.groups?.find((item) => item.id === removed.groupId && item.state === "ACTIVE");
      if (group) { group.lineIds = group.lineIds.filter((id) => id !== removed.id); group.confirmedAt = null; if (!group.lineIds.length) group.state = "SUPERSEDED"; }
    }
    batch.lines = batch.lines.filter((line) => line.id !== form.get("lineId"));
  } else {
    const lineId = String(form.get("lineId") ?? "");
    if (intent === "add") batch.lines.push({ id: `visual-line-${nextId++}`, shop, batchId: batch.id, rowNumber: Math.max(0, ...batch.lines.map((line) => line.rowNumber)) + 1, sourceRowNumber: null, sourceValues: [], ...canonicalValues(form) });
    else if (intent === "edit") {
      const line = batch.lines.find((item) => item.id === lineId);
      if (line) {
        Object.assign(line, canonicalValues(form));
        const group = batch.groups?.find((item) => item.id === line.groupId && item.state === "ACTIVE");
        if (group) group.confirmedAt = null;
      }
    }
    ensureSuggestedGroups(batch);
  }
  batch.draftVersion++;
  batch.updatedAt = new Date();
  persist();
  return redirect(`/app/imports/catalog/${batch.id}`);
}
