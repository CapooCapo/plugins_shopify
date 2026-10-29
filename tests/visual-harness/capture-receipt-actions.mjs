/* eslint-env node */
import assert from "node:assert/strict";

export async function runReceiptActionInteractions({ metrics, pageName, width, command, waitFor, writeFile, outputFile }) {
  let interaction = null;
    const initialLayout = JSON.parse(metrics.metrics);
    assert.equal(initialLayout.receiptActions.summary.cardCount, 4, "operation outcomes use four concise summary cards");
    assert.match(initialLayout.receiptActions.summary.zeroEligibleTerminal, /All 15 import lines completed/);
    assert.equal(initialLayout.receiptActions.summary.mergeActionCount, 0, "zero eligible rows render no sticky Merge/Resume action");
    assert.equal(initialLayout.receiptActions.summary.warningCount, 0, "zero eligible terminal state has no irrelevant warning banner");
    assert.match(metrics.body, /Verify Shopify State/, "read-only Shopify state verification remains available");
    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-receipt-card > button[aria-hidden="true"]')?.click()` });
    await waitFor(`!!document.querySelector('.stockhub-merge-action > button')`, "eligible preview state");
    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-merge-action > button')?.click()` });
    await waitFor(`!!document.querySelector('.stockhub-merge-confirmation[role="dialog"]')`, "explicit Merge confirmation");
    const rejected = await command("Runtime.evaluate", {
      expression: `(async () => {
        document.querySelector('.stockhub-merge-confirmation button[type="button"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 150));
        return document.querySelector('.receipt-action-result')?.textContent ?? null;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(rejected.result.value, null, "canceling the confirmation must not submit the Merge form");

    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-merge-action > button')?.click()` });
    await waitFor(`!!document.querySelector('.stockhub-merge-confirmation button[type="submit"]')`, "confirmed Merge form");
    const accepted = await command("Runtime.evaluate", {
      expression: `(async () => {
        document.querySelector('.stockhub-merge-confirmation button[type="submit"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        return document.querySelector('.receipt-action-result')?.textContent ?? null;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    interaction = { canceledSubmission: rejected.result.value, confirmedSubmission: accepted.result.value };
    assert.equal(interaction.confirmedSubmission, JSON.stringify({ intent: "merge", batchId: "fixture-batch-001", confirmed: "yes", confirmedCount: "15" }), "explicit confirmation must submit the existing React Router Form fields");
    await writeFile(outputFile(`${pageName}-${width}-interaction.json`), JSON.stringify(interaction, null, 2));
  return interaction;
}
