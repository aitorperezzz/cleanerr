import assert from "node:assert/strict";
import test from "node:test";
import { loadLibrarySnapshot } from "../public/library-loader.js";
import { jsonResponse } from "../test-support/server-harness.js";

const revision = "same-service-settings";

test("Sonarr stays visible when Radarr collections are unavailable", async () => {
  const show = { service: "sonarr", id: 1, title: "Available show" };
  const result = await loadLibrarySnapshot({ fetchImpl: async path => path.startsWith("/api/library")
    ? jsonResponse({ configurationRevision: revision, items: [show], errors: [{ source: "Radarr", message: "offline" }] }, 207)
    : jsonResponse({ error: "Radarr offline" }, 500) });
  assert.deepEqual(result.items, [show]);
  assert.deepEqual(result.collections, []);
  assert.equal(result.configurationRevision, revision);
  assert.equal(result.errors.length, 2);
});

test("collections remain available when the library request fails", async () => {
  const result = await loadLibrarySnapshot({ fetchImpl: async path => {
    if (path.startsWith("/api/library")) throw new Error("connection reset");
    return jsonResponse({ configurationRevision: revision, collections: [{ id: 6 }] });
  } });
  assert.deepEqual(result.collections, [{ id: 6 }]);
  assert.deepEqual(result.items, []);
  assert.match(result.errors[0].message, /connection reset/);
});

test("responses from different service configurations cannot be combined", async () => {
  await assert.rejects(loadLibrarySnapshot({ fetchImpl: async path => jsonResponse({ configurationRevision: path.startsWith("/api/library") ? "old" : "new" }) }), /settings changed/);
});

test("a malformed collections response does not discard valid library content", async () => {
  const result = await loadLibrarySnapshot({ fetchImpl: async path => path.startsWith("/api/library")
    ? jsonResponse({ configurationRevision: revision, items: [{ id: 2 }] })
    : { ok: true, json: async () => { throw new Error("invalid JSON"); } } });
  assert.deepEqual(result.items, [{ id: 2 }]);
  assert.match(result.errors[0].message, /invalid JSON/);
});

test("total failure returns an actionable error", async () => {
  await assert.rejects(loadLibrarySnapshot({ fetchImpl: async () => { throw new Error("offline"); } }), /offline/);
});
