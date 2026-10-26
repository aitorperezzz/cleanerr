import { readJsonResponse } from "./http-client.js";

export function createServiceSettings({ serviceForms, fetchImpl, invalidateLibrary, onServiceSaved }) {
  let settingsState = null;

  function renderServiceSettings(form, service) {
    const status = form.querySelector(".service-status");
    const apiKey = form.elements.apiKey;
    form.elements.url.value = service.url || "";
    apiKey.value = "";
    apiKey.placeholder = service.apiKeyConfigured ? "Saved — leave empty to keep" : "Enter API key";
    status.textContent = service.configured ? "Configured" : "Not configured";
    status.classList.toggle("is-configured", service.configured);
  }

  function renderSettings() {
    if (!settingsState) return;
    serviceForms.forEach((form) => {
      renderServiceSettings(form, settingsState.services[form.dataset.service]);
    });
  }

  function formPayload(form) {
    return {
      url: form.elements.url.value.trim(),
      apiKey: form.elements.apiKey.value.trim(),
    };
  }

  function showConnectionResult(form, message, type = "") {
    const result = form.querySelector(".connection-result");
    result.textContent = message;
    result.classList.toggle("is-success", type === "success");
    result.classList.toggle("is-error", type === "error");
  }

  async function loadSettings() {
    const response = await fetchImpl("/api/settings", { cache: "no-store" });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Could not load settings");
    settingsState = data;
    renderSettings();
    return data;
  }

  async function testConnection(form) {
    const button = form.querySelector(".test-connection-button");
    button.disabled = true;
    button.classList.add("is-busy");
    button.textContent = "Testing...";
    showConnectionResult(form, "");

    try {
      const response = await fetchImpl(`/api/settings/${form.dataset.service}/test`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Cleanerr-Request": "1" },
        body: JSON.stringify(formPayload(form)),
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "Connection failed");
      const detail = data.connection.version ? ` · version ${data.connection.version}` : "";
      showConnectionResult(form, `Connected to ${data.connection.name}${detail}`, "success");
    } catch (error) {
      showConnectionResult(form, error.message, "error");
    } finally {
      button.disabled = false;
      button.classList.remove("is-busy");
      button.textContent = "Test connection";
    }
  }

  async function saveServiceSettings(form) {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.classList.add("is-busy");
    button.textContent = "Saving...";
    showConnectionResult(form, "");

    try {
      const response = await fetchImpl(`/api/settings/${form.dataset.service}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "X-Cleanerr-Request": "1" },
        body: JSON.stringify(formPayload(form)),
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "Could not save settings");
      invalidateLibrary();
      settingsState.services[form.dataset.service] = data.service;
      settingsState.complete = data.complete;
      renderServiceSettings(form, data.service);
      showConnectionResult(form, "Settings saved", "success");
      onServiceSaved(form.dataset.service);
    } catch (error) {
      showConnectionResult(form, error.message, "error");
    } finally {
      button.disabled = false;
      button.classList.remove("is-busy");
      button.textContent = "Save";
    }
  }

  return { loadSettings, renderSettings, testConnection, saveServiceSettings };
}
