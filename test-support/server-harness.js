import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, normalize, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import vm from "node:vm";
import * as guards from "../request-guards.js";
import * as settingsStore from "../settings-store.js";
import * as transport from "../service-transport.js";
import { createOperationQueue } from "../operation-queue.js";
import { createLibraryActions } from "../library-actions.js";
import { createRadarrSnapshot } from "../radarr-snapshot.js";
import * as jellyfin from "../jellyfin-refresh.js";
import { getSeasonAvailability } from "../season-availability.js";
import { groupStorageDisks } from "../storage-disks.js";

// Execute the actual request handler with in-memory HTTP and fake service responses.
export async function serverHarness({ fetchImpl, saveSettings = async () => {} } = {}) {
  let handler;
  const source = (await readFile(new URL("../server.js", import.meta.url), "utf8"))
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replaceAll("import.meta.url", JSON.stringify(new URL("../server.js", import.meta.url).href));
  const context = vm.createContext({
    ...guards, ...settingsStore, ...jellyfin, ...transport,
    createLibraryActions, createRadarrSnapshot, groupStorageDisks, createOperationQueue, getSeasonAvailability,
    readFile, fileURLToPath, join, normalize, extname, randomUUID, promisify,
    URL, Buffer, AbortSignal, console: { log() {}, warn() {} },
    config: { host: "127.0.0.1", port: 3050, settingsFile: "/fake/config.json" },
    execFile: (_cmd, _args, _opts, callback) => callback(new Error("Unexpected fallback")),
    loadSettings: async () => Object.fromEntries(["radarr", "sonarr", "jellyfin"].map(name => [name, { url: `http://${name}`, apiKey: `fake-${name}` }])),
    saveSettings,
    fetch: fetchImpl,
    createServiceTransport: (options) => transport.createServiceTransport({ ...options, fetchImpl }),
    createServer: (callback) => { handler = callback; return { listen() {} }; },
  });
  await vm.runInContext(`(async () => { ${source}\n })()`, context);
  return async function request(path, { method = "GET", body, headers = {} } = {}) {
    let status, responseHeaders, responseBody;
    const req = {
      url: path, method,
      headers: { host: "cleanerr.local", origin: "http://cleanerr.local", "content-type": "application/json", "x-cleanerr-request": "1", ...headers },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
    };
    const res = {
      req,
      writeHead(code, values) { status = code; responseHeaders = values; },
      end(value = "") { responseBody = String(value); },
    };
    await handler(req, res);
    return { status, headers: responseHeaders, body: responseBody ? JSON.parse(responseBody) : null };
  };
}

export function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
}
