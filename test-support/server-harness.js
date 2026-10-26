import { createApp } from "../server/app.js";

// Exercise the imported request handler without opening ports or contacting services.
export async function serverHarness({ fetchImpl, saveSettings = async () => {} } = {}) {
  const handler = await createApp({
    settingsFile: "/fake/config.json",
    fetchImpl,
    saveSettings,
    loadSettings: async () => Object.fromEntries(
      ["radarr", "sonarr", "jellyfin"].map(name => [name, { url: `http://${name}`, apiKey: `fake-${name}` }]),
    ),
    readFallback: async () => { throw new Error("Unexpected fallback"); },
  });
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
    return { status, headers: responseHeaders, body: responseBody ? (responseHeaders?.["content-type"]?.includes("application/json") ? JSON.parse(responseBody) : responseBody) : null };
  };
}

export function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
}
