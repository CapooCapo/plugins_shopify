import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { closeShipment, createShipment, listShipments, reopenShipment, ShipmentError } from "../utils/shipments.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  return { shipments: await listShipments(session.shop, url.searchParams.get("q") ?? "", url.searchParams.get("status") ?? ""), q: url.searchParams.get("q") ?? "", status: url.searchParams.get("status") ?? "" };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    const intent = String(form.get("intent") ?? "");
    if (intent === "create") {
      const skus = form.getAll("expectedSku").map((value) => String(value).trim());
      const quantities = form.getAll("expectedQty").map((value) => String(value).trim());
      const expectations = skus.flatMap((sku, index) => {
        const qtyText = quantities[index] ?? "";
        if (!sku && !qtyText) return [];
        if (!sku) throw new ShipmentError(`Expected item ${index + 1} needs a SKU.`, "INVALID_EXPECTATION");
        if (qtyText && !/^\d+$/.test(qtyText)) throw new ShipmentError(`Expected quantity for ${sku} must be a non-negative whole number.`, "INVALID_EXPECTATION");
        const expectedQty = qtyText ? Number(qtyText) : null;
        if (expectedQty !== null && !Number.isSafeInteger(expectedQty)) throw new ShipmentError(`Expected quantity for ${sku} is too large.`, "INVALID_EXPECTATION");
        return [{ sku, expectedQty }];
      });
      await createShipment({
        shop: session.shop, referenceType: String(form.get("referenceType") ?? ""),
        reference: String(form.get("reference") ?? ""), issuer: String(form.get("issuer") ?? ""),
        notes: String(form.get("notes") ?? ""),
        expectations,
      });
      return { ok: true, message: "Shipment created." };
    }
    if (intent === "close") {
      await closeShipment({ shop: session.shop, shipmentId: String(form.get("shipmentId")), reason: String(form.get("reason") ?? "") });
      return { ok: true, message: "Shipment closed." };
    }
    if (intent === "reopen") {
      await reopenShipment({ shop: session.shop, shipmentId: String(form.get("shipmentId")), reason: String(form.get("reason") ?? "") });
      return { ok: true, message: "Shipment reopened." };
    }
    return { ok: false, error: "Unknown action." };
  } catch (error) {
    return { ok: false, error: error instanceof ShipmentError ? error.message : "Could not save Shipment." };
  }
}

export default function ShipmentsIndex() {
  const { shipments, q, status } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [expectedLineIds, setExpectedLineIds] = useState([0]);
  return <s-page heading="Shipments" inlineSize="large"><div className="stockhub-page">
    {result?.error ? <s-banner tone="critical">{result.error}</s-banner> : null}
    {result?.message ? <s-banner tone="success">{result.message}</s-banner> : null}
    <s-section heading="Create Shipment"><Form method="post"><input type="hidden" name="intent" value="create" />
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
        <s-select label="Reference type" name="referenceType" required><s-option value="TRACKING">Tracking number</s-option><s-option value="DELIVERY_REFERENCE">Supplier delivery reference</s-option></s-select>
        <s-text-field label="Reference" name="reference" required />
        <s-text-field label="Carrier / supplier" name="issuer" required />
        {expectedLineIds.map((lineId, index) => <s-grid key={lineId} gridTemplateColumns="1fr 1fr auto" gap="base">
          <s-text-field label={`Expected SKU ${index + 1} (optional)`} name="expectedSku" />
          <s-number-field label={`Expected quantity ${index + 1} (optional)`} name="expectedQty" min={0} step={1} />
          <s-button type="button" variant="secondary" disabled={expectedLineIds.length === 1} onClick={() => setExpectedLineIds((lines) => lines.filter((id) => id !== lineId))}>Remove</s-button>
        </s-grid>)}
        <s-button type="button" variant="secondary" onClick={() => setExpectedLineIds((lines) => [...lines, Math.max(...lines) + 1])}>Add expected item</s-button>
      </s-grid><s-text-field label="Notes" name="notes" /><s-button type="submit" variant="primary">Create Shipment</s-button>
    </Form></s-section>
    <s-section heading="All Shipments"><Form method="get"><s-grid gridTemplateColumns="2fr 1fr auto" gap="base">
      <s-text-field label="Search ID, reference, carrier or supplier" name="q" value={q} />
      <s-select label="Status" name="status" value={status}><s-option value="">All statuses</s-option><s-option value="OPEN">Open</s-option><s-option value="RECEIVING">Receiving</s-option><s-option value="CLOSED">Closed</s-option></s-select>
      <s-button type="submit">Filter</s-button></s-grid></Form>
      {shipments.length ? <s-table><s-table-header-row><s-table-header listSlot="primary">Shipment</s-table-header><s-table-header>Reference</s-table-header><s-table-header>Source</s-table-header><s-table-header>Status</s-table-header><s-table-header>Receipts</s-table-header><s-table-header>Expected quantity</s-table-header><s-table-header>Received quantity</s-table-header><s-table-header>Open issues</s-table-header></s-table-header-row>
        <s-table-body>{shipments.map((shipment) => <s-table-row key={shipment.id}><s-table-cell><Link to={`/app/shipments/${encodeURIComponent(shipment.id)}`}>{shipment.id}</Link></s-table-cell><s-table-cell>{shipment.reference}</s-table-cell><s-table-cell>{shipment.issuer}</s-table-cell><s-table-cell>{shipment.status}</s-table-cell><s-table-cell>{shipment.receipts.length}</s-table-cell><s-table-cell>{shipment.expectations.length ? shipment.expectations.map((line) => `${line.sku}: ${line.expectedQty ?? "Unknown"}`).join(", ") : "Not provided"}</s-table-cell><s-table-cell>Not recorded (inspection not available yet)</s-table-cell><s-table-cell>Not tracked yet (exception capture not available yet)</s-table-cell></s-table-row>)}</s-table-body></s-table> : <s-paragraph>No Shipments match this view.</s-paragraph>}
    </s-section>
  </div></s-page>;
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
