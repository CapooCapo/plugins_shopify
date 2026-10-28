import { createHash } from "node:crypto";

export type CatalogExecutionDisposition = "CREATE" | "UPDATE" | "SKIP" | "CONFLICT";
export type CatalogExecutionChoice = "KEEP_SHOPIFY" | "USE_CSV" | "SKIP";
type ProductField = "title" | "description" | "vendor" | "productType";
type VariantField = "sku" | "price" | "size" | "color";

type Decisions = {
  schemaVersion: 1;
  group: "CONFIRM" | "SKIP";
  productFields: Record<ProductField, CatalogExecutionChoice>;
  variants: Record<string, { operation: "CREATE" | "UPDATE" | "SKIP"; fields: Record<VariantField, CatalogExecutionChoice> }>;
};

type ExecutionLine = {
  id: string;
  sku: string | null;
  price: string | number | { toString(): string } | null;
  productName: string | null;
  description: string | null;
  vendor: string | null;
  productType: string | null;
  size: string | null;
  color: string | null;
  sourceRowNumber?: number | null;
};

type ShopifyVariant = {
  id: string;
  sku: string | null;
  price: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
  productId: string;
  productTitle: string;
  productDescription: string | null;
  vendor: string | null;
  productType: string | null;
  productOptions: Array<{ name: string; values: string[] }>;
};

export type CatalogExecutionItemPlan = {
  lineId: string;
  disposition: CatalogExecutionDisposition;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  price: string | null;
  optionValues: Array<{ optionName: string; name: string }>;
  approvedFields: Record<string, string>;
  reason: string | null;
};

export type CatalogExecutionPlan = {
  disposition: CatalogExecutionDisposition;
  reason: string;
  productId: string | null;
  productCreate: Record<string, unknown> | null;
  productUpdate: Record<string, string>;
  variantUpdates: Array<{ id: string; sku?: string; price?: string }>;
  /** Original Shopify values captured when the approved plan was built; used to distinguish unapplied values from concurrent edits. */
  originalProductFields?: Record<string, string | null>;
  originalVariantFields?: Record<string, { sku?: string | null; price?: string | null }>;
  items: CatalogExecutionItemPlan[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalized(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function canonicalCatalogPrice(value: unknown) {
  const raw = value == null ? "" : String(value).trim();
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(raw)) return raw;
  const [whole, fraction = ""] = raw.split(".");
  const canonicalFraction = fraction.replace(/0+$/, "");
  return canonicalFraction ? `${whole}.${canonicalFraction}` : whole;
}

function parseDecisions(raw: unknown, lineIds: string[]): Decisions {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !["CONFIRM", "SKIP"].includes(String(raw.group)) ||
    !isRecord(raw.productFields) || !isRecord(raw.variants)) {
    throw new Error("The confirmed catalog review has incomplete decisions. Save and confirm the review again.");
  }
  const productFields = raw.productFields;
  const productKeys = ["title", "description", "vendor", "productType"];
  if (Object.keys(productFields).length !== productKeys.length || productKeys.some((key) => !Object.hasOwn(productFields, key))) {
    throw new Error("The confirmed catalog review has incomplete product field decisions.");
  }
  const variants = raw.variants;
  if (Object.keys(variants).length !== lineIds.length || lineIds.some((id) => !Object.hasOwn(variants, id)) || Object.keys(variants).some((id) => !lineIds.includes(id))) {
    throw new Error("The confirmed catalog review no longer matches its draft rows. Compare again before executing.");
  }
  const validChoices = new Set(["KEEP_SHOPIFY", "USE_CSV", "SKIP"]);
  for (const choice of Object.values(productFields)) if (!validChoices.has(String(choice))) throw new Error("The confirmed review contains an unsupported product-field choice.");
  for (const id of lineIds) {
    const entry = variants[id];
    if (!isRecord(entry) || !["CREATE", "UPDATE", "SKIP"].includes(String(entry.operation)) || !isRecord(entry.fields)) {
      throw new Error("The confirmed review contains an unsupported variant operation.");
    }
    const keys = ["sku", "price", "size", "color"];
    if (Object.keys(entry.fields).length !== keys.length || keys.some((key) => !Object.hasOwn(entry.fields as object, key)) ||
      Object.values(entry.fields).some((choice) => !validChoices.has(String(choice)))) {
      throw new Error("The confirmed review contains incomplete variant-field decisions.");
    }
  }
  return raw as unknown as Decisions;
}

export function fingerprintForCatalogReview(snapshot: unknown, proposal: unknown, lines: Array<{ id: string; sku?: string | null }>) {
  const snapshotVariants = isRecord(snapshot) && Array.isArray(snapshot.variants) ? snapshot.variants : null;
  if (!snapshotVariants) throw new Error("The saved Shopify comparison is incomplete. Compare this group again before executing.");
  if (!isRecord(proposal) || typeof proposal.groupTitle !== "string" || !(proposal.productId === null || typeof proposal.productId === "string")) {
    throw new Error("The saved Shopify proposal is incomplete. Compare this group again before executing.");
  }
  const rowIds = Array.isArray(proposal.rowIds) ? proposal.rowIds : [];
  const selectedIds = new Set(rowIds.filter((id): id is string => typeof id === "string"));
  if (selectedIds.size !== lines.length || lines.some((line) => !selectedIds.has(line.id))) {
    throw new Error("The saved Shopify proposal no longer matches the draft rows. Compare again before executing.");
  }
  const skus = new Set(lines.filter((line) => selectedIds.has(line.id)).map((line) => normalized(line.sku)).filter(Boolean));
  const title = proposal.groupTitle.trim().toLocaleLowerCase();
  const relevant = snapshotVariants.filter((entry): entry is ShopifyVariant => isRecord(entry) &&
    (proposal.productId
      ? entry.productId === proposal.productId
      : (typeof entry.sku === "string" && skus.has(entry.sku.trim())) || (typeof entry.productTitle === "string" && entry.productTitle.trim().toLocaleLowerCase() === title)));
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

export function catalogExecutionIdempotencyKey(input: { shop: string; batchId: string; groupId: string; reviewId: string; draftVersion: number; reviewVersion?: number; snapshotFingerprint: string }) {
  const identity = [input.shop, input.batchId, input.groupId, input.reviewId, input.draftVersion];
  if (typeof input.reviewVersion === "number" && Number.isSafeInteger(input.reviewVersion) && input.reviewVersion >= 0) identity.push(input.reviewVersion);
  identity.push(input.snapshotFingerprint);
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function buildCatalogExecutionPlan(input: {
  review: { operation: string; status: string; shopifyProductId: string | null; snapshot: unknown; decisions: unknown };
  group: { id: string; confirmedAt: Date | string | null; selections: unknown; lines: ExecutionLine[] };
  mapping: unknown;
  snapshotVariants: ShopifyVariant[];
}): CatalogExecutionPlan {
  const { review, group, snapshotVariants } = input;
  if (review.status !== "CONFIRMED") throw new Error("Confirm the current saved catalog review before execution.");
  if (!group.confirmedAt) throw new Error("Accept the product group before executing its catalog review.");
  const decisions = parseDecisions(review.decisions, group.lines.map((line) => line.id));
  if (decisions.group === "SKIP") return { disposition: "SKIP", reason: "The merchant skipped this product group.", productId: review.shopifyProductId, productCreate: null, productUpdate: {}, variantUpdates: [], items: group.lines.map((line) => ({ lineId: line.id, disposition: "SKIP", productId: null, variantId: null, sku: null, price: null, optionValues: [], approvedFields: {}, reason: "Group skipped." })) };
  if (!["CREATE", "UPDATE"].includes(review.operation)) return { disposition: "CONFLICT", reason: "This review is not an executable Create or Update proposal.", productId: review.shopifyProductId, productCreate: null, productUpdate: {}, variantUpdates: [], items: group.lines.map((line) => ({ lineId: line.id, disposition: "CONFLICT", productId: null, variantId: null, sku: null, price: null, optionValues: [], approvedFields: {}, reason: "Unsupported proposal." })) };

  const mapping = new Set(Object.values(isRecord(input.mapping) ? input.mapping : {}).filter((value): value is string => typeof value === "string"));
  if (review.operation === "UPDATE" && group.lines.some((line) => {
    const fields = decisions.variants[line.id]!.fields;
    return fields.size === "USE_CSV" || fields.color === "USE_CSV";
  })) {
    const reason = "Size/Color option updates on existing Shopify products are not supported. Keep the current Shopify options; no mutation was planned.";
    return { disposition: "CONFLICT", reason, productId: review.shopifyProductId, productCreate: null, productUpdate: {}, variantUpdates: [], items: group.lines.map((line) => ({ lineId: line.id, disposition: decisions.variants[line.id]!.operation === "SKIP" ? "SKIP" : "CONFLICT", productId: review.shopifyProductId, variantId: null, sku: normalized(line.sku), price: null, optionValues: [], approvedFields: {}, reason })) };
  }
  const selections = isRecord(group.selections) ? group.selections : {};
  const selectionValue = (field: "productName" | "description" | "vendor" | "productType") => {
    const selection = isRecord(selections[field]) ? selections[field] : null;
    if (selection && typeof selection.value === "string") return selection.value.trim();
    const lineId = selection && typeof selection.sourceLineId === "string" ? selection.sourceLineId : null;
    const selected = lineId ? group.lines.find((line) => line.id === lineId) : undefined;
    return normalized(selected?.[field] ?? group.lines.find((line) => normalized(line[field]))?.[field]);
  };
  const productSource: Record<ProductField, "productName" | "description" | "vendor" | "productType"> = {
    title: "productName", description: "description", vendor: "vendor", productType: "productType",
  };
  const productValues: Record<ProductField, string> = {
    title: selectionValue("productName"), description: selectionValue("description"),
    vendor: selectionValue("vendor"), productType: selectionValue("productType"),
  };
  const productUpdate: Record<string, string> = {};
  const originalProductFields: Record<string, string | null> = {};
  for (const field of Object.keys(productSource) as ProductField[]) {
    if (decisions.productFields[field] === "USE_CSV") {
      const sourceField = productSource[field];
      const value = productValues[field];
      if (!mapping.has(sourceField) || !value) throw new Error(`The confirmed review is missing mapped ${field} data. Save fresh review decisions before executing.`);
    }
  }

  const plannedItems: CatalogExecutionItemPlan[] = [];
  const active = group.lines.filter((line) => decisions.variants[line.id]!.operation !== "SKIP");
  if (!active.length) return { disposition: "SKIP", reason: "Every variant is explicitly skipped.", productId: review.shopifyProductId, productCreate: null, productUpdate: {}, variantUpdates: [], items: group.lines.map((line) => ({ lineId: line.id, disposition: "SKIP", productId: null, variantId: null, sku: null, price: null, optionValues: [], approvedFields: {}, reason: "Variant skipped." })) };

  const expectedOperation = review.operation;
    for (const line of group.lines) {
    const decision = decisions.variants[line.id]!;
    if (decision.operation === "SKIP") {
      plannedItems.push({ lineId: line.id, disposition: "SKIP", productId: review.shopifyProductId, variantId: null, sku: null, price: null, optionValues: [], approvedFields: {}, reason: "Variant skipped by the merchant." });
      continue;
    }
    if (decision.operation !== expectedOperation) throw new Error(`Variant row ${line.sourceRowNumber ?? line.id} does not match the confirmed ${expectedOperation} proposal. Compare and confirm again.`);
    const approvedFields: Record<string, string> = {};
    const sku = normalized(line.sku);
    const priceRaw = line.price == null ? "" : String(line.price).trim();
    if (review.operation === "CREATE") {
      for (const field of ["sku", "price"] as const) {
        const raw = field === "sku" ? sku : priceRaw;
        if (decision.fields[field] !== "USE_CSV" || !mapping.has(field) || !raw) throw new Error(`New variant row ${line.sourceRowNumber ?? line.id} needs a mapped CSV ${field.toUpperCase()} choice.`);
        if (field === "price" && !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(raw)) throw new Error(`New variant row ${line.sourceRowNumber ?? line.id} has an invalid price.`);
        approvedFields[field] = raw;
      }
      for (const field of ["size", "color"] as const) {
        if (decision.fields[field] === "USE_CSV") {
          const value = normalized(line[field]);
          if (!mapping.has(field) || !value) throw new Error(`New variant row ${line.sourceRowNumber ?? line.id} needs a mapped ${field} value.`);
          approvedFields[field] = value;
        }
      }
      plannedItems.push({ lineId: line.id, disposition: "CREATE", productId: null, variantId: null, sku, price: priceRaw, optionValues: [], approvedFields, reason: null });
      continue;
    }
    const productId = review.shopifyProductId;
    if (!productId) throw new Error("The confirmed Update review has no Shopify product identity. Compare again before executing.");
    const candidates = snapshotVariants.filter((variant) => variant.productId === productId && normalized(variant.sku) === sku);
    if (candidates.length !== 1) {
      plannedItems.push({ lineId: line.id, disposition: "CONFLICT", productId, variantId: null, sku, price: null, optionValues: [], approvedFields: {}, reason: candidates.length ? "The Shopify SKU is ambiguous within the matched product." : "The current Shopify variant is missing; execution will not create it under an Update review." });
      continue;
    }
    const current = candidates[0]!;
    for (const field of ["sku", "price"] as const) {
      if (decision.fields[field] !== "USE_CSV") continue;
      const raw = field === "sku" ? sku : priceRaw;
      if (!mapping.has(field) || !raw) throw new Error(`Updated variant row ${line.sourceRowNumber ?? line.id} is missing its mapped ${field.toUpperCase()} value.`);
      if (field === "price" && !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(raw)) throw new Error(`Updated variant row ${line.sourceRowNumber ?? line.id} has an invalid price.`);
      if (field === "sku" ? raw !== (current.sku ?? "") : canonicalCatalogPrice(raw) !== canonicalCatalogPrice(current.price)) approvedFields[field] = raw;
    }
    plannedItems.push({ lineId: line.id, disposition: Object.keys(approvedFields).length ? "UPDATE" : "SKIP", productId, variantId: current.id, sku, price: priceRaw, optionValues: [], approvedFields, reason: Object.keys(approvedFields).length ? null : "No approved variant field differs from Shopify." });
  }

  if (review.operation === "CREATE") {
    const createItems = plannedItems.filter((item) => item.disposition === "CREATE");
    if (!createItems.length) return { disposition: "SKIP", reason: "No variants were selected for creation.", productId: null, productCreate: null, productUpdate: {}, variantUpdates: [], items: plannedItems };
    if (createItems.length > 250) {
      const reason = "This Create group exceeds the safe 250-variant execution limit. Split it into smaller groups before execution.";
      return { disposition: "CONFLICT", reason, productId: null, productCreate: null, productUpdate: {}, variantUpdates: [], items: plannedItems.map((item) => item.disposition === "CREATE" ? { ...item, disposition: "CONFLICT", reason } : item) };
    }
    if (snapshotVariants.some((variant) => variant.productTitle.trim().toLocaleLowerCase() === productValues.title.trim().toLocaleLowerCase())) {
      return { disposition: "CONFLICT", reason: "A product with the proposed title now exists in Shopify. Compare again before executing.", productId: null, productCreate: null, productUpdate: {}, variantUpdates: [], items: plannedItems.map((item) => ({ ...item, disposition: "CONFLICT", reason: "The fresh Shopify snapshot is no longer a safe Create." })) };
    }
    if (decisions.productFields.title !== "USE_CSV" || !mapping.has("productName") || !productValues.title) throw new Error("A new product needs a mapped CSV title explicitly approved as Use CSV.");
    const requiredOptionFields = (["size", "color"] as const).filter((field) => active.some((line) => normalized(line[field])));
    for (const line of active) {
      const decision = decisions.variants[line.id]!;
      for (const field of requiredOptionFields) {
        if (decision.fields[field] !== "USE_CSV" || !mapping.has(field) || !normalized(line[field])) {
          const row = line.sourceRowNumber ?? line.id;
          throw new Error(`New product row ${row} needs an explicitly approved mapped ${field === "size" ? "Size" : "Color"} option value.`);
        }
      }
    }
    const optionDimensions = requiredOptionFields;
    if (createItems.length > 1 && !optionDimensions.length) throw new Error("Multiple new variants need Size or Color option values before execution.");
    for (const item of createItems) {
      for (const field of optionDimensions) {
        const value = normalized(item.approvedFields[field]);
        if (!value) throw new Error(`Every new variant needs a value for the ${field} option.`);
        item.optionValues.push({ optionName: field === "size" ? "Size" : "Color", name: value });
      }
    }
    const combinations = new Set<string>();
    for (const item of createItems) {
      const key = optionDimensions.map((field) => normalized(item.approvedFields[field]).toLocaleLowerCase()).join("\u0000");
      if (combinations.has(key)) throw new Error("The confirmed Create contains duplicate Size/Color combinations. Correct the grouping before execution.");
      combinations.add(key);
    }
    const options = optionDimensions.map((field) => {
      const values = [...new Set(createItems.map((item) => normalized(item.approvedFields[field])))];
      return { name: field === "size" ? "Size" : "Color", values: values.map((name) => ({ name })) };
    });
    const first = createItems[0]!;
    const productCreate: Record<string, unknown> = {
      title: productValues.title,
      status: "DRAFT",
      ...(productValues.description && decisions.productFields.description === "USE_CSV" ? { descriptionHtml: productValues.description } : {}),
      ...(productValues.vendor && decisions.productFields.vendor === "USE_CSV" ? { vendor: productValues.vendor } : {}),
      ...(productValues.productType && decisions.productFields.productType === "USE_CSV" ? { productType: productValues.productType } : {}),
      ...(options.length ? { productOptions: options } : {}),
      tags: [],
    };
    // The first approved CSV combination is ordered first in each option list,
    // so Shopify's auto-created standalone variant can be preserved and assigned.
    for (const option of options) {
      const values = option.values as Array<{ name: string }>;
      const firstValue = first.optionValues.find((entry) => entry.optionName === option.name)?.name;
      if (firstValue) { option.values = [{ name: firstValue }, ...values.filter((value) => value.name !== firstValue)]; }
    }
    return { disposition: "CREATE", reason: "Confirmed Create; product will be Draft and only approved variant data will be sent.", productId: null, productCreate, productUpdate: {}, variantUpdates: [], items: plannedItems };
  }

  if (plannedItems.some((item) => item.disposition === "CONFLICT")) {
    return { disposition: "CONFLICT", reason: "One or more Update targets are missing or ambiguous. No Shopify changes will be sent.", productId: review.shopifyProductId, productCreate: null, productUpdate: {}, variantUpdates: [], items: plannedItems };
  }
  const matchedProduct = snapshotVariants.find((variant) => variant.productId === review.shopifyProductId);
  if (!matchedProduct) return { disposition: "CONFLICT", reason: "The matched Shopify product is missing from the fresh snapshot.", productId: review.shopifyProductId, productCreate: null, productUpdate: {}, variantUpdates: [], items: plannedItems };
  for (const field of ["title", "description", "vendor", "productType"] as const) {
    if (decisions.productFields[field] !== "USE_CSV") continue;
    const value = productValues[field];
    if (!mapping.has(productSource[field]) || !value) throw new Error(`The approved ${field} value is no longer mapped. Save fresh review decisions before execution.`);
    const current = field === "title" ? matchedProduct.productTitle : field === "description" ? matchedProduct.productDescription : field === "vendor" ? matchedProduct.vendor : matchedProduct.productType;
    const currentForComparison = current ?? "";
    if (value !== currentForComparison) {
      const targetField = field === "description" ? "descriptionHtml" : field;
      productUpdate[targetField] = value;
      originalProductFields[targetField] = current;
    }
  }
  const variantUpdates = plannedItems.filter((item) => item.disposition === "UPDATE" && item.variantId).map((item) => ({
    id: item.variantId!,
    ...(item.approvedFields.sku ? { sku: item.approvedFields.sku } : {}),
    ...(item.approvedFields.price ? { price: item.approvedFields.price } : {}),
  })).filter((variant) => Object.keys(variant).length > 1);
  const originalVariantFields: NonNullable<CatalogExecutionPlan["originalVariantFields"]> = {};
  for (const item of plannedItems.filter((candidate) => candidate.disposition === "UPDATE" && candidate.variantId)) {
    const current = snapshotVariants.find((variant) => variant.id === item.variantId && variant.productId === review.shopifyProductId);
    if (!current) continue;
    originalVariantFields[item.variantId!] = {
      ...(Object.hasOwn(item.approvedFields, "sku") ? { sku: current.sku } : {}),
      ...(Object.hasOwn(item.approvedFields, "price") ? { price: current.price } : {}),
    };
  }
  if (variantUpdates.length > 250) {
    const reason = "This Update group exceeds the safe 250-variant execution limit. Split it into smaller groups before execution.";
    return { disposition: "CONFLICT", reason, productId: review.shopifyProductId, productCreate: null, productUpdate: {}, variantUpdates: [], items: plannedItems.map((item) => item.disposition === "UPDATE" ? { ...item, disposition: "CONFLICT", reason } : item) };
  }
  const hasMutation = Object.keys(productUpdate).length > 0 || variantUpdates.length > 0;
  return { disposition: hasMutation ? "UPDATE" : "SKIP", reason: hasMutation ? "Only explicitly approved changed fields will be updated." : "No approved changes differ from Shopify.", productId: review.shopifyProductId, productCreate: null, productUpdate, variantUpdates, originalProductFields, originalVariantFields, items: plannedItems };
}
