import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { randomUUID } from "node:crypto";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { formatUtcDateTime } from "../utils/shipment-domain.js";
import { cancelReceiptDraft, createReceiptDraft, closeShipment, getShipment, reopenShipment, ShipmentError } from "../utils/shipments.server";
import { loadShopifyLocationContext } from "../utils/shopify-locations.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const [shipment, locationContext] = await Promise.all([
    getShipment(session.shop, params.shipmentId ?? ""), loadShopifyLocationContext(admin),
  ]);
  if (!shipment) throw new Response("Shipment not found", { status: 404 });
  return { shipment, receiptRequestId: randomUUID(), locations: locationContext.status === "ready" ? locationContext.locations : [], locationMessage: locationContext.status === "ready" ? null : locationContext.message };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    const intent = String(form.get("intent") ?? "");
    if (intent === "receipt") {
      const locationContext = await loadShopifyLocationContext(admin);
      if (locationContext.status !== "ready") throw new ShipmentError("Could not verify active Shopify Locations. Refresh and retry.", "LOCATIONS_UNAVAILABLE");
      const locationId = String(form.get("locationId") ?? "");
      const location = locationContext.locations.find((candidate) => candidate.id === locationId && candidate.isActive);
      if (!location) throw new ShipmentError("Choose an active Location belonging to this Shopify store.", "INVALID_LOCATION");
      const receipt = await createReceiptDraft({ shop: session.shop, shipmentId: params.shipmentId ?? "", locationId: location.id, locationName: location.name, requestId: String(form.get("requestId") ?? "") });
      return { ok: true, message: `Receipt draft ${receipt.id} created for ${location.name}.` };
    }
    if (intent === "close") {
      await closeShipment({ shop: session.shop, shipmentId: params.shipmentId ?? "", reason: String(form.get("reason") ?? "") });
      return { ok: true, message: "Shipment closed. Existing issues and history are retained." };
    }
    if (intent === "cancelReceipt") {
      await cancelReceiptDraft({ shop: session.shop, shipmentId: params.shipmentId ?? "", receiptId: String(form.get("receiptId") ?? ""), reason: String(form.get("reason") ?? "") });
      return { ok: true, message: "Receipt draft cancelled and retained in the timeline." };
    }
    if (intent === "reopen") {
      await reopenShipment({ shop: session.shop, shipmentId: params.shipmentId ?? "", reason: String(form.get("reason") ?? "") });
      return { ok: true, message: "Shipment reopened; the event has been recorded." };
    }
    return { ok: false, error: "Unknown action." };
  } catch (error) {
    return { ok: false, error: error instanceof ShipmentError ? error.message : "Could not update Shipment." };
  }
}

export default function ShipmentDetail() {
  const { shipment, receiptRequestId, locations, locationMessage } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return <s-page heading={shipment.id} inlineSize="large"><div className="stockhub-page">
    <Link to="/app/shipments">← Shipments</Link>
    {result?.error ? <s-banner tone="critical">{result.error}</s-banner> : null}
    {result?.message ? <s-banner tone="success">{result.message}</s-banner> : null}
    <s-section heading="Shipment details"><dl>
      <dt>Reference</dt><dd>{shipment.reference}</dd>
      <dt>Type</dt><dd>{shipment.referenceType}</dd>
      <dt>Carrier / supplier</dt><dd>{shipment.issuer}</dd>
      <dt>Status</dt><dd>{shipment.status}</dd>
      <dt>Expected</dt><dd>{shipment.expectations.length ? shipment.expectations.map((line) => `${line.sku}: ${line.expectedQty ?? "Unknown"}`).join(", ") : "Not provided"}</dd>
      <dt>Notes</dt><dd>{shipment.notes || "—"}</dd>
    </dl></s-section>
    <s-section heading="Import goods"><s-paragraph>Import expected quantities into the Shipment plan, or upload received goods to a selected Receipt Draft.</s-paragraph><Link to={`/app/shipments/${shipment.id}/import`}>Import CSV</Link></s-section>
    <s-section heading="Receiving summary"><s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base"><s-box border="base" padding="base"><s-text>Receipts</s-text><s-heading>{shipment.receipts.length}</s-heading></s-box><s-box border="base" padding="base"><s-text>Receiving progress</s-text><s-heading>Open each Receipt</s-heading><s-text>Inspection and exception status are tracked per Receipt and Location.</s-text></s-box><s-box border="base" padding="base"><s-text>Shopify sync</s-text><s-heading>Not enabled</s-heading><s-text>Confirming creates pending records only.</s-text></s-box></s-grid></s-section>
    <s-section heading="Receipts"><s-paragraph>Receipt drafts count as receiving work, not confirmed physical quantities. No Shopify inventory has been changed.</s-paragraph>
      {shipment.receipts.length ? <s-table><s-table-header-row><s-table-header>Receipt</s-table-header><s-table-header>Location</s-table-header><s-table-header>Status</s-table-header><s-table-header>Created (UTC)</s-table-header><s-table-header>Action</s-table-header></s-table-header-row><s-table-body>{shipment.receipts.map((receipt) => <s-table-row key={receipt.id}><s-table-cell><Link to={`/app/receipts/${receipt.id}`}>{receipt.id}</Link></s-table-cell><s-table-cell>{receipt.locationName}</s-table-cell><s-table-cell>{receipt.status}</s-table-cell><s-table-cell>{formatUtcDateTime(receipt.createdAt)}</s-table-cell><s-table-cell><Link to={`/app/receipts/${receipt.id}`}>{receipt.status === "DRAFT" ? "Inspect / continue" : "View inspection"}</Link>{receipt.status === "DRAFT" ? <Form method="post"><input type="hidden" name="intent" value="cancelReceipt" /><input type="hidden" name="receiptId" value={receipt.id} /><s-text-field label="Cancellation reason" name="reason" required /><s-button type="submit" variant="secondary">Cancel draft</s-button></Form> : null}</s-table-cell></s-table-row>)}</s-table-body></s-table> : <s-paragraph>No Receipts yet.</s-paragraph>}
      {shipment.status !== "CLOSED" ? <Form method="post"><input type="hidden" name="intent" value="receipt" /><input type="hidden" name="requestId" value={receiptRequestId} />{locationMessage ? <s-banner tone="warning">{locationMessage}</s-banner> : null}
        <s-select label="Shopify Location (one per Receipt)" name="locationId" required disabled={!locations.length}><s-option value="">Choose a Location</s-option>{locations.map((location) => <s-option key={location.id} value={location.id}>{location.name}</s-option>)}</s-select><s-button type="submit" disabled={!locations.length}>Receive Goods — Create Draft</s-button>
      </Form> : null}
    </s-section>
    <s-section heading="Shipment actions">
      {shipment.status !== "CLOSED" ? <Form method="post"><input type="hidden" name="intent" value="close" /><s-text-field label="Closure reason (required when expectations exist)" name="reason" /><s-button type="submit" variant="secondary">Close Shipment</s-button></Form> : <Form method="post"><input type="hidden" name="intent" value="reopen" /><s-text-field label="Reason for reopening" name="reason" required /><s-button type="submit" variant="secondary">Reopen Shipment</s-button></Form>}
      <s-paragraph>Closing does not resolve or remove open issues and never retries Shopify operations.</s-paragraph>
    </s-section>
    <s-section heading="Timeline"><s-table><s-table-header-row><s-table-header>Event</s-table-header><s-table-header>Reason / details</s-table-header><s-table-header>Time (UTC)</s-table-header></s-table-header-row><s-table-body>{shipment.events.map((event) => <s-table-row key={event.id}><s-table-cell>{event.type}</s-table-cell><s-table-cell>{event.reason || event.metadata || "—"}</s-table-cell><s-table-cell>{formatUtcDateTime(event.createdAt)}</s-table-cell></s-table-row>)}</s-table-body></s-table></s-section>
  </div></s-page>;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
