import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createReceivingImport, confirmExpectedGoods, lookupReceivingRowMatch, recordReceivingMatchDecision, confirmExistingVariantMatch, proposeNewVariant, saveProductProposalGroup, splitProductProposalRow, confirmProductProposalGroup, confirmDuplicateSkuMerge, ReceivingImportError } from "../utils/receiving-import.server";
import type { ReceivingCsvField } from "../utils/csv.server.ts";
import prisma from "../db.server.ts";
import { MAX_CSV_BYTES } from "../utils/csv.server.ts";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shipment = await prisma.shipment.findFirst({ where: { shop: session.shop, id: params.shipmentId }, include: { receipts: { where: { status: "DRAFT" }, orderBy: { createdAt: "desc" } }, importAttempts: { where: { shop: session.shop }, include: { rows: { orderBy: { rowNumber: "asc" } }, proposalGroups: { include: { rows: { orderBy: { rowNumber: "asc" } } } } }, orderBy: { createdAt: "desc" }, take: 5 } } });
  if (!shipment) throw new Response("Shipment not found", { status: 404 });
  return { shipment };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  try {
    const form = await request.formData();
    const intent = String(form.get("intent") ?? "upload");
    if (intent === "confirmExpected") {
      const confirmed = await confirmExpectedGoods({ shop: session.shop, attemptId: String(form.get("attemptId") ?? "") });
      return { ok: true as const, duplicateWarning: false, preview: null, status: confirmed.alreadyConfirmed ? "EXPECTED_CONFIRMED" : "EXPECTED_CONFIRMED", message: confirmed.alreadyConfirmed ? "This Expected Goods preview was already confirmed; no quantities were applied again." : `Expected Goods confirmed: ${confirmed.appliedSkus} SKU plan entries applied, ${confirmed.skippedRows} invalid or unconfirmed duplicate source rows skipped.` };
    }
    if (intent === "match") {
      const matched = await lookupReceivingRowMatch(admin, { shop: session.shop, attemptId: String(form.get("attemptId") ?? ""), rowId: String(form.get("rowId") ?? "") });
      return { ok: true as const, duplicateWarning: false, preview: null, proposalCandidates: matched, message: `Shopify SKU lookup recorded: ${matched.outcome}. No Shopify changes were made.` };
    }
    if (intent === "confirmExisting") {
      const [productId, variantId] = String(form.get("selection") ?? "").split("|");
      await confirmExistingVariantMatch(admin, { shop: session.shop, attemptId: String(form.get("attemptId") ?? ""), rowId: String(form.get("rowId") ?? ""), productId: productId ?? "", variantId: variantId ?? "" });
      return { ok: true as const, duplicateWarning: false, preview: null, message: "Exact Shopify variant match confirmed and persisted. No Shopify changes were made." };
    }
    if (intent === "proposeVariant") {
      await proposeNewVariant(admin, { shop: session.shop, attemptId: String(form.get("attemptId") ?? ""), rowId: String(form.get("rowId") ?? ""), productId: String(form.get("productId") ?? ""), optionValuesJson: String(form.get("optionValuesJson") ?? "") });
      return { ok: true as const, duplicateWarning: false, preview: null, message: "Parent Product and non-duplicate option combination saved as a proposal. No Shopify changes were made." };
    }
    if (intent === "saveGroup") {
      await saveProductProposalGroup({ shop: session.shop, attemptId: String(form.get("attemptId") ?? ""), rowId: String(form.get("rowId") ?? ""), groupKey: String(form.get("groupKey") ?? ""), productName: String(form.get("productName") ?? "") });
      return { ok: true as const, duplicateWarning: false, preview: null, message: "Source row assigned to a Product proposal group. Confirm the group when its variants are ready; no Shopify changes were made." };
    }
    if (intent === "splitGroup") {
      await splitProductProposalRow({ shop: session.shop, attemptId: String(form.get("attemptId") ?? ""), rowId: String(form.get("rowId") ?? "") });
      return { ok: true as const, duplicateWarning: false, preview: null, message: "Source row split into its own proposal group; review and confirm it separately." };
    }
    if (intent === "confirmGroup") {
      await confirmProductProposalGroup({ shop: session.shop, attemptId: String(form.get("attemptId") ?? ""), groupId: String(form.get("groupId") ?? "") });
      return { ok: true as const, duplicateWarning: false, preview: null, message: "Grouped NEW_PRODUCT proposal confirmed from its preserved source rows. No Shopify product was created." };
    }
    if (intent === "mergeDuplicates") {
      const merged = await confirmDuplicateSkuMerge({ shop: session.shop, attemptId: String(form.get("attemptId") ?? ""), rowId: String(form.get("rowId") ?? "") });
      return { ok: true as const, duplicateWarning: false, preview: null, message: `Explicitly grouped ${merged.count} duplicate rows (${merged.sourceRows.join(", ")}) with aggregate quantity ${merged.aggregateQuantity}; source rows remain intact.` };
    }
    if (intent === "decision") {
      await recordReceivingMatchDecision({ shop: session.shop, attemptId: String(form.get("attemptId") ?? ""), rowId: String(form.get("rowId") ?? ""), decision: String(form.get("decision") ?? "") });
      return { ok: true as const, duplicateWarning: false, preview: null, message: "Review decision saved. This records a proposal only; no Shopify changes were made." };
    }
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw new ReceivingImportError("Choose a CSV file.");
    if (file.size > MAX_CSV_BYTES) throw new ReceivingImportError(`CSV exceeds ${MAX_CSV_BYTES} bytes.`);
    const mode = String(form.get("mode") ?? "");
    if (mode !== "EXPECTED" && mode !== "RECEIVED") throw new ReceivingImportError("Choose Expected Goods or Received Goods.");
    const mapping: Partial<Record<ReceivingCsvField, string>> = {};
    for (const field of ["sku", "quantity", "productName", "productGroup", "size", "color", "price", "barcode"] as ReceivingCsvField[]) {
      const header = String(form.get(`${field}Header`) ?? "").trim();
      if (header) mapping[field] = header;
    }
    const result = await createReceivingImport({ shop: session.shop, shipmentId: params.shipmentId ?? "", receiptId: String(form.get("receiptId") ?? "") || null, mode, fileName: file.name, source: await file.text(), mapping });
    return { ok: true as const, mode, ...result, message: result.duplicateWarning ? "This exact file was already imported in this context. Duplicate warning only; no quantities were applied." : `${mode === "EXPECTED" ? "Expected Goods preview saved" : "Import saved"} (${result.preview.rows.filter((row) => !row.errors.length).length} valid, ${result.preview.rows.filter((row) => row.errors.length).length} needing correction).` };
  } catch (error) {
    return { ok: false as const, error: error instanceof ReceivingImportError ? error.message : "Could not save this import." };
  }
}

export default function ShipmentImport() {
  const { shipment } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const latestLookup = result?.ok === true && "proposalCandidates" in result ? result.proposalCandidates : null;
  return <s-page heading={`Import to ${shipment.id}`} inlineSize="large"><div className="stockhub-page">
    <Link to={`/app/shipments/${shipment.id}`}>← Shipment</Link>
    {result?.error ? <s-banner tone="critical">{result.error}</s-banner> : null}
    {result?.ok === true ? <s-banner tone={result.duplicateWarning ? "warning" : "success"}>{result.message}</s-banner> : null}
    <s-section heading="CSV import"><s-paragraph>Original row values and source line numbers are retained. Row-level errors do not discard other valid rows. No Shopify products or inventory are changed.</s-paragraph>
      <Form method="post" encType="multipart/form-data">
        <s-select label="Import mode" name="mode" required><s-option value="EXPECTED">Expected Goods — Shipment plan only</s-option><s-option value="RECEIVED">Received Goods — Receipt Draft input</s-option></s-select>
        <s-select label="Receipt Draft (required for Received Goods)" name="receiptId"><s-option value="">Choose a Receipt</s-option>{shipment.receipts.map((receipt) => <s-option key={receipt.id} value={receipt.id}>{receipt.id} — {receipt.locationName}</s-option>)}</s-select>
        <input type="file" name="file" accept=".csv,text/csv" required />
        <s-section heading="Optional manual column mapping"><s-paragraph>Leave fields blank to use suggestions from the CSV header. Enter the exact source header to override a suggestion.</s-paragraph>
          <s-text-field label="SKU header" name="skuHeader" /><s-text-field label="Quantity header" name="quantityHeader" /><s-text-field label="Product name header" name="productNameHeader" /><s-text-field label="Product group code header" name="productGroupHeader" /><s-text-field label="Size header" name="sizeHeader" /><s-text-field label="Color header" name="colorHeader" /><s-text-field label="Price header" name="priceHeader" /><s-text-field label="Barcode header" name="barcodeHeader" />
        </s-section>
        <s-button type="submit">Preview and save CSV</s-button>
      </Form>
      {result?.ok === true && result.preview ? <><s-section heading="Column mapping"><s-paragraph>Auto-suggested mapping: {Object.entries(result.preview.mapping).map(([field, header]) => `${field} ← ${header}`).join(" · ")}. Missing SKU/Quantity mapping blocks the file.</s-paragraph></s-section>
        <s-section heading="Rows"><s-table><s-table-header-row><s-table-header>Source row</s-table-header><s-table-header>SKU</s-table-header><s-table-header>Quantity</s-table-header><s-table-header>Validation / decision</s-table-header></s-table-header-row><s-table-body>{result.preview.rows.slice(0, 100).map((row) => <s-table-row key={row.rowNumber}><s-table-cell>{row.rowNumber}</s-table-cell><s-table-cell>{row.sku || "—"}</s-table-cell><s-table-cell>{row.quantity ?? "—"}</s-table-cell><s-table-cell>{row.errors.join(" ") || (row.duplicateDecisionRequired ? "Duplicate SKU: explicit merge decision required." : "Needs product matching/review.")}</s-table-cell></s-table-row>)}</s-table-body></s-table></s-section>
        {result?.ok === true && "mode" in result && result.mode === "EXPECTED" && result.attemptId && result.status === "AWAITING_CONFIRMATION" ? <Form method="post"><input type="hidden" name="intent" value="confirmExpected" /><input type="hidden" name="attemptId" value={result.attemptId} /><s-banner tone="warning">Review the column mapping and all source rows above. Only valid unique rows and explicitly merged duplicate groups will update the Shipment plan.</s-banner><s-button type="submit" variant="primary">Confirm Expected Goods and update Shipment plan</s-button></Form> : null}
        </> : null}
    </s-section>
    {shipment.importAttempts.length ? <s-section heading="Saved import attempts">{shipment.importAttempts.map((attempt) => <s-section key={attempt.id} heading={`${attempt.fileName} — ${attempt.mode} — ${attempt.status}`}>
      <s-paragraph>Saved mapping: {Object.entries(JSON.parse(attempt.mappingJson) as Partial<Record<ReceivingCsvField, string>>).map(([field, header]) => `${field} ← ${header}`).join(" · ") || "No mapped columns"}</s-paragraph>
      {attempt.mode === "EXPECTED" && attempt.status === "AWAITING_CONFIRMATION" ? <Form method="post"><input type="hidden" name="intent" value="confirmExpected" /><input type="hidden" name="attemptId" value={attempt.id} /><s-banner tone="warning">Review the saved mapping and source rows below. The Shipment plan is unchanged until you explicitly confirm.</s-banner><s-button type="submit" variant="primary">Confirm Expected Goods and update Shipment plan</s-button></Form> : null}
      {attempt.proposalGroups.length ? <s-section heading="New Product proposal groups">{attempt.proposalGroups.map((group) => <div key={group.id}><s-paragraph>{group.productName} · group “{group.groupKey}” · {group.rows.length} source rows · {group.status}</s-paragraph>{group.rows.length > 0 && group.status !== "CONFIRMED_PROPOSAL" ? <Form method="post"><input type="hidden" name="intent" value="confirmGroup" /><input type="hidden" name="attemptId" value={attempt.id} /><input type="hidden" name="groupId" value={group.id} /><s-button type="submit" variant="secondary">Confirm grouped Product proposal</s-button></Form> : null}</div>)}</s-section> : null}
      <s-table><s-table-header-row><s-table-header>Row</s-table-header><s-table-header>SKU</s-table-header><s-table-header>Qty</s-table-header><s-table-header>Outcome / reason</s-table-header><s-table-header>Review actions</s-table-header></s-table-header-row><s-table-body>{attempt.rows.map((row) => {
        const stored = row.proposalJson ? JSON.parse(row.proposalJson) as { candidates?: Array<{ id: string; sku: string | null; title: string; product: { id: string; title: string } }>; parentCandidates?: Array<{ id: string; title: string }>; optionValues?: Record<string, string>; productTitle?: string } : {};
        const raw = JSON.parse(row.rawValuesJson) as Record<string, string>;
        const mapping = JSON.parse(attempt.mappingJson) as Partial<Record<ReceivingCsvField, string>>;
        const productName = mapping.productName ? raw[mapping.productName] ?? "" : "";
        const defaultOptions = { ...(mapping.size && raw[mapping.size] ? { Size: raw[mapping.size] } : {}), ...(mapping.color && raw[mapping.color] ? { Color: raw[mapping.color] } : {}) };
        const lookupCandidates = latestLookup?.id === row.id ? latestLookup.candidates : stored.candidates ?? [];
        const parentCandidates = latestLookup?.id === row.id ? latestLookup.parentCandidates : stored.parentCandidates ?? [];
        return <s-table-row key={row.id}><s-table-cell>{row.rowNumber}</s-table-cell><s-table-cell>{row.sku || "—"}</s-table-cell><s-table-cell>{row.quantity ?? "—"}</s-table-cell><s-table-cell>{row.outcome}{row.decision ? ` · ${row.decision}` : ""}{row.decisionReason ? <><br />{row.decisionReason}</> : null}{row.validationJson !== "[]" ? <><br />{JSON.parse(row.validationJson).join(" ")}</> : null}</s-table-cell><s-table-cell>
          <Form method="post"><input type="hidden" name="intent" value="match" /><input type="hidden" name="attemptId" value={attempt.id} /><input type="hidden" name="rowId" value={row.id} /><s-button type="submit" variant="secondary" disabled={!row.sku || JSON.parse(row.validationJson).length > 0 || Boolean(row.decision) || Boolean(row.proposalGroupId)}>Read-only Shopify SKU lookup</s-button></Form>
          {!row.proposalGroupId && (row.outcome === "EXISTING_VARIANT" || row.outcome === "NEEDS_REVIEW") && row.decision !== "EXISTING_VARIANT_CONFIRMED" && lookupCandidates.length ? <Form method="post"><input type="hidden" name="intent" value="confirmExisting" /><input type="hidden" name="attemptId" value={attempt.id} /><input type="hidden" name="rowId" value={row.id} /><label>Choose the exact Product / Variant (manual choice required) <select name="selection" required>{lookupCandidates.map((candidate) => <option key={candidate.id} value={`${candidate.product.id}|${candidate.id}`}>{candidate.product.title} · {candidate.title} · {candidate.sku}</option>)}</select></label><s-button type="submit" variant="secondary">Confirm selected exact variant</s-button></Form> : null}
          {!row.proposalGroupId && (row.outcome === "NEW_PRODUCT" || row.outcome === "NEEDS_REVIEW") && parentCandidates.length ? <Form method="post"><input type="hidden" name="intent" value="proposeVariant" /><input type="hidden" name="attemptId" value={attempt.id} /><input type="hidden" name="rowId" value={row.id} /><label>Parent Product <select name="productId" required>{parentCandidates.map((product) => <option key={product.id} value={product.id}>{product.title}</option>)}</select></label><label>Option combination JSON <input name="optionValuesJson" defaultValue={JSON.stringify(defaultOptions)} required /></label><s-button type="submit" variant="secondary">Validate and save NEW_VARIANT proposal</s-button></Form> : null}
          {!row.proposalGroupId && row.outcome === "NEW_VARIANT" && row.decision === null ? <Form method="post"><input type="hidden" name="intent" value="decision" /><input type="hidden" name="attemptId" value={attempt.id} /><input type="hidden" name="rowId" value={row.id} /><input type="hidden" name="decision" value="NEW_VARIANT" /><s-button type="submit" variant="secondary">Confirm NEW_VARIANT proposal</s-button></Form> : null}
          {row.outcome === "NEW_PRODUCT" && !row.proposalGroupId ? <Form method="post"><input type="hidden" name="intent" value="saveGroup" /><input type="hidden" name="attemptId" value={attempt.id} /><input type="hidden" name="rowId" value={row.id} /><label>Product group key <input name="groupKey" defaultValue={row.productGroup || `row-${row.rowNumber}`} required /></label><label>Proposed Product name <input name="productName" defaultValue={productName} required /></label><s-button type="submit" variant="secondary">Add row to NEW_PRODUCT group</s-button></Form> : null}
          {row.decision === "MERGE_REQUIRED" && !(attempt.mode === "EXPECTED" && attempt.status === "EXPECTED_CONFIRMED") ? <Form method="post"><input type="hidden" name="intent" value="mergeDuplicates" /><input type="hidden" name="attemptId" value={attempt.id} /><input type="hidden" name="rowId" value={row.id} /><s-button type="submit" variant="secondary">Confirm merge of compatible duplicate SKU rows</s-button></Form> : null}
          {row.proposalGroupId ? <Form method="post"><input type="hidden" name="intent" value="splitGroup" /><input type="hidden" name="attemptId" value={attempt.id} /><input type="hidden" name="rowId" value={row.id} /><s-button type="submit" variant="secondary">Split from this Product group and match separately</s-button></Form> : null}
        </s-table-cell></s-table-row>;
      })}</s-table-body></s-table></s-section>)}</s-section> : null}
  </div></s-page>;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
