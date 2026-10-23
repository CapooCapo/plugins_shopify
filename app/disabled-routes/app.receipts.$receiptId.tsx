import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  addWrongItemException,
  confirmReceiptInspection,
  loadReceiptInspectionPreview,
  markAllEligibleAccepted,
  prepareReceiptInspection,
  ReceiptInspectionError,
  saveReceiptInspectionLine,
} from "../utils/receiving-inspection.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const preview = await loadReceiptInspectionPreview(admin, { shop: session.shop, receiptId: params.receiptId ?? "" });
  return { ...preview, shop: session.shop, wrongItemRequestId: crypto.randomUUID() };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const receiptId = params.receiptId ?? "";
  const form = await request.formData();
  try {
    const intent = String(form.get("intent") ?? "");
    if (intent === "prepare") {
      const result = await prepareReceiptInspection({ shop: session.shop, receiptId });
      return { ok: true, message: `Inspection prepared: ${result.createdLines} line(s); ${result.preservedErrors} source error(s) retained as exceptions.` };
    }
    if (intent === "saveLine") {
      await saveReceiptInspectionLine({ shop: session.shop, receiptId, lineId: String(form.get("lineId") ?? ""), acceptedQty: form.get("acceptedQty"), damagedQty: form.get("damagedQty"), onHoldQty: form.get("onHoldQty") });
      return { ok: true, message: "Inspection quantities saved." };
    }
    if (intent === "markAll") {
      const result = await markAllEligibleAccepted({ shop: session.shop, receiptId });
      return { ok: true, message: `Marked ${result.acceptedLines} exact existing Variant line(s) as Accepted; ${result.excludedLines} unresolved line(s) remain unchanged.` };
    }
    if (intent === "wrongItem") {
      await addWrongItemException({ shop: session.shop, receiptId, requestId: String(form.get("requestId") ?? ""), description: String(form.get("description") ?? ""), suspectedSku: String(form.get("suspectedSku") ?? ""), quantity: form.get("quantity"), reason: String(form.get("reason") ?? ""), disposition: String(form.get("disposition") ?? "HOLD") as "HOLD" | "RETURN" });
      return { ok: true, message: "Wrong Item exception recorded separately from expected SKUs." };
    }
    if (intent === "confirm") {
      const preview = await loadReceiptInspectionPreview(admin, { shop: session.shop, receiptId });
      const result = await confirmReceiptInspection({ shop: session.shop, receiptId, snapshots: preview.snapshots });
      return { ok: true, message: result.alreadyConfirmed ? "Receipt was already confirmed. No duplicate operation was created." : `Receipt confirmed. ${result.operations.length} accepted-quantity operation(s) are PENDING; Shopify inventory has not been changed.` };
    }
    return { ok: false, error: "Unknown Receipt action." };
  } catch (error) {
    return { ok: false, error: error instanceof ReceiptInspectionError ? error.message : "Could not update Receipt inspection." };
  }
}

export default function ReceiptInspection() {
  const { receipt, lines, exceptions, shop, wrongItemRequestId } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const confirmed = receipt.status === "CONFIRMED";
  const totals = lines.reduce((sum, line) => ({ received: sum.received + line.receivedQty, accepted: sum.accepted + line.acceptedQty, damaged: sum.damaged + line.damagedQty, onHold: sum.onHold + line.onHoldQty, proposed: sum.proposed + (line.proposedDelta ?? 0) }), { received: 0, accepted: 0, damaged: 0, onHold: 0, proposed: 0 });
  return <s-page heading={`Receipt ${receipt.id}`} inlineSize="large"><div className="stockhub-page">
    <Link to={`/app/shipments/${receipt.shipmentId}`}>← Shipment {receipt.shipmentId}</Link>
    {result?.error ? <s-banner tone="critical">{result.error}</s-banner> : null}
    {result?.message ? <s-banner tone="success">{result.message}</s-banner> : null}
    <s-banner tone={confirmed ? "warning" : "info"}>{confirmed ? "Confirmed source and inspection data are immutable. Shopify sync is pending/not enabled; no inventory mutation was made." : "Draft inspection. Shopify inventory shown below is a read-only snapshot; confirmation only records the receipt and creates PENDING operation records."}</s-banner>
    <s-section heading="Receipt context"><dl>
      <dt>Shop</dt><dd>{shop}</dd><dt>Shipment</dt><dd>{receipt.shipmentId} — {receipt.shipment.reference}</dd>
      <dt>Location</dt><dd>{receipt.locationName}</dd><dt>Status</dt><dd>{receipt.status}</dd>
      <dt>Created</dt><dd>{new Date(receipt.createdAt).toLocaleString()}</dd>
      {receipt.confirmedAt ? <><dt>Confirmed</dt><dd>{new Date(receipt.confirmedAt).toLocaleString()}</dd></> : null}
    </dl></s-section>
    {!confirmed && !lines.length ? <s-section heading="Prepare received goods"><s-paragraph>Load the persisted Received Goods rows into inspection. Invalid source rows remain visible as exceptions; this action does not confirm receipt or change Shopify.</s-paragraph><Form method="post"><input type="hidden" name="intent" value="prepare" /><s-button type="submit">Prepare Inspection</s-button></Form></s-section> : null}
    <s-section heading="Quality inspection">
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
        <s-box border="base" padding="base"><s-text>Physical received</s-text><s-heading>{totals.received}</s-heading></s-box>
        <s-box border="base" padding="base"><s-text>Accepted</s-text><s-heading>{totals.accepted}</s-heading></s-box>
        <s-box border="base" padding="base"><s-text>Damaged</s-text><s-heading>{totals.damaged}</s-heading></s-box>
        <s-box border="base" padding="base"><s-text>On Hold</s-text><s-heading>{totals.onHold}</s-heading></s-box>
        <s-box border="base" padding="base"><s-text>Proposed Shopify delta</s-text><s-heading>+{totals.proposed}</s-heading></s-box>
      </s-grid>
      {!confirmed && lines.length ? <Form method="post"><input type="hidden" name="intent" value="markAll" /><s-button type="submit" variant="secondary">Mark all eligible as Accepted</s-button></Form> : null}
      {!lines.length ? <s-paragraph>No valid received rows are prepared.</s-paragraph> : <s-table><s-table-header-row><s-table-header>SKU / Product</s-table-header><s-table-header>Match</s-table-header><s-table-header>Physical received</s-table-header><s-table-header>Accepted</s-table-header><s-table-header>Damaged</s-table-header><s-table-header>On Hold</s-table-header><s-table-header>Shopify snapshot</s-table-header><s-table-header>Source row</s-table-header></s-table-header-row><s-table-body>
        {lines.map((line) => <s-table-row key={line.id}><s-table-cell>{line.sku || "(missing SKU)"}{line.productName ? <><br />{line.productName}</> : null}</s-table-cell><s-table-cell>{line.matchOutcome}{line.matchedVariantId ? <><br />{line.matchedVariantId}</> : null}</s-table-cell><s-table-cell>{line.receivedQty}</s-table-cell>
          {confirmed ? <><s-table-cell>{line.acceptedQty}</s-table-cell><s-table-cell>{line.damagedQty}</s-table-cell><s-table-cell>{line.onHoldQty}</s-table-cell></> : <s-table-cell><Form method="post"><input type="hidden" name="intent" value="saveLine" /><input type="hidden" name="lineId" value={line.id} /><label>Accepted <input name="acceptedQty" type="number" min="0" max={line.receivedQty} defaultValue={line.acceptedQty} required /></label><label>Damaged <input name="damagedQty" type="number" min="0" max={line.receivedQty} defaultValue={line.damagedQty} required /></label><label>On Hold <input name="onHoldQty" type="number" min="0" max={line.receivedQty} defaultValue={line.onHoldQty} required /></label><s-button type="submit" variant="secondary">Save quantities</s-button></Form></s-table-cell>}
          <s-table-cell>{line.proposedDelta === null ? "No Shopify adjustment proposed" : <>{line.currentAvailable === null ? `Snapshot unavailable${line.snapshotReason ? `: ${line.snapshotReason}` : ""}` : `${line.currentAvailable} available at snapshot (${line.snapshotTakenAt?.toLocaleString()})`}<br />Proposed delta: +{line.proposedDelta}{line.projectedAvailable === null ? "" : ` → ${line.projectedAvailable}`}</>}</s-table-cell>
          <s-table-cell>{line.sourceRow?.rowNumber ?? "—"}</s-table-cell></s-table-row>)}
      </s-table-body></s-table>}
      {lines.length ? <s-paragraph>Received = Accepted + Damaged + On Hold is required before confirming. Only Accepted exact existing Variants receive future PENDING operations. Inventory figures are a point-in-time Shopify read, not a reservation or guarantee.</s-paragraph> : null}
    </s-section>
    <s-section heading="Exceptions">
      {exceptions.length ? <s-table><s-table-header-row><s-table-header>Type</s-table-header><s-table-header>Source row</s-table-header><s-table-header>Quantity</s-table-header><s-table-header>Suspected SKU</s-table-header><s-table-header>Reason</s-table-header><s-table-header>Status</s-table-header></s-table-header-row><s-table-body>{exceptions.map((exception) => <s-table-row key={exception.id}><s-table-cell>{exception.type}</s-table-cell><s-table-cell>{exception.sourceRow?.rowNumber ?? "—"}</s-table-cell><s-table-cell>{exception.quantity ?? "—"}</s-table-cell><s-table-cell>{exception.suspectedSku || "—"}</s-table-cell><s-table-cell>{exception.reason}{exception.disposition ? ` (${exception.disposition})` : ""}</s-table-cell><s-table-cell>{exception.status}</s-table-cell></s-table-row>)}</s-table-body></s-table> : <s-paragraph>No exceptions.</s-paragraph>}
      {!confirmed ? <Form method="post"><input type="hidden" name="intent" value="wrongItem" /><input type="hidden" name="requestId" value={wrongItemRequestId} /><s-heading>Add wrong item</s-heading><s-text-field label="Observed item / description" name="description" required /><s-text-field label="Suspected SKU (optional)" name="suspectedSku" /><label>Quantity <input name="quantity" type="number" min="1" required /></label><s-text-field label="Reason" name="reason" required /><s-select label="Disposition" name="disposition"><s-option value="HOLD">Hold</s-option><s-option value="RETURN">Return</s-option></s-select><s-button type="submit" variant="secondary">Record wrong item</s-button></Form> : null}
    </s-section>
    {!confirmed ? <s-section heading="Final preview and confirmation"><s-paragraph>Confirming freezes source and inspection records, records exceptions, and creates one stable PENDING operation per accepted exact Variant line. It does not write to Shopify.</s-paragraph><Form method="post"><input type="hidden" name="intent" value="confirm" /><s-button type="submit" variant="primary">Confirm Receipt</s-button></Form></s-section> : null}
    {receipt.inventoryOperations.length ? <s-section heading="Future Shopify operations"><s-table><s-table-header-row><s-table-header>Operation</s-table-header><s-table-header>Variant</s-table-header><s-table-header>Location</s-table-header><s-table-header>Accepted delta</s-table-header><s-table-header>Status</s-table-header></s-table-header-row><s-table-body>{receipt.inventoryOperations.map((operation) => <s-table-row key={operation.id}><s-table-cell>{operation.operationKey.slice(0, 12)}…</s-table-cell><s-table-cell>{operation.targetVariantId}</s-table-cell><s-table-cell>{operation.locationId}</s-table-cell><s-table-cell>+{operation.acceptedDelta}</s-table-cell><s-table-cell>{operation.status}</s-table-cell></s-table-row>)}</s-table-body></s-table><s-paragraph>These are records only. No Shopify inventory mutation or automatic retry occurs in Sprint 3.</s-paragraph></s-section> : null}
  </div></s-page>;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
