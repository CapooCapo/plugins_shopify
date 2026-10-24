import { Form, useActionData } from "react-router";

export async function receiptActionsFixtureAction({ request }: { request: Request }) {
  const formData = await request.formData();
  return {
    intent: formData.get("intent"),
    batchId: formData.get("batchId"),
    confirmed: formData.get("confirmed"),
  };
}

export function ReceiptActionsFixture() {
  const actionData = useActionData<typeof receiptActionsFixtureAction>();

  return <main className="stockhub-page">
    <header><h1>Receipt detail fixture</h1><p>Eligible PREVIEWED receipt · 15 / 15 lines</p></header>
    <div className="stockhub-receipt-summary-wrap" role="region" aria-label="Import progress summary">
      <table className="stockhub-receipt-summary">
        <caption>Import progress summary</caption>
        <thead><tr><th scope="col">Metric</th><th scope="col">Count</th></tr></thead>
        <tbody>
          <tr><th scope="row">Draft products created</th><td><span className="stockhub-receipt-summary-count stockhub-receipt-summary-count--neutral">0 confirmed</span></td></tr>
          <tr><th scope="row">Unresolved Draft product creation</th><td><span className="stockhub-receipt-summary-count stockhub-receipt-summary-count--neutral">0</span></td></tr>
          <tr><th scope="row">Inventory activated</th><td><span className="stockhub-receipt-summary-count stockhub-receipt-summary-count--neutral">0 confirmed</span></td></tr>
          <tr><th scope="row">Import lines completed</th><td><span className="stockhub-receipt-summary-count stockhub-receipt-summary-count--neutral">0</span></td></tr>
          <tr><th scope="row">Failed</th><td><span className="stockhub-receipt-summary-count stockhub-receipt-summary-count--success">0</span></td></tr>
          <tr><th scope="row">Blocked</th><td><span className="stockhub-receipt-summary-count stockhub-receipt-summary-count--success">0</span></td></tr>
          <tr><th scope="row">Uncertain</th><td><span className="stockhub-receipt-summary-count stockhub-receipt-summary-count--success">0</span></td></tr>
        </tbody>
      </table>
    </div>
    <section><h2>Line items</h2>
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
        <s-text-field label="Search line items" placeholder="Search SKU or product" />
        <s-select label="Line status" value="ALL">
          <s-option value="ALL">All statuses</s-option>
          <s-option value="PREVIEWED">Previewed</s-option>
        </s-select>
      </s-grid>
      <div className="stockhub-merge-action">
      <Form method="post" onSubmit={(event) => {
        if (!window.confirm("Confirm merge for receipt IMP-TEST-001 in example-outfitters.myshopify.com?")) {
          event.preventDefault();
        }
      }}>
        <input type="hidden" name="intent" value="merge" />
        <input type="hidden" name="batchId" value="fixture-batch-001" />
        <input type="hidden" name="confirmed" value="yes" />
        <s-button type="submit" variant="primary">Merge eligible lines</s-button>
      </Form>
      </div>
      <p>15 eligible lines</p>
    </section>
    {actionData ? <output className="receipt-action-result">
      {JSON.stringify(actionData)}
    </output> : null}
  </main>;
}
