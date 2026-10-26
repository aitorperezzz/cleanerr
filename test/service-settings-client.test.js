import assert from "node:assert/strict";
import test from "node:test";
import { createServiceSettings } from "../public/service-settings.js";
import { element } from "../test-support/dom.js";
import { jsonResponse } from "../test-support/server-harness.js";

function form() {
  const result = element();
  result.dataset.service = "radarr";
  result.elements = { url: { value: "http://radarr" }, apiKey: { value: "" } };
  return result;
}

test("connection failures restore the controls and report the service error", async () => {
  const target = form();
  const calls = [];
  const settings = createServiceSettings({
    serviceForms: [target],
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse({ error: "Service unavailable" }, 502); },
  });
  await settings.testConnection(target);
  assert.equal(target.querySelector(".test-connection-button").disabled, false);
  assert.equal(target.querySelector(".test-connection-button").textContent, "Test connection");
  assert.equal(target.querySelector(".connection-result").textContent, "Service unavailable");
  assert.equal(target.querySelector(".connection-result").classList.contains("is-error"), true);
  assert.equal(calls[0].options.headers["X-Cleanerr-Request"], "1");
  assert.equal(JSON.parse(calls[0].options.body).apiKey, "");
});

test("a failed settings save preserves input and the loaded library", async () => {
  const target = form();
  let invalidated = false;
  let notified = false;
  const settings = createServiceSettings({
    serviceForms: [target],
    fetchImpl: async url => url === "/api/settings"
      ? jsonResponse({ services: { radarr: { url: "http://radarr", configured: true, apiKeyConfigured: true } } })
      : jsonResponse({ error: "Disk full" }, 500),
    invalidateLibrary: () => { invalidated = true; },
    onServiceSaved: () => { notified = true; },
  });
  await settings.loadSettings();
  assert.equal(target.elements.apiKey.value, "");
  assert.match(target.elements.apiKey.placeholder, /leave empty/);
  target.elements.url.value = "http://new-radarr";
  target.elements.apiKey.value = "new-key";
  await settings.saveServiceSettings(target);
  assert.equal(target.elements.url.value, "http://new-radarr");
  assert.equal(target.elements.apiKey.value, "new-key");
  assert.equal(target.querySelector('button[type="submit"]').disabled, false);
  assert.equal(target.querySelector(".connection-result").textContent, "Disk full");
  assert.equal(invalidated, false);
  assert.equal(notified, false);
});
