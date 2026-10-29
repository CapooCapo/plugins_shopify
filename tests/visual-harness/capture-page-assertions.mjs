/* eslint-env node */
import assert from "node:assert/strict";

export function validatePageAssertions({ pageName, width, layout, metrics, interaction }) {
  if (pageName === "receipt-actions") {
    assert.equal(layout.receiptActions.summary.cardCount, 4, "four persisted operation metrics render as cards");
    assert.ok(layout.receiptActions.summary.width - layout.receiptActions.summary.scrollWidth <= 2,
      "receipt summary cards must fit their container at desktop and mobile widths");
    assert.deepEqual(layout.receiptActions.summary.labels,
      ["Import lines completed", "Draft products created", "New-product inventory activations", "Existing SKU inventory adjustments"]);
    assert.equal(layout.polarisButtonDefined, true, "Polaris s-button must be registered");
    assert.ok(layout.receiptActions.searchFieldRect, "line-item search field must be rendered");
    assert.equal(layout.receiptActions.host, null, "zero-eligible terminal state renders no merge button");
    assert.equal(layout.receiptActions.customElementDefined, true);
    assert.equal(layout.receiptActions.searchLabel, "Search line items", "line-item search control must be rendered");
    assert.match(metrics.body, /Import lines complete/, "terminal status must be exposed in the rendered page");
    assert.equal(interaction.confirmedSubmission, JSON.stringify({ intent: "merge", batchId: "fixture-batch-001", confirmed: "yes", confirmedCount: "15" }));
  }
  if (pageName.startsWith("products")) {
    const catalog = layout.products;
    assert.deepEqual(catalog.columns,
      ["Product", "SKU / variants", "Status", "Price", "Total inventory", "Actions"]);
    assert.equal(catalog.rows.length, pageName === "products-sku" ? 1 : 8);
    assert.equal(catalog.expandedDetailRows, 0, "variant details should be collapsed initially");
    assert.equal(interaction.expanded.count, 1, "Details button must reveal one row");
    assert.equal(interaction.expanded.ariaExpanded, "true");
    assert.match(interaction.expanded.text, /SKU:/);
    assert.equal(interaction.collapsed.count, 0, "Hide details must collapse it again");
    assert.equal(interaction.collapsed.ariaExpanded, "false");
    assert.ok(catalog.rows.every((row) => row.actionLinks === 1), "Shopify action must stay in the product row");
    assert.ok(catalog.rows.every((row) => row.fullTitle), "truncated titles must retain full text");
    assert.equal(catalog.paginationHrefs.length, 2);
    if (pageName === "products-sku") {
      assert.equal(catalog.skuCells[0], "MATCH-204", "SKU search must display matched variant");
      assert.ok(catalog.paginationHrefs.every((href) => href.includes("q=MATCH-204") && href.includes("searchBy=sku")));
    } else {
      assert.equal(catalog.inventoryCells[0], "Unavailable", "unknown inventory must not be zero");
      assert.equal(catalog.inventoryCells[4], "0", "actual zero inventory must remain zero");
    }
    if (width === 1280) {
      assert.ok(catalog.content.width >= 1200, "catalog should use embedded desktop width");
      assert.ok(catalog.filterForm.height <= 120, "desktop filters should be compact");
      assert.ok(catalog.rows.every((row) => row.height <= 72), "collapsed desktop rows should be dense");
    } else {
      assert.ok(catalog.rows.every((row) => row.actionTargetHeights.every((height) => height >= 36)),
        "mobile action targets should be at least 36px high");
      }
    }
    if (pageName === "new-import") {
      const imp = layout.newImport;
      assert.ok(imp.header, "new-import header exists");
      assert.ok(imp.stepper, "workflow stepper exists");
      assert.ok(imp.dropzone, "dropzone upload area exists");
      assert.equal(imp.fileInput, true, "file input exists");
      assert.equal(imp.locationSelect, true, "location select exists");
      assert.equal(imp.validateButton, true, "validate CTA button exists");
      assert.ok(imp.guidanceCard, "guidance card exists");
      if (width === 1280) {
        assert.ok(imp.form.y === imp.guidanceCard.y, "main form and guidance card must share desktop row");
        assert.ok(imp.form.width > imp.guidanceCard.width, "main form must be wider than guidance card (~65% / 35%)");
        assert.ok(layout.documentWidth <= width, "no horizontal overflow on desktop");
      } else {
        assert.ok(imp.form.y < imp.guidanceCard.y, "form and guidance card must stack vertically on mobile");
        assert.ok(layout.documentWidth <= width, "no horizontal overflow on mobile");
      }
    }
}
