/* eslint-env node */
export async function runProductInteractions({ pageName, width, command, writeFile, outputFile }) {
  let interaction = null;
    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-product-row button[aria-expanded="false"]')?.click()` });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const expanded = await command("Runtime.evaluate", {
      expression: `({ count: document.querySelectorAll('.stockhub-product-detail-row').length,
        text: document.querySelector('.stockhub-product-detail-row')?.textContent,
        ariaExpanded: document.querySelector('.stockhub-product-row button')?.getAttribute('aria-expanded') })`,
      returnByValue: true,
    });
    await command("Runtime.evaluate", { expression: `document.querySelector('.stockhub-product-row button[aria-expanded="true"]')?.click()` });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const collapsed = await command("Runtime.evaluate", {
      expression: `({ count: document.querySelectorAll('.stockhub-product-detail-row').length,
        ariaExpanded: document.querySelector('.stockhub-product-row button')?.getAttribute('aria-expanded') })`,
      returnByValue: true,
    });
    interaction = { expanded: expanded.result.value, collapsed: collapsed.result.value };
    await writeFile(outputFile(`${pageName}-${width}-interaction.json`), JSON.stringify(interaction, null, 2));
  return interaction;
}
