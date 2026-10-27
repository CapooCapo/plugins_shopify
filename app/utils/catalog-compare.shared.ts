export type CatalogCompareField = "title" | "description" | "vendor" | "productType" | "sku" | "price" | "size" | "color";
export type CatalogCompareDisposition = "CREATE" | "UPDATE" | "SKIP" | "CONFLICT";
export type CatalogFieldChange = { field: CatalogCompareField; current: string | null; proposed: string | null; action: "SET" | "PRESERVE" | "CLEAR"; rowId?: string; rowNumber?: number | null; reason?: string };
export type CatalogShopifyVariant = { id: string; sku: string | null; price: string | null; selectedOptions: Array<{ name: string; value: string }>; productId: string; productTitle: string; productDescription: string | null; vendor: string | null; productType: string | null; productOptions: Array<{ name: string; values: string[] }> };
export type CatalogCompareRow = { id: string; groupId: string; sourceRowNumber?: number | null; title: string; sku: string; price: string | null; size: string | null; color: string | null; description: string | null; vendor: string | null; productType: string | null; confirmed: boolean; quality: "READY" | "WARNING" | "ERROR"; fields: Partial<Record<CatalogCompareField, { value: string | null; mapped: boolean; explicitlyClear?: boolean }>> };
export type CatalogChangeProposal = { groupId: string; groupTitle: string; disposition: CatalogCompareDisposition; eligible: boolean; quality?: "READY" | "WARNING" | "ERROR"; reason: string; productId: string | null; variantId: string | null; changes: CatalogFieldChange[]; rowIds: string[] };

const fieldValue = (row: CatalogCompareRow, field: CatalogCompareField, fallback: string | null) => {
  const intent = row.fields[field];
  if (!intent || !intent.mapped) return { value: fallback, action: "PRESERVE" as const, reason: "Field was not mapped; preserve the Shopify value." };
  if (intent.explicitlyClear) return { value: null, action: "CLEAR" as const, reason: "Merchant explicitly selected clear." };
  if (intent.value === null || intent.value === "") return { value: fallback, action: "PRESERVE" as const, reason: "Mapped cell is empty; empty values do not clear existing Shopify data." };
  return { value: intent.value, action: "SET" as const };
};

/** Pure deterministic comparison. SKU matching is trimmed but case-sensitive. */
export function compareCatalogGroups(rows: readonly CatalogCompareRow[], existing: readonly CatalogShopifyVariant[]): CatalogChangeProposal[] {
  const bySku = new Map<string, CatalogShopifyVariant[]>();
  for (const item of existing) {
    const sku = item.sku?.trim();
    if (sku) bySku.set(sku, [...(bySku.get(sku) ?? []), item]);
  }
  const groups = new Map<string, CatalogCompareRow[]>();
  for (const row of rows) groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), row]);
  const result: CatalogChangeProposal[] = [];
  for (const [groupId, members] of groups) {
    const title = members[0]?.title ?? "Untitled product";
    const blocked = members.some((row) => !row.confirmed || row.quality === "ERROR");
    const matches = members.flatMap((row) => bySku.get(row.sku.trim()) ?? []);
    const uniqueMatch = new Map(matches.map((match) => [match.id, match]));
    const products = new Set([...uniqueMatch.values()].map((item) => item.productId));
    const conflict = (reason: string): CatalogChangeProposal => ({ groupId, groupTitle: title, disposition: "CONFLICT", eligible: false, reason, productId: null, variantId: null, changes: [], rowIds: members.map((row) => row.id) });
    if (blocked) {
      result.push({ groupId, groupTitle: title, disposition: "SKIP", eligible: false, reason: members.some((row) => !row.confirmed) ? "Group is not confirmed; confirm it before it can be eligible." : "Resolve catalog quality errors before comparison can be eligible.", productId: null, variantId: null, changes: [], rowIds: members.map((row) => row.id) });
      continue;
    }
    if (members.some((row) => !row.sku.trim())) { result.push(conflict("Every proposed variant needs a SKU for matching.")); continue; }
    if ([...uniqueMatch.values()].some((item) => (bySku.get(item.sku?.trim() ?? "") ?? []).length > 1)) { result.push(conflict("An exact SKU matches multiple Shopify variants; resolve the duplicate in Shopify first.")); continue; }
    if (products.size > 1) { result.push(conflict("The draft group’s SKUs match variants in different Shopify products.")); continue; }
    if (uniqueMatch.size === 0) {
      const sameTitle = existing.filter((item) => item.productTitle.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase());
      if (sameTitle.length) { result.push(conflict("A product with the same title exists, but SKU identity is ambiguous. Review it manually.")); continue; }
      const changes = members.flatMap((row) => (Object.keys(row.fields) as CatalogCompareField[]).flatMap((field) => {
        const proposed = fieldValue(row, field, null);
        return proposed.action === "SET" && proposed.value !== null ? [{ field, current: null, proposed: proposed.value, action: "SET" as const, rowId: row.id, rowNumber: row.sourceRowNumber }] : [];
      }));
      result.push({ groupId, groupTitle: title, disposition: "CREATE", eligible: false, reason: members.some((row) => !row.price?.trim()) ? "No exact SKU match. Candidate only; add a valid Price before future product creation, then recheck Shopify." : "No exact SKU match. Candidate only; future execution must recheck current Shopify state.", productId: null, variantId: null, changes, rowIds: members.map((row) => row.id) });
      continue;
    }
    const matchedProductId = [...products][0]!;
    const productVariants = existing.filter((item) => item.productId === matchedProductId);
    const changes: CatalogFieldChange[] = [];
    const conflictingIdentities = members.some((row) => row.title.trim().toLocaleLowerCase() !== productVariants[0]?.productTitle.trim().toLocaleLowerCase());
    if (conflictingIdentities) { result.push(conflict("Draft product title differs from the matched Shopify product; identity requires merchant review.")); continue; }
    for (const row of members) {
      const variant = bySku.get(row.sku.trim())?.find((item) => item.productId === matchedProductId);
      const identity = variant ?? productVariants[0]!;
      for (const [field, current] of [["title", identity.productTitle], ["description", identity.productDescription], ["vendor", identity.vendor], ["productType", identity.productType], ["sku", variant?.sku ?? null], ["price", variant?.price ?? null], ["size", variant?.selectedOptions.find((option) => option.name.toLowerCase() === "size")?.value ?? null], ["color", variant?.selectedOptions.find((option) => option.name.toLowerCase() === "color")?.value ?? null]] as Array<[CatalogCompareField, string | null]>) {
        const proposed = fieldValue(row, field, current);
        if ((proposed.action === "SET" || proposed.action === "CLEAR") && proposed.value !== current) changes.push({ field, current, proposed: proposed.value, action: proposed.action, rowId: row.id, rowNumber: row.sourceRowNumber, reason: proposed.reason });
      }
    }
    if (!members.every((row) => bySku.has(row.sku.trim()))) {
      const missing = members.filter((row) => !bySku.has(row.sku.trim()));
      const optionNames = [...new Set(productVariants.flatMap((variant) => variant.productOptions.map((option) => option.name).filter((name) => name.toLowerCase() !== "title")))];
      const supportsOptions = optionNames.length > 0 && optionNames.length <= 3 &&
        (!missing.some((row) => row.size?.trim()) || optionNames.some((name) => name.toLowerCase() === "size")) &&
        (!missing.some((row) => row.color?.trim()) || optionNames.some((name) => name.toLowerCase() === "color")) &&
        missing.every((row) => optionNames.every((name) => Boolean((name.toLowerCase() === "size" ? row.size : name.toLowerCase() === "color" ? row.color : null)?.trim())));
      if (!supportsOptions) { result.push(conflict("A matching product’s option structure cannot safely accept the proposed variant values.")); continue; }
      const combinationKey = (options: Array<{ name: string; value: string }>) => optionNames.map((name) => `${name.toLowerCase()}=${options.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value.trim().toLocaleLowerCase() ?? ""}`).join("|");
      const existingCombinations = new Set(productVariants.map((variant) => combinationKey(variant.selectedOptions)));
      const proposedCombinations = missing.map((row) => combinationKey(optionNames.map((name) => ({ name, value: name.toLowerCase() === "size" ? row.size ?? "" : name.toLowerCase() === "color" ? row.color ?? "" : "" }))));
      if (proposedCombinations.some((key) => existingCombinations.has(key)) || new Set(proposedCombinations).size !== proposedCombinations.length) { result.push(conflict("A proposed variant duplicates an existing or draft option combination.")); continue; }
      result.push({ groupId, groupTitle: title, disposition: "UPDATE", eligible: false, reason: "Existing product has a new Size/Color combination. Proposed variant addition requires explicit review.", productId: matchedProductId, variantId: null, changes, rowIds: members.map((row) => row.id) });
      continue;
    }
    const dedupedChanges = [...new Map(changes.map((change) => [`${change.rowId ?? ""}:${change.field}:${change.current ?? ""}:${change.proposed ?? ""}:${change.action}`, change])).values()];
    result.push({ groupId, groupTitle: title, disposition: "UPDATE", eligible: false, reason: dedupedChanges.length ? "Exact SKU match and product title verified. Review field-level differences; execution is not implemented in this PR." : "Exact SKU match and product title verified; no mapped field differences were found.", productId: matchedProductId, variantId: uniqueMatch.size === 1 ? [...uniqueMatch.values()][0]!.id : null, changes: dedupedChanges, rowIds: members.map((row) => row.id) });
  }
  return result.map((proposal) => ({ ...proposal, quality: membersQuality(groups.get(proposal.groupId) ?? []) }));
}

function membersQuality(rows: readonly CatalogCompareRow[]): "READY" | "WARNING" | "ERROR" {
  if (rows.some((row) => row.quality === "ERROR")) return "ERROR";
  if (rows.some((row) => row.quality === "WARNING")) return "WARNING";
  return "READY";
}
