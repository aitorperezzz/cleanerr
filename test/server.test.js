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
