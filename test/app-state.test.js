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

test("a season offers Monitor only when effectively unmonitored and empty; otherwise Delete", async () => {
  const app = await appHarness();
  for (const seriesMonitored of [false, true]) {
    for (const seasonMonitored of [false, true]) {
      for (const files of [
        { episodeFileCount: 0, sizeOnDisk: 0 },
        { episodeFileCount: 2, sizeOnDisk: 100 },
        { episodeFileCount: 0, sizeOnDisk: 100 },
        { episodeFileCount: 2, sizeOnDisk: 0 },
      ]) {
        const season = { seasonNumber: 1, monitored: seasonMonitored, totalEpisodeCount: 10, ...files };
        const row = app.createSeasonItem(season, { id: 5, monitored: seriesMonitored }, "Show");
        const button = row.querySelector(".season-action-button");
        const hasFiles = files.episodeFileCount > 0 || files.sizeOnDisk > 0;
        const expected = !(seriesMonitored && seasonMonitored) && !hasFiles ? "Monitor" : "Delete";
        assert.equal(button.textContent, expected, JSON.stringify({ seriesMonitored, seasonMonitored, ...files }));
        assert.equal(button.disabled, false);
      }
    }
  }
});

test("episode counters expose green and red states with accessible descriptions", async () => {
  const app = await appHarness();
  const counter = app.getElement("episode-counter");
  counter.dataset.monitored = "true";
  app.renderSeasonAvailability(counter, { state: "up-to-date", episodeFileCount: 6, totalEpisodeCount: 10 });
  assert.equal(counter.dataset.short, "6/10");
  assert.equal(counter.classList.contains("is-up-to-date"), true);
  assert.equal(counter.classList.contains("is-missing"), false);
  assert.match(counter.getAttribute("aria-label"), /not aired yet/);
  app.renderSeasonAvailability(counter, { state: "missing", episodeFileCount: 0, totalEpisodeCount: 10, missingEpisodeCount: 10 });
  assert.equal(counter.dataset.short, "0/10");
  assert.equal(counter.classList.contains("is-up-to-date"), false);
  assert.equal(counter.classList.contains("is-missing"), true);
  assert.match(counter.title, /10 aired episode/);
  app.renderSeasonAvailability(counter, { state: "upcoming", episodeFileCount: 0, totalEpisodeCount: 10 });
  assert.equal(counter.classList.contains("is-missing"), false);
  assert.equal(counter.classList.contains("is-up-to-date"), false);
});


test("unmonitored seasons keep neutral counts even when aired episodes are missing", async () => {
  const app = await appHarness();
  for (const [seasonMonitored, seriesMonitored] of [[false, true], [true, false], [false, false]]) {
    const row = app.createSeasonItem(
      { seasonNumber: 0, monitored: seasonMonitored, episodeFileCount: 0, totalEpisodeCount: 17, sizeOnDisk: 0 },
      { id: 52, monitored: seriesMonitored }, "One-Punch Man",
    );
    const counter = row.querySelector(".season-episodes");
    for (const state of ["missing", "up-to-date"]) {
      app.renderSeasonAvailability(counter, { state, episodeFileCount: 0, totalEpisodeCount: 17, missingEpisodeCount: 16 });
      assert.equal(counter.dataset.short, "0/17");
      assert.equal(counter.classList.contains("is-missing"), false);
      assert.equal(counter.classList.contains("is-up-to-date"), false);
      assert.equal(counter.title, "Not monitored.");
      assert.match(counter.getAttribute("aria-label"), /Not monitored/);
    }
  }
});
