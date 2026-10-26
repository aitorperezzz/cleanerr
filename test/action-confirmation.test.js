import assert from "node:assert/strict";
import test from "node:test";
import { createActionConfirmation } from "../public/action-confirmation.js";
import { element } from "../test-support/dom.js";

function confirmationHarness() {
  const timers = new Map();
  const notice = element();
  const panel = element();
  const content = element();
  const controller = createActionConfirmation({
    detailPanel: panel, detailContent: content,
    confirmationNotice: notice, confirmationTitle: element(), confirmationMessage: element(),
    requestAnimationFrame: callback => callback(),
    setTimeout: callback => { const id = Symbol(); timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const button = element();
  button.textContent = "Delete";
  return { ...controller, button, notice, panel, timers };
}

test("destructive actions require a second click and restore the button after confirmation", () => {
  const { confirmDestructiveAction, button, notice, timers } = confirmationHarness();
  assert.equal(confirmDestructiveAction(button, "Delete files"), false);
  assert.equal(button.textContent, "Are you sure?");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(notice.hidden, false);
  assert.equal(confirmDestructiveAction(button, "Delete files"), true);
  assert.equal(button.textContent, "Delete");
  assert.equal(button.dataset.confirming, undefined);
  assert.equal(button.getAttribute("aria-pressed"), undefined);
  assert.equal(notice.hidden, true);
  assert.equal(timers.size, 0);
});

test("switching actions cancels the first confirmation and expiry requires confirming again", () => {
  const { confirmAction, button, notice, timers } = confirmationHarness();
  const nextButton = element();
  nextButton.textContent = "Monitor";
  confirmAction(button, "First action");
  confirmAction(nextButton, "Second action");
  assert.equal(button.textContent, "Delete");
  assert.equal(timers.size, 1);
  assert.equal(notice.classList.contains("is-action"), true);
  [...timers.values()][0]();
  assert.equal(nextButton.textContent, "Monitor");
  assert.equal(notice.hidden, true);
  assert.equal(confirmAction(nextButton, "Second action"), false);
});

test("closing a detail panel cancels only confirmations inside that panel", () => {
  const { confirmAction, resetWithin, button, panel } = confirmationHarness();
  confirmAction(button, "Action");
  assert.equal(resetWithin(panel), false);
  panel.contains = candidate => candidate === button;
  assert.equal(resetWithin(panel), true);
  assert.equal(button.dataset.confirming, undefined);
  assert.equal(resetWithin(), false);
});
