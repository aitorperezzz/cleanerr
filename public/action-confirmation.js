export function createActionConfirmation({
  detailPanel, detailContent, confirmationNotice, confirmationTitle, confirmationMessage,
  requestAnimationFrame, setTimeout, clearTimeout,
}) {
  const confirmationTimers = new WeakMap();
  let activeConfirmationButton = null;

  function resetActionConfirmation(button) {
    const timer = confirmationTimers.get(button);
    if (timer) clearTimeout(timer);
    confirmationTimers.delete(button);

    if (button.dataset.defaultLabel) button.textContent = button.dataset.defaultLabel;
    delete button.dataset.defaultLabel;
    delete button.dataset.confirming;
    button.classList.remove("is-confirming");
    button.removeAttribute("aria-pressed");

    if (activeConfirmationButton === button) {
      activeConfirmationButton = null;
      detailContent.style.removeProperty("--confirmation-clearance");
      confirmationNotice.hidden = true;
      confirmationNotice.classList.remove("is-action");
      confirmationTitle.textContent = "Confirm action";
      confirmationMessage.textContent = "";
    }
  }

  function keepConfirmationButtonVisible(button) {
    if (!detailPanel.contains(button)) return;

    requestAnimationFrame(() => {
      if (activeConfirmationButton !== button || !button.isConnected) return;
      const panelBottom = detailPanel.getBoundingClientRect().bottom;
      const noticeTop = confirmationNotice.getBoundingClientRect().top;
      const clearance = Math.max(0, panelBottom - noticeTop + 12);
      detailContent.style.setProperty("--confirmation-clearance", `${clearance}px`);
      button.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    });
  }

  function confirmAction(button, message, { title = "Confirm action", destructive = false } = {}) {
    if (button.dataset.confirming === "true") {
      resetActionConfirmation(button);
      return true;
    }

    if (activeConfirmationButton) resetActionConfirmation(activeConfirmationButton);
    button.dataset.defaultLabel = button.textContent;
    button.dataset.confirming = "true";
    button.classList.add("is-confirming");
    button.setAttribute("aria-pressed", "true");
    button.textContent = "Are you sure?";
    activeConfirmationButton = button;
    confirmationNotice.classList.toggle("is-action", !destructive);
    confirmationTitle.textContent = title;
    confirmationMessage.textContent = message;
    confirmationNotice.hidden = false;
    keepConfirmationButtonVisible(button);
    confirmationTimers.set(button, setTimeout(() => resetActionConfirmation(button), 5000));
    return false;
  }

  function confirmDestructiveAction(button, message) {
    return confirmAction(button, message, { title: "Confirm deletion", destructive: true });
  }

  function resetWithin(container) {
    if (!activeConfirmationButton || (container && !container.contains(activeConfirmationButton))) return false;
    resetActionConfirmation(activeConfirmationButton);
    return true;
  }

  return { confirmAction, confirmDestructiveAction, resetWithin };
}
