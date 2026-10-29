(() => {
  if (window.__stockHubSizeGuideReady) return;
  window.__stockHubSizeGuideReady = true;

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const openButton = event.target.closest("[data-size-guide-open]");
    if (openButton) {
      const dialogId = openButton.getAttribute("aria-controls");
      const dialog = dialogId ? document.getElementById(dialogId) : null;
      if (dialog instanceof HTMLDialogElement && !dialog.open) dialog.showModal();
      return;
    }
    const closeButton = event.target.closest("[data-size-guide-close]");
    if (closeButton) {
      const dialog = closeButton.closest("dialog");
      if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
    }
  });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof HTMLDialogElement) || !event.target.matches("[data-size-guide-dialog]")) return;
    const bounds = event.target.getBoundingClientRect();
    const inDialog = bounds.top <= event.clientY && event.clientY <= bounds.bottom
      && bounds.left <= event.clientX && event.clientX <= bounds.right;
    if (!inDialog) event.target.close();
  });
})();
