import assert from "node:assert/strict";
import test from "node:test";
import { createServiceTransport } from "../server/service-transport.js";

const radarr = { label: "Radarr", url: "http://radarr:7878", apiKey: "key" };

test("failed writes are sent once and never use the read fallback", async () => {
  const calls = [];
  const transport = createServiceTransport({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      throw new Error("Timed out after request was sent");
    },
    readFallback: () => { throw new Error("Read fallback must not be used for writes"); },
  });

  await assert.rejects(
    transport.sendJson(radarr, "command", "POST", { name: "RefreshMovie" }),
    /Check Radarr before retrying/,
  );
  await assert.rejects(
    transport.deleteEndpoint(radarr, "http://radarr:7878/api/v3/movie/42"),
    /Check Radarr before retrying/,
  );

  assert.deepEqual(calls.map((call) => call.method), ["POST", "DELETE"]);
});

test("read fallback remains available when a GET fails", async () => {
  let fallbackCalls = 0;
  const transport = createServiceTransport({
    fetchImpl: async () => { throw new Error("Connection failed"); },
    readFallback: async () => {
      fallbackCalls += 1;
      return { id: 42 };
    },
  });

  assert.deepEqual(await transport.fetchJson(radarr, "movie/42"), { id: 42 });
  assert.equal(fallbackCalls, 1);
});
