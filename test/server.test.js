import assert from "node:assert/strict";
import test from "node:test";
import { serverHarness, jsonResponse } from "../test-support/server-harness.js";

test("changing service settings rejects stale actions before contacting the new instance", async () => {
  const writes = [];
  const request = await serverHarness({ fetchImpl: async (url, options) => {
    url = String(url);
    if (options.method) writes.push(url);
    return jsonResponse([]);
  } });
  const library = await request("/api/library");
  const collections = await request("/api/collections");
  assert.equal(library.body.configurationRevision, collections.body.configurationRevision);
  const headers = { "x-cleanerr-library-revision": library.body.configurationRevision };
  assert.equal((await request("/api/library/radarr/42", { method: "DELETE" })).status, 409);
  await request("/api/settings/radarr", { method: "PUT", body: { url: "http://new-radarr", apiKey: "new-key" } });
  assert.equal((await request("/api/library/radarr/42", { method: "DELETE", headers })).status, 409);
  assert.deepEqual(writes, []);
  const fresh = await request("/api/library");
  assert.equal((await request("/api/library/radarr/42", { method: "DELETE", headers: { "x-cleanerr-library-revision": fresh.body.configurationRevision } })).status, 200);
  assert.ok(writes[0].startsWith("http://new-radarr/"));
});

test("an in-flight collection deletion keeps its original service after settings change", async () => {
  let started, release;
  const waiting = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const request = await serverHarness({ fetchImpl: async (url, options) => {
    url = String(url);
    if (url.endsWith("/collection/6") && !options.method) { started(); await gate; return jsonResponse({ id: 6, movies: [{ tmdbId: 80 }] }); }
    if (options.method) writes.push(url);
    return jsonResponse(url.endsWith("/movie") ? [{ id: 8, tmdbId: 80 }] : []);
  } });
  const library = await request("/api/library");
  const deleting = request("/api/collections/6", { method: "DELETE", headers: { "x-cleanerr-library-revision": library.body.configurationRevision } });
  await waiting;
  await request("/api/settings/radarr", { method: "PUT", body: { url: "http://new-radarr", apiKey: "new-key" } });
  release();
  assert.equal((await deleting).status, 200);
  assert.ok(writes.every(url => url.startsWith("http://radarr/")));
});

test("connection tests reject cross-origin and plaintext requests without leaking saved keys", async () => {
  const calls = [];
  const request = await serverHarness({ fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonResponse({}); } });
  const body = { url: "https://untrusted.example", apiKey: "" };
  for (const headers of [
    { "x-cleanerr-request": undefined, "content-type": "text/plain" },
    { origin: "https://untrusted.example" },
    { "content-type": "text/plain" },
    {},
  ]) {
    const response = await request("/api/settings/radarr/test", { method: "POST", headers, body });
    assert.ok([400, 403, 415].includes(response.status));
  }
  assert.equal(calls.length, 0);
  assert.equal((await request("/api/settings/radarr/test", { method: "POST", body: { url: "http://radarr/" } })).status, 200);
  assert.equal(calls[0].options.headers["X-Api-Key"], "fake-radarr");
  assert.equal(calls[0].options.redirect, "error");
});

test("all library writes require the same-origin request guard", async () => {
  const request = await serverHarness({ fetchImpl: async () => jsonResponse([]) });
  const library = await request("/api/library");
  const headers = { "x-cleanerr-library-revision": library.body.configurationRevision, origin: "https://other.example" };
  assert.equal((await request("/api/library/radarr/42", { method: "DELETE", headers })).status, 403);
});

test("concurrent settings saves merge into the latest persisted state", async () => {
  const saved = [];
  const request = await serverHarness({
    fetchImpl: async () => jsonResponse([]),
    saveSettings: async (_path, value) => { await new Promise(resolve => setImmediate(resolve)); saved.push(structuredClone(value)); },
  });
  const responses = await Promise.all([
    request("/api/settings/radarr", { method: "PUT", body: { url: "http://new-radarr", apiKey: "r" } }),
    request("/api/settings/sonarr", { method: "PUT", body: { url: "http://new-sonarr", apiKey: "s" } }),
  ]);
  assert.ok(responses.every(response => response.status === 200));
  const current = (await request("/api/settings")).body.services;
  assert.equal(current.radarr.url, "http://new-radarr");
  assert.equal(current.sonarr.url, "http://new-sonarr");
  assert.equal(saved[1].radarr.url, current.radarr.url);
  assert.equal(saved[1].sonarr.url, current.sonarr.url);
});

test("a failed settings save changes neither live configuration nor the next transaction", async () => {
  let attempts = 0;
  const request = await serverHarness({ fetchImpl: async () => jsonResponse([]), saveSettings: async () => { if (++attempts === 1) throw new Error("disk full"); } });
  const responses = await Promise.all([
    request("/api/settings/radarr", { method: "PUT", body: { url: "http://failed-radarr", apiKey: "r" } }),
    request("/api/settings/sonarr", { method: "PUT", body: { url: "http://new-sonarr", apiKey: "s" } }),
  ]);
  assert.equal(responses[0].status, 500);
  assert.equal(responses[1].status, 200);
  const current = (await request("/api/settings")).body.services;
  assert.equal(current.radarr.url, "http://radarr");
  assert.equal(current.sonarr.url, "http://new-sonarr");
});

test("a failed collection command reports monitoring as completed without retrying the command", async () => {
  const writes = [];
  const request = await serverHarness({ fetchImpl: async (url, options) => {
    url = String(url);
    if (options.method) writes.push({ url, method: options.method });
    if (url.endsWith("/command")) return jsonResponse({ error: "command unavailable" }, 500);
    if (url.endsWith("/collection/6")) return jsonResponse({ id: 6, monitored: false, movies: [] });
    return jsonResponse([]);
  } });
  const library = await request("/api/library");
  const response = await request("/api/collections/6/monitor", { method: "PATCH", headers: { "x-cleanerr-library-revision": library.body.configurationRevision } });
  assert.equal(response.status, 502);
  assert.equal(response.body.partialResult.monitored, true);
  assert.equal(response.body.partialResult.commandConfirmed, false);
  assert.match(response.body.error, /monitoring was enabled/);
  assert.equal(writes.length, 2);
});

test("partial season deletions expose confirmed progress and stop after an uncertain failure", async () => {
  let deletes = 0;
  const request = await serverHarness({ fetchImpl: async (url, options) => {
    url = String(url);
    if (options.method === "DELETE" && ++deletes === 2) throw new Error("connection lost");
    if (url.endsWith("/series/5")) return jsonResponse({ id: 5, seasons: [{ seasonNumber: 1, monitored: true }] });
    if (url.includes("/episode?")) return jsonResponse([10, 11, 12].map(id => ({ seasonNumber: 1, episodeFileId: id, episodeFile: { size: 100 } })));
    return jsonResponse([]);
  } });
  const library = await request("/api/library");
  const response = await request("/api/library/sonarr/5/seasons/1", { method: "DELETE", headers: { "x-cleanerr-library-revision": library.body.configurationRevision } });
  assert.equal(response.status, 502);
  assert.equal(response.body.uncertain, true);
  assert.equal(response.body.partialResult.monitored, false);
  assert.equal(response.body.partialResult.deletedFiles, 1);
  assert.equal(response.body.partialResult.deletedSize, 100);
  assert.equal(response.body.partialResult.notAttemptedFiles, 1);
  assert.equal(deletes, 2);
});

test("season availability uses episode air dates, including unmonitored missing episodes", async () => {
  const reads = [];
  const request = await serverHarness({ fetchImpl: async url => {
    reads.push(String(url));
    return jsonResponse([
      { seasonNumber: 1, hasFile: false, monitored: false, airDateUtc: "2000-01-01T00:00:00Z" },
      { seasonNumber: 2, hasFile: true, airDateUtc: "2000-01-01T00:00:00Z" },
      { seasonNumber: 2, hasFile: false, airDateUtc: "2999-01-01T00:00:00Z" },
    ]);
  } });
  const response = await request("/api/library/sonarr/53/season-availability");
  assert.equal(response.status, 200);
  assert.ok(response.body.configurationRevision);
  assert.equal(response.body.seasons[0].state, "missing");
  assert.equal(response.body.seasons[1].state, "up-to-date");
  assert.deepEqual(reads, ["http://sonarr/api/v3/episode?seriesId=53"]);
});

test("application instances keep independent settings and library revisions", async () => {
  const first = await serverHarness({ fetchImpl: async () => jsonResponse([]) });
  const second = await serverHarness({ fetchImpl: async () => jsonResponse([]) });
  const firstRevision = (await first("/api/library")).body.configurationRevision;
  const secondRevision = (await second("/api/library")).body.configurationRevision;
  assert.notEqual(firstRevision, secondRevision);
  await first("/api/settings/radarr", { method: "PUT", body: { url: "http://first-radarr", apiKey: "r" } });
  assert.equal((await first("/api/settings")).body.services.radarr.url, "http://first-radarr");
  assert.equal((await second("/api/settings")).body.services.radarr.url, "http://radarr");
  assert.equal((await second("/api/library")).body.configurationRevision, secondRevision);
});

test("the imported application serves SPA routes and every browser module", async () => {
  const request = await serverHarness();
  for (const route of ["/", "/overview", "/movies", "/shows", "/collections", "/settings"]) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers["content-type"], /text\/html/);
    assert.match(response.body, /<title>Cleanerr<\/title>/);
  }
  for (const file of ["app.js", "detail-panel.js", "service-settings.js", "action-confirmation.js", "http-client.js", "library-utils.js", "library-loader.js", "library-action-client.js", "styles.css"]) {
    const response = await request(`/${file}`);
    assert.equal(response.status, 200, file);
    assert.match(response.headers["content-type"], file.endsWith(".css") ? /text\/css/ : /text\/javascript/);
    assert.ok(response.body.length > 0);
    assert.equal((await request(`/${file}`, { method: "HEAD" })).body, null);
  }
  assert.equal((await request("/missing.js")).status, 404);
});
