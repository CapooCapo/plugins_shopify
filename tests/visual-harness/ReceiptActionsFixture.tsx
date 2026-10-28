import { useState } from "react";
import { Form, useActionData } from "react-router";

export async function receiptActionsFixtureAction({ request }: { request: Request }) {
  const formData = await request.formData();
  return {
    intent: formData.get("intent"),
    batchId: formData.get("batchId"),
    confirmed: formData.get("confirmed"),
    confirmedCount: formData.get("confirmedCount"),
  };
}

export function ReceiptActionsFixture() {
  const actionData = useActionData<typeof receiptActionsFixtureAction>();
  const [eligible, setEligible] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return <main className="stockhub-page stockhub-receipt-card">
    <header className="stockhub-receipt-header"><div><span>Inventory import</span><h1>Receipt IMP-20261028-000001</h1><p>Warehouse · Completed</p></div></header>
    <div className="stockhub-receipt-progress" role="group" aria-label="Import line completion">
      <div className="stockhub-receipt-progress-label"><strong>Import line processing</strong><span>{eligible ? 0 : 15} of 15 lines completed · {eligible ? 0 : 100}%</span></div>
      <progress aria-label={`${eligible ? 0 : 15} of 15 import lines completed`} max={15} value={eligible ? 0 : 15} />
    </div>
    <section className="stockhub-receipt-progress-summary" aria-label="Confirmed Shopify operations">
      <div className="stockhub-receipt-summary-cards">
        <article className="stockhub-receipt-summary-card stockhub-receipt-summary-card--primary"><span>Import lines completed</span><strong>{eligible ? 0 : 15}<small> / 15</small></strong><p>Lines whose persisted import status is successful</p></article>
        <article className="stockhub-receipt-summary-card"><span>Draft products created</span><strong>0</strong><p>Confirmed Shopify product creations</p></article>
        <article className="stockhub-receipt-summary-card"><span>New-product inventory activations</span><strong>0</strong><p>Inventory activation for products created by this receipt</p></article>
        <article className="stockhub-receipt-summary-card"><span>Existing SKU inventory adjustments</span><strong>{eligible ? 0 : 15}</strong><p>Confirmed quantity adjustments for matched variants</p></article>
      </div>
      <div className="stockhub-receipt-operation-details"><span><strong>0</strong> failed</span><span><strong>0</strong> blocked</span><span><strong>0</strong> uncertain or in progress</span></div>
      <p className="stockhub-receipt-summary-note">Completed lines, product creation, new-product inventory activation, and existing-SKU adjustments are separate outcomes.</p>
    </section>
    {!eligible ? <section className="stockhub-receipt-terminal stockhub-receipt-terminal--success" role="status"><strong>Import lines complete</strong><p>All 15 import lines completed. No lines remain eligible to merge or resume. Product creation and inventory stages are listed separately above.</p></section> : null}
    {!eligible ? <button type="button" aria-hidden="true" tabIndex={-1} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap" }} onClick={() => setEligible(true)}>Show eligible preview state</button> : null}
    <div className="stockhub-receipt-actions"><button type="button">Verify Shopify State</button></div>
    <section><h2>Line items</h2>
      <div className="stockhub-line-toolbar"><div className="stockhub-line-toolbar__filters">
        <s-text-field label="Search line items" placeholder="Search SKU or product" />
        <s-select label="Line status" value="ALL"><s-option value="ALL">All statuses</s-option><s-option value="PREVIEWED">Previewed</s-option></s-select>
      </div></div>
      {eligible ? <div className="stockhub-merge-action stockhub-merge-bar">
        <strong>Eligible: 15 rows</strong>
        {!confirming ? <button type="button" onClick={() => setConfirming(true)}>Merge eligible lines</button> : <div className="stockhub-merge-confirmation" role="dialog" aria-label="Confirm inventory merge">
          <p>Confirm merge of 15 eligible rows for receipt IMP-20261028-000001. Shopify writes start only after this confirmation.</p>
          <Form method="post" onSubmit={() => setConfirming(false)}>
            <input type="hidden" name="intent" value="merge" />
            <input type="hidden" name="batchId" value="fixture-batch-001" />
            <input type="hidden" name="confirmed" value="yes" />
            <input type="hidden" name="confirmedCount" value="15" />
            <button type="submit">Confirm merge of 15 rows</button>
            <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
          </Form>
        </div>}
      </div> : null}
      <p>{eligible ? "15 eligible lines" : "0 eligible lines"}</p>
    </section>
    {actionData ? <output className="receipt-action-result">{JSON.stringify(actionData)}</output> : null}
  </main>;
}
