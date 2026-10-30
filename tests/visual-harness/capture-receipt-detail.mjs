/* eslint-env node */
import assert from "node:assert/strict";

export async function runReceiptDetailInteractions({ metrics, width, command, waitFor, scrollToTop, writeFile, outputFile }) {
    const initial = JSON.parse(metrics.metrics).receiptDetail;
    assert.ok(initial, "the production receipt detail route fixture is mounted");
    assert.equal(initial.qualityCards.length, 3, "the real receipt route exposes Ready, Missing, and Error validation filters");
    assert.equal(initial.table.rows.length, 12, "the desktop and mobile structures render all fixture receipt rows");
    assert.equal(initial.issueGroups.length, 3, "repeated validation causes are grouped while distinct causes remain separate");
    assert.ok(initial.issueGroups.some((group) => group.label === "The SKU value is blank in this CSV row." && group.count === "2"),
      "equivalent blank-SKU CSV errors group as two affected rows");
    assert.ok(initial.issueGroups.some((group) => group.label === "Quantity must be a positive integer." && group.count === "2"),
      "a different CSV_INVALID_ROW cause remains its own two-row group");
    assert.equal(initial.mergeButtonCount, 1, "eligible PREVIEWED rows expose a Merge action");
    assert.equal(initial.mergeDialogCount, 0, "eligible PREVIEWED rows still require an explicit second confirmation");
    assert.match(initial.previewNote, /Preview only[\s\S]*No Shopify changes have been made/);
    assert.equal(initial.shopifyMutationCalls, 0, "the local fixture does not make Shopify mutations");

    if (width === 1280) {
      assert.notEqual(initial.table.display, "none", "desktop uses the semantic table structure");
      assert.ok(initial.table.width > 900, "desktop table uses the embedded-app content width");
      assert.ok(initial.table.scrollWidth <= initial.table.width + 2, "desktop table does not require horizontal scrolling");
      assert.ok(initial.table.productColumnWidth >= 260, "desktop Product / Variant column remains readable");
      assert.ok(initial.table.skuColumnWidth >= 130, "desktop SKU column remains readable");
      assert.ok(initial.table.headings.length >= 5 && initial.table.headings.every((heading) => heading.whiteSpace === "nowrap" && heading.scrollWidth <= heading.clientWidth + 2),
        "desktop column headings remain on one line without clipping");
    } else {
      assert.equal(initial.table.display, "none", "mobile hides the desktop table rather than compressing it");
      assert.equal(initial.mobile.display, "grid", "mobile renders the dedicated row-card structure");
      assert.ok(initial.mobile.cards.every((card) => card.x >= 0 && card.right <= width), "mobile row cards stay within the viewport");
      assert.ok(initial.mobile.cards.every((card) => card.actionHeights.length > 0 && card.actionHeights.every((height) => height >= 44)),
        "mobile row action targets are at least 44px high");
      assert.ok(initial.qualityCards.every((card) => card.rect.height >= 78), "mobile validation filter cards retain touch-friendly height");
    }

    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-receipt-lines')?.scrollIntoView({behavior:'instant',block:'start'})` });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rowsShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`receipt-detail-rows-${width}.png`), Buffer.from(rowsShot.data, "base64"));
    await scrollToTop();

    const runScript = async (expression) => {
      const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return result.result.value;
    };
    await runScript(`(() => [...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Ready to Merge'))?.click())()`);
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('5 rows')`, "Ready validation filter");
    const readyFilter = await runScript(`({results:document.querySelector('.stockhub-line-results')?.textContent.trim(),pressed:[...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Ready to Merge'))?.getAttribute('aria-pressed')})`);
    assert.equal(readyFilter.pressed, "true", "clicking Ready to Merge marks that quality filter selected");
    assert.match(readyFilter.results, /^5 rows/);
    await runScript(`(() => [...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Missing Information'))?.click())()`);
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('1 row')`, "Missing Information validation filter");
    const missingFilter = await runScript(`({results:document.querySelector('.stockhub-line-results')?.textContent.trim(),pressed:[...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Missing Information'))?.getAttribute('aria-pressed')})`);
    assert.equal(missingFilter.pressed, "true");
    assert.match(missingFilter.results, /^1 row/);
    await runScript(`(() => [...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.trim().startsWith('6') && button.innerText.includes('Error'))?.click())()`);
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('6 rows')`, "Error validation filter");
    const errorFilter = await runScript(`({results:document.querySelector('.stockhub-line-results')?.textContent.trim(),pressed:[...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Error'))?.getAttribute('aria-pressed')})`);
    assert.equal(errorFilter.pressed, "true");
    assert.match(errorFilter.results, /^6 rows/);
    await runScript(`(() => [...document.querySelectorAll('.stockhub-draft-status-summary button')].find(button=>button.innerText.includes('Error'))?.click())()`);

    const searchAndType = await runScript(`(() => {
      const search=document.querySelector('s-text-field[label="Search line items"]');
      search.value='SKU-READY-DRAFT-02';
      search.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
      search.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      const type=document.querySelector('s-select[label="Operation type"]');
      type.value='CREATE_DRAFT';
      type.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      return {search:search.value,type:type.value};
    })()`);
    assert.deepEqual(searchAndType, { search: "SKU-READY-DRAFT-02", type: "CREATE_DRAFT" });
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('1 row')`, "search and operation-type filters");
    const beforeIssueAction = await runScript(`document.querySelector('.stockhub-line-results')?.textContent.trim()`);
    assert.match(beforeIssueAction, /^1 row/);
    const groupAction = await runScript(`(() => {
      const group=[...document.querySelectorAll('.stockhub-validation-issue-list > li')].find(item=>item.innerText.includes('The SKU value is blank in this CSV row.'));
      group?.querySelector('button')?.click();
      return group?.querySelector('button')?.textContent.trim() ?? null;
    })()`);
    assert.equal(groupAction, "Show 2 affected rows");
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('2 rows')`, "complete selected validation issue group");
    const groupFilter = await runScript(`({
      results:document.querySelector('.stockhub-line-results')?.textContent.trim(),
      search:document.querySelector('s-text-field[label="Search line items"]')?.value,
      type:document.querySelector('s-select[label="Operation type"]')?.value,
      status:document.querySelector('s-select[label="Quality status"]')?.value,
      skus:[...document.querySelectorAll('.stockhub-lines-table tbody tr')].map(row=>row.querySelector('[data-label="SKU"]')?.textContent.trim())
    })`);
    assert.match(groupFilter.results, /^2 rows/);
    assert.equal(groupFilter.search, "", "Show affected rows clears the prior search");
    assert.equal(groupFilter.type, "ALL", "Show affected rows clears the incompatible operation filter");
    assert.equal(groupFilter.status, "ERROR", "Show affected rows applies the error filter");
    assert.deepEqual(groupFilter.skus, ["SKU-CSV-MISSING-04", "SKU-CSV-MISSING-05"], "the visible rows exactly match the advertised group");

    const sortBefore = groupFilter.skus;
    await runScript(`([...document.querySelectorAll('.stockhub-line-toolbar__filters s-button')].find(button=>button.innerText.includes('Sort by row')))?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const sortAfter = await runScript(`([...document.querySelectorAll('.stockhub-lines-table tbody tr')].map(row=>row.querySelector('[data-label="SKU"]')?.textContent.trim()))`);
    assert.deepEqual(sortAfter, [...sortBefore].reverse(), "Sort by row reverses the selected group order");

    await runScript(`(() => {
      const search=document.querySelector('s-text-field[label="Search line items"]');
      search.value=''; search.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      const status=document.querySelector('s-select[label="Quality status"]');
      status.value='ALL'; status.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      const type=document.querySelector('s-select[label="Operation type"]');
      type.value='ALL'; type.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    })()`);
    await waitFor(`document.querySelector('.stockhub-line-results')?.textContent.includes('12 rows')`, "all receipt rows after clearing filters");

    const revalidateBefore = await runScript(`document.querySelector('.stockhub-line-toolbar__actions s-button[type="submit"]')?.hasAttribute('disabled') ?? null`);
    assert.equal(revalidateBefore, true, "revalidation is disabled until a row is selected");
    if (width > 760) {
      await runScript(`document.querySelector('.stockhub-lines-table button[aria-label="Open details for row 1"]')?.click()`);
    } else {
      await runScript(`document.querySelector('.stockhub-mobile-lines button[aria-label="Open details for row 1"]')?.click()`);
    }
    await waitFor(`!!document.querySelector('.stockhub-row-inspector[role="dialog"]')`, "row detail drawer");
    const drawerState = await runScript(`({title:document.querySelector('#stockhub-row-inspector-heading')?.textContent.trim(),revalidateDisabled:document.querySelector('.stockhub-line-toolbar__actions s-button[type="submit"]')?.hasAttribute('disabled') ?? null})`);
    assert.match(drawerState.title, /Row 1 · SKU-READY-ADJUST-01/);
    assert.equal(drawerState.revalidateDisabled, false, "selecting a row enables its guarded revalidation action");
    await runScript(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await waitFor(`!document.querySelector('.stockhub-row-inspector[role="dialog"]')`, "drawer Escape close");

    const addButton = await runScript(`(() => {
      const button=[...document.querySelectorAll('.stockhub-line-toolbar__actions s-button')].find(item=>item.innerText.includes('Add draft row'));
      button?.click(); return !!button;
    })()`);
    assert.equal(addButton, true, "editable Previewed receipts expose Add draft row");
    await waitFor(`document.querySelector('#stockhub-row-inspector-heading')?.textContent.includes('Add draft row')`, "Add draft row drawer");
    await runScript(`document.querySelector('.stockhub-row-inspector button[aria-label="Close product details"]')?.click()`);
    await waitFor(`!document.querySelector('.stockhub-row-inspector[role="dialog"]')`, "close Add draft row drawer");

    await runScript(`([...document.querySelectorAll('.stockhub-merge-action s-button')].find(button=>button.innerText.includes('Merge eligible lines')))?.click()`);
    await waitFor(`!!document.querySelector('.stockhub-merge-confirmation[role="dialog"]')`, "explicit Merge confirmation dialog");
    const mergeFields = await runScript(`Object.fromEntries([...document.querySelectorAll('.stockhub-merge-confirmation input[type="hidden"]')].map(input=>[input.name,input.value]))`);
    assert.deepEqual(mergeFields, {
      intent: "merge",
      batchId: "fixture-receipt-001",
      confirmed: "yes",
      confirmedCount: "5",
      partialConfirmed: "yes",
    }, "eligible preview preserves explicit current-count and partial-confirmation fields");
    const interaction = { readyFilter, missingFilter, errorFilter, beforeIssueAction, groupFilter, sortAfter, drawerState, revalidateBefore, addButton, mergeFields };
    await writeFile(outputFile(`receipt-detail-interaction-${width}.json`), JSON.stringify(interaction, null, 2));

    await command("Page.navigate", { url: "http://127.0.0.1:4179/?page=receipt-detail&fixture=zero" });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const zeroResult = await command("Runtime.evaluate", {
      expression: `({ready:document.body.dataset.visualReady,metrics:document.getElementById('visual-metrics')?.textContent,body:document.body.innerText})`,
      returnByValue: true,
    });
    const zeroState = zeroResult.result.value;
    assert.equal(zeroState.ready, "true", "zero-ready Previewed fixture has rendered");
    const zeroLayout = JSON.parse(zeroState.metrics).receiptDetail;
    assert.equal(zeroLayout.qualityCards.find((card) => card.text.includes("Ready to Merge"))?.rect.height > 0, true);
    assert.equal(zeroLayout.mergeButtonCount, 0, "zero-ready Previewed receipt renders no Merge/Resume action");
    assert.equal(zeroLayout.mergeDialogCount, 0, "zero-ready Previewed receipt cannot show a confirmation dialog");
    assert.match(zeroState.body, /No rows are ready to merge/);
    assert.doesNotMatch(zeroState.body, /Resume eligible lines|Confirm resume/);
    assert.match(zeroState.body, /Verify Shopify State/, "read-only receipt verification remains available");
    assert.equal(zeroLayout.shopifyMutationCalls, 0);
    const zeroShot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(outputFile(`receipt-detail-zero-${width}.png`), Buffer.from(zeroShot.data, "base64"));
    await writeFile(outputFile(`receipt-detail-zero-${width}.json`), JSON.stringify(zeroState, null, 2));
}
