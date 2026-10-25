import assert from "node:assert/strict";
import test from "node:test";
import { appHarness } from "../test-support/app-harness.js";
import { jsonResponse } from "../test-support/server-harness.js";

function libraryResponse(path, revision = "instance-A") {
  return jsonResponse(path.startsWith("/api/library")
    ? { configurationRevision: revision, items: [{ id: 42, service: "radarr", title: "Old instance" }], errors: [] }
    : { configurationRevision: revision, collections: [{ id: 6, movies: [], title: "Old collection" }], errors: [] });
}

test("saving a different instance removes old library IDs and action credentials from the app", async () => {
  const app = await appHarness(async path => path.startsWith("/api/settings/")
    ? jsonResponse({ service: { url: "http://new-radarr" }, complete: true })
    : path === "/api/storage" ? jsonResponse({ disks: [], errors: [] }) : libraryResponse(path));
  await app.loadLibrary();
  assert.equal(app.snapshot().libraryItems.length, 1);
  app.setSettings({ services: { radarr: {} } });
  const button = app.getElement("save-button");
  const form = { dataset: { service: "radarr" }, elements: { url: { value: "http://new-radarr" }, apiKey: { value: "new-key" } }, querySelector: () => button };
  await app.saveServiceSettings(form);
  assert.equal(app.snapshot().libraryItems.length, 0);
  assert.equal(app.snapshot().collectionItems.length, 0);
  assert.equal(app.snapshot().configurationRevision, "");
});

test("a response already loading when settings change cannot restore stale library data", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await appHarness(async path => { await gate; return libraryResponse(path); });
  const loading = app.loadLibrary();
  assert.equal(app.getElement("#refreshButton").disabled, true);
  app.invalidateLibrary();
  release();
  await loading;
  assert.equal(app.snapshot().libraryItems.length, 0);
  assert.equal(app.snapshot().configurationRevision, "");
  assert.equal(app.getElement("#refreshButton").disabled, false);
  assert.equal(app.getElement("#loadingState").hidden, true);
});

test("Sonarr content renders in the app while the collections request fails", async () => {
  const app = await appHarness(async path => path.startsWith("/api/library")
    ? jsonResponse({ configurationRevision: "current", items: [{ id: 1, title: "Available show", service: "sonarr" }], errors: [] })
    : jsonResponse({ error: "Radarr offline" }, 500));
  await app.loadLibrary();
  assert.equal(app.snapshot().libraryItems[0].service, "sonarr");
  assert.equal(app.getElement("#mediaGrid").hidden, false);
  assert.match(app.getElement("#errorPanel").textContent, /Radarr offline/);
});
