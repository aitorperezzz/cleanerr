import assert from "node:assert/strict";
import test from "node:test";
import { sendLibraryAction, refreshAfterActionError } from "../public/library-action-client.js";
import { jsonResponse } from "../test-support/server-harness.js";

test("partial write errors retain completed stages and refresh without retrying", async () => {
  let writes = 0, refreshes = 0, rendered;
  const partialResult = { source: "Sonarr", monitored: false, deletedFiles: 1, totalFiles: 3 };
  let failure;
  try {
    await sendLibraryAction("/api/library/sonarr/1/seasons/1", { method: "DELETE" }, {
      configurationRevision: "current",
      fetchImpl: async (_url, options) => {
        writes += 1;
        assert.equal(options.headers["X-Cleanerr-Library-Revision"], "current");
        assert.equal(options.headers["X-Cleanerr-Request"], "1");
        return jsonResponse({ error: "Season unmonitored; one file deleted", partialResult, uncertain: true }, 502);
      },
    });
    assert.fail("Expected partial failure");
  } catch (error) { failure = error; }
  assert.deepEqual(failure.partialResult, partialResult);
  assert.equal(failure.uncertain, true);
  await refreshAfterActionError(failure, {
    reload: async () => { refreshes += 1; return { errors: [{ source: "Radarr", message: "offline" }] }; },
    render: errors => { rendered = errors; },
  });
  assert.equal(writes, 1);
  assert.equal(refreshes, 1);
  assert.equal(rendered[0].message, failure.message);
  assert.equal(rendered[1].message, "offline");
});

test("an unsuccessful refresh cannot hide the original action error", async () => {
  let rendered;
  await refreshAfterActionError(new Error("Search was not confirmed"), {
    reload: async () => { throw new Error("disconnected"); },
    render: errors => { rendered = errors; },
  });
  assert.match(rendered[0].message, /Search was not confirmed/);
  assert.match(rendered[1].message, /disconnected/);
});

test("network write failures are never retried and explain uncertain completion", async () => {
  let writes = 0;
  await assert.rejects(sendLibraryAction("/api/library/radarr/1", { method: "DELETE" }, {
    configurationRevision: "current", fetchImpl: async () => { writes += 1; throw new Error("timeout"); },
  }), /Could not confirm whether the action completed/);
  assert.equal(writes, 1);
});
