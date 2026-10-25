import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadSettings,
  normalizeServiceSettings,
  publicSettings,
  saveSettings,
  validateServiceName,
} from "../settings-store.js";

test("missing settings files produce an empty configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanerr-settings-"));
  try {
    const settings = await loadSettings(join(directory, "missing.json"));
    assert.deepEqual(settings.radarr, { url: "", apiKey: "" });
    assert.deepEqual(settings.sonarr, { url: "", apiKey: "" });
    assert.deepEqual(settings.jellyfin, { url: "", apiKey: "" });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("service settings normalize URLs and preserve a saved API key", () => {
  assert.deepEqual(
    normalizeServiceSettings(
      { url: " http://radarr:7878/ ", apiKey: "" },
      { url: "http://radarr:7878", apiKey: "saved-key" },
    ),
    { url: "http://radarr:7878", apiKey: "saved-key" },
  );
  assert.throws(
    () => normalizeServiceSettings({ url: "file:///tmp/radarr", apiKey: "key" }),
    { message: "URL must use http or https", status: 400 },
  );
});

test("Jellyfin can be disabled without blocking Radarr and Sonarr", () => {
  const settings = {
    radarr: { url: "http://radarr", apiKey: "r" },
    sonarr: { url: "http://sonarr", apiKey: "s" },
    jellyfin: normalizeServiceSettings(
      { url: "", apiKey: "" },
      { url: "http://jellyfin", apiKey: "saved-key" },
      { optional: true },
    ),
  };

  assert.deepEqual(settings.jellyfin, { url: "", apiKey: "" });
  assert.equal(publicSettings(settings).complete, true);
  assert.equal(publicSettings(settings).services.jellyfin.configured, false);
  assert.throws(
    () => normalizeServiceSettings({ url: "", apiKey: "" }),
    { message: "URL must be a valid absolute URL", status: 400 },
  );
});

test("public settings never expose API keys", () => {
  const result = publicSettings({
    radarr: { url: "http://radarr", apiKey: "secret-r" },
    sonarr: { url: "http://sonarr", apiKey: "secret-s" },
    jellyfin: { url: "http://jellyfin", apiKey: "secret-j" },
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.services.radarr, {
    url: "http://radarr",
    apiKeyConfigured: true,
    configured: true,
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("settings are written atomically with private file permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cleanerr-settings-"));
  const file = join(directory, "nested", "config.json");
  const settings = {
    radarr: { url: "http://radarr", apiKey: "r" },
    sonarr: { url: "http://sonarr", apiKey: "s" },
    jellyfin: { url: "http://jellyfin", apiKey: "j" },
  };
  try {
    await saveSettings(file, settings);
    assert.deepEqual(await loadSettings(file), settings);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(file, "utf8"), /\.tmp/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("unknown service names are rejected", () => {
  assert.throws(() => validateServiceName("lidarr"), { message: "Unknown service", status: 404 });
});


test("saved API keys cannot be forwarded to a different server URL", () => {
  const saved = { url: "http://radarr:7878", apiKey: "saved-key" };
  assert.throws(() => normalizeServiceSettings({ url: "https://other.example" }, saved), { status: 400 });
  assert.equal(normalizeServiceSettings({ url: "https://other.example", apiKey: "new-key" }, saved).apiKey, "new-key");
});
