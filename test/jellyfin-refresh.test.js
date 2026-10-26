import assert from "node:assert/strict";
import test from "node:test";
import {
  createJellyfinRefreshScheduler,
  requestJellyfinLibraryRefresh,
} from "../server/jellyfin-refresh.js";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("requests a Jellyfin library refresh with the configured credentials", async () => {
  const calls = [];
  const refreshed = await requestJellyfinLibraryRefresh(
    { url: "http://jellyfin:8096", apiKey: "secret" },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 204 };
      },
    },
  );

  assert.equal(refreshed, true);
  assert.equal(calls[0].url, "http://jellyfin:8096/Library/Refresh");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Emby-Token"], "secret");
  assert.match(calls[0].options.headers.Authorization, /Token="secret"/);
});

test("does not request a refresh when Jellyfin is not configured", async () => {
  let requested = false;
  const refreshed = await requestJellyfinLibraryRefresh(
    { url: "", apiKey: "" },
    { fetchImpl: async () => { requested = true; } },
  );

  assert.equal(refreshed, false);
  assert.equal(requested, false);
});

test("closely timed deletions schedule one Jellyfin refresh", async () => {
  let refreshes = 0;
  const scheduleRefresh = createJellyfinRefreshScheduler(
    async () => { refreshes += 1; },
    { delayMs: 5 },
  );

  scheduleRefresh();
  scheduleRefresh();
  scheduleRefresh();
  await wait(20);

  assert.equal(refreshes, 1);
});

test("a Jellyfin refresh failure is reported without rejecting the deletion flow", async () => {
  const errors = [];
  const scheduleRefresh = createJellyfinRefreshScheduler(
    async () => { throw new Error("Jellyfin unavailable"); },
    { delayMs: 5, onError: (error) => errors.push(error.message) },
  );

  assert.equal(scheduleRefresh(), undefined);
  await wait(20);

  assert.deepEqual(errors, ["Jellyfin unavailable"]);
});
