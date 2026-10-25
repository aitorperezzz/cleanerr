import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

export const serviceNames = ["radarr", "sonarr", "jellyfin"];

function emptySettings() {
  return Object.fromEntries(serviceNames.map((name) => [name, { url: "", apiKey: "" }]));
}

function normalizeUrl(value, field = "URL") {
  const input = String(value || "").trim();
  let url;

  try {
    url = new URL(input);
  } catch {
    const error = new Error(`${field} must be a valid absolute URL`);
    error.status = 400;
    throw error;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    const error = new Error(`${field} must use http or https`);
    error.status = 400;
    throw error;
  }

  return url.toString().replace(/\/$/, "");
}

export function validateServiceName(name) {
  if (!serviceNames.includes(name)) {
    const error = new Error("Unknown service");
    error.status = 404;
    throw error;
  }
}

export function normalizeServiceSettings(input, current = {}, { optional = false } = {}) {
  const enteredUrl = String(input?.url || "").trim();
  if (optional && !enteredUrl) return { url: "", apiKey: "" };

  const url = normalizeUrl(enteredUrl);
  const enteredApiKey = String(input?.apiKey || "").trim();
  if (!enteredApiKey && current.apiKey && (!current.url || url !== normalizeUrl(current.url))) {
    const error = new Error("Enter an API key when changing the server URL.");
    error.status = 400;
    throw error;
  }
  const apiKey = enteredApiKey || String(current.apiKey || "").trim();

  if (!apiKey) {
    const error = new Error("API key is required");
    error.status = 400;
    throw error;
  }

  return { url, apiKey };
}

export async function loadSettings(filePath) {
  const settings = emptySettings();

  try {
    const stored = JSON.parse(await readFile(filePath, "utf8"));
    for (const name of serviceNames) {
      settings[name].url = String(stored[name]?.url || "").trim();
      settings[name].apiKey = String(stored[name]?.apiKey || "").trim();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return settings;
}

export async function saveSettings(filePath, settings) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryFile = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporaryFile, filePath);
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

export function publicSettings(settings) {
  const services = Object.fromEntries(
    serviceNames.map((name) => [
      name,
      {
        url: settings[name].url,
        apiKeyConfigured: Boolean(settings[name].apiKey),
        configured: Boolean(settings[name].url && settings[name].apiKey),
      },
    ]),
  );

  return {
    services,
    complete: ["radarr", "sonarr"].every((name) => services[name].configured),
  };
}
