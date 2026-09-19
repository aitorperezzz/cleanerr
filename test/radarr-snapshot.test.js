import assert from "node:assert/strict";
import test from "node:test";
import { createRadarrSnapshot } from "../radarr-snapshot.js";

test("concurrent readers share one Radarr movie and collection request", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const snapshot = createRadarrSnapshot({
    getService: () => ({ label: "Radarr" }),
    fetchJson: async (_service, endpoint) => {
      calls.push(endpoint);
      await gate;
      return endpoint === "movie" ? [{ id: 1 }] : [{ id: 2 }];
    },
  });

  const first = snapshot.get();
  const second = snapshot.get();
  release();
  const [left, right] = await Promise.all([first, second]);

  assert.deepEqual(calls, ["movie", "collection"]);
  assert.strictEqual(left, right);
});

test("invalidating the snapshot forces a fresh read", async () => {
  const calls = [];
  const snapshot = createRadarrSnapshot({
    getService: () => ({}),
    fetchJson: async (_service, endpoint) => {
      calls.push(endpoint);
      return [];
    },
  });

  await snapshot.get();
  snapshot.invalidate();
  await snapshot.get();
  assert.deepEqual(calls, ["movie", "collection", "movie", "collection"]);
});

test("a failed shared read is not retained", async () => {
  let attempts = 0;
  const snapshot = createRadarrSnapshot({
    getService: () => ({}),
    fetchJson: async (_service, endpoint) => {
      if (endpoint === "movie" && attempts++ === 0) throw new Error("offline");
      return [];
    },
  });

  await assert.rejects(snapshot.get(), /offline/);
  await snapshot.get();
  assert.ok(attempts >= 2);
});
