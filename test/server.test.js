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
