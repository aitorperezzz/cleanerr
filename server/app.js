import { randomUUID } from "node:crypto";
import { requireLibraryRevision, requireSafeWrite } from "./request-guards.js";
import { createOperationQueue } from "./operation-queue.js";
import { createLibraryActions } from "./library-actions.js";
import {
  createJellyfinRefreshScheduler,
  requestJellyfinLibraryRefresh,
} from "./jellyfin-refresh.js";
import { createRadarrSnapshot } from "./radarr-snapshot.js";
import { createServiceTransport, requireConfiguredService } from "./service-transport.js";
import { getSeasonAvailability } from "./season-availability.js";
import { groupStorageDisks } from "./storage-disks.js";
import {
  loadSettings as readSettings,
  normalizeServiceSettings,
  publicSettings,
  saveSettings as writeSettings,
  validateServiceName,
} from "./settings-store.js";

import { jsonResponse, readJsonBody } from "./http-utils.js";
import { serveStatic } from "./static-files.js";
import { createLibraryReader } from "./library-reader.js";
import { curlJson } from "./curl-client.js";

export async function createApp({
  settingsFile,
  fetchImpl = fetch,
  loadSettings = readSettings,
  saveSettings = writeSettings,
  readFallback = curlJson,
}) {
  const serviceLabels = { radarr: "Radarr", sonarr: "Sonarr", jellyfin: "Jellyfin" };
  let settings = await loadSettings(settingsFile);
  let services = buildServices(settings);
  let configurationRevision = randomUUID();
  const runSettingsUpdate = createOperationQueue();
  const { fetchJson, sendJson, deleteEndpoint } = createServiceTransport({
    fetchImpl,
    readFallback,
    onWrite: (service) => {
      if (service === services.radarr) radarrSnapshot.invalidate();
    },
  });
  const radarrSnapshot = createRadarrSnapshot({
    getService: () => services.radarr,
    fetchJson,
  });

  const { getRadarrItems, getRadarrCollections, getSonarrItems } = createLibraryReader({
    radarrSnapshot, fetchJson, getServices: () => services,
  });

  function buildServices(currentSettings) {
    return Object.fromEntries(
      Object.entries(serviceLabels).map(([name, label]) => [
        name,
        { label, ...currentSettings[name] },
      ]),
    );
  }

  const scheduleJellyfinLibraryRefresh = createJellyfinRefreshScheduler(
    () => requestJellyfinLibraryRefresh(services.jellyfin, { fetchImpl }),
    {
      onError: (error) => {
        console.warn(`Could not refresh Jellyfin after deletion: ${error.message}`);
      },
    },
  );

  function libraryActions() {
    const serviceSnapshot = services;
    return createLibraryActions({
      getService: (name) => serviceSnapshot[name],
      fetchJson,
      sendJson,
      deleteEndpoint,
      refreshJellyfinLibrary: scheduleJellyfinLibraryRefresh,
    });
  }

  async function proxyMedia(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const serviceName = url.searchParams.get("service");
    const path = url.searchParams.get("path");
    const service = services[serviceName];

    if (!service || !path?.startsWith("/MediaCover/")) {
      jsonResponse(res, 400, { error: "Invalid media request" });
      return;
    }

    requireConfiguredService(service);

    const mediaUrl = new URL(`${service.url}${path}`);
    mediaUrl.searchParams.set("apikey", service.apiKey);

    const response = await fetchImpl(mediaUrl, {
      redirect: "error",
      method: req.method,
      headers: {
        "X-Api-Key": service.apiKey,
        accept: "image/*",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      jsonResponse(res, response.status, { error: `${service.label} responded ${response.status}` });
      return;
    }

    const image = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, {
      "content-type": response.headers.get("content-type") || "image/jpeg",
      "cache-control": "private, max-age=86400, stale-while-revalidate=604800",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(image);
  }

  async function handleSeasonAvailability(req, res, seriesId) {
    const revision = configurationRevision;
    const sonarr = services.sonarr;
    const episodes = await fetchJson(sonarr, `episode?seriesId=${Number(seriesId)}`);
    jsonResponse(res, 200, {
      configurationRevision: revision,
      seasons: getSeasonAvailability(episodes),
    });
  }

  async function handleApiLibrary(req, res) {
    const revision = configurationRevision;
    const results = await Promise.allSettled([getRadarrItems(), getSonarrItems()]);
    const items = results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .sort((a, b) => b.sizeOnDisk - a.sizeOnDisk || a.title.localeCompare(b.title));

    const errors = results
      .map((result, index) => {
        if (result.status === "fulfilled") return null;
        const source = index === 0 ? "Radarr" : "Sonarr";
        return { source, message: result.reason?.message || "Unknown error" };
      })
      .filter(Boolean);

    jsonResponse(res, errors.length ? 207 : 200, {
      configurationRevision: revision,
      updatedAt: new Date().toISOString(),
      totalSizeOnDisk: items.reduce((sum, item) => sum + item.sizeOnDisk, 0),
      count: items.length,
      items,
      errors,
    });
  }

  async function testServiceConnection(serviceName, input) {
    validateServiceName(serviceName);
    const candidate = normalizeServiceSettings(input, settings[serviceName]);
    const isJellyfin = serviceName === "jellyfin";
    const endpoint = isJellyfin ? "System/Info" : "api/v3/system/status";
    const url = `${candidate.url}/${endpoint}`;
    let response;

    try {
      response = await fetchImpl(url, {
        redirect: "error",
        headers: isJellyfin
          ? {
              Authorization: `MediaBrowser Client="Cleanerr", Device="Cleanerr", DeviceId="cleanerr", Version="0.1.0", Token="${candidate.apiKey}"`,
              "X-Emby-Token": candidate.apiKey,
              accept: "application/json",
            }
          : { "X-Api-Key": candidate.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
    } catch (cause) {
      const error = new Error(`Could not connect to ${serviceLabels[serviceName]}`);
      error.status = 502;
      error.cause = cause;
      throw error;
    }

    if (!response.ok) {
      const message =
        response.status === 401
          ? `${serviceLabels[serviceName]} rejected the API key (401 Unauthorized)`
          : response.status === 403
            ? `${serviceLabels[serviceName]} connected, but the API key lacks permission (403 Forbidden)`
            : `${serviceLabels[serviceName]} responded ${response.status}`;
      const error = new Error(message);
      error.status = 502;
      throw error;
    }

    const status = await response.json().catch(() => ({}));
    return {
      ok: true,
      name:
        status.instanceName ||
        status.appName ||
        status.ServerName ||
        serviceLabels[serviceName],
      version: status.version || status.Version || "",
    };
  }

  async function handleSettings(req, res) {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);

    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/settings") {
      jsonResponse(res, 200, publicSettings(settings));
      return;
    }

    const match = pathname.match(/^\/api\/settings\/(radarr|sonarr|jellyfin)(\/test)?$/);
    if (!match) {
      jsonResponse(res, 404, { error: "Not found" });
      return;
    }

    const [, serviceName, action] = match;
    const body = await readJsonBody(req);

    if (req.method === "POST" && action === "/test") {
      const connection = await testServiceConnection(serviceName, body);
      jsonResponse(res, 200, { connection });
      return;
    }

    if (req.method === "PUT" && !action) {
      const result = await runSettingsUpdate("settings", async () => {
        const serviceSettings = normalizeServiceSettings(body, settings[serviceName], {
          optional: serviceName === "jellyfin",
        });
        const nextSettings = { ...settings, [serviceName]: serviceSettings };
        await saveSettings(settingsFile, nextSettings);
        settings = nextSettings;
        services = buildServices(settings);
        configurationRevision = randomUUID();
        radarrSnapshot.invalidate();
        return {
          service: publicSettings(settings).services[serviceName],
          complete: publicSettings(settings).complete,
        };
      });
      jsonResponse(res, 200, result);
      return;
    }

    jsonResponse(res, 405, { error: "Method not allowed" });
  }

  async function handleApiCollections(req, res) {
    const revision = configurationRevision;
    const collections = await getRadarrCollections();

    jsonResponse(res, 200, {
      configurationRevision: revision,
      updatedAt: new Date().toISOString(),
      totalSizeOnDisk: collections.reduce((sum, collection) => sum + collection.sizeOnDisk, 0),
      count: collections.length,
      collections,
      errors: [],
    });
  }

  async function handleApiStorage(req, res) {
    const results = await Promise.all(
      ["radarr", "sonarr"].map(async (serviceName) => {
        const service = services[serviceName];
        try {
          const disks = await fetchJson(service, "diskspace");
          return {
            disks: groupStorageDisks(disks, serviceName, service.label),
            error: null,
          };
        } catch (error) {
          return {
            disks: [],
            error: { source: service.label, message: error.message },
          };
        }
      }),
    );
    const errors = results.flatMap((result) => (result.error ? [result.error] : []));

    jsonResponse(res, errors.length ? 207 : 200, {
      updatedAt: new Date().toISOString(),
      disks: results.flatMap((result) => result.disks),
      errors,
    });
  }

  async function handleCollectionAction(req, res) {
    requireLibraryRevision(req, configurationRevision);
    const { setCollectionMonitoring, deleteCollection } = libraryActions();
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    const monitorMatch = pathname.match(/^\/api\/collections\/(\d+)\/monitor$/);
    const unmonitorMatch = pathname.match(/^\/api\/collections\/(\d+)\/unmonitor$/);
    const deleteMatch = pathname.match(/^\/api\/collections\/(\d+)$/);

    if (req.method === "PATCH" && monitorMatch) {
      const collection = await setCollectionMonitoring(monitorMatch[1], true);
      jsonResponse(res, 200, { collection });
      return;
    }

    if (req.method === "PATCH" && unmonitorMatch) {
      const collection = await setCollectionMonitoring(unmonitorMatch[1], false);
      jsonResponse(res, 200, { collection });
      return;
    }

    if (req.method === "DELETE" && deleteMatch) {
      const deleted = await deleteCollection(deleteMatch[1]);
      jsonResponse(res, deleted.failure ? 207 : 200, { deleted });
      return;
    }

    jsonResponse(res, 404, { error: "Not found" });
  }

  async function handleLibraryAction(req, res) {
    requireLibraryRevision(req, configurationRevision);
    const { unmonitorCollectionAndDeleteMovie, setSeasonMonitoring, setSeriesMonitoring, removeSeason, deleteFromService } = libraryActions();
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    const seasonMatch = pathname.match(/^\/api\/library\/sonarr\/(\d+)\/seasons\/(\d+)$/);
    const monitorSeasonMatch = pathname.match(/^\/api\/library\/sonarr\/(\d+)\/seasons\/(\d+)\/monitor$/);
    const monitorSeriesMatch = pathname.match(/^\/api\/library\/sonarr\/(\d+)\/monitor$/);
    const collectionSafeMovieMatch = pathname.match(/^\/api\/library\/radarr\/(\d+)\/collection-safe$/);

    if (req.method === "DELETE" && collectionSafeMovieMatch) {
      const deleted = await unmonitorCollectionAndDeleteMovie(collectionSafeMovieMatch[1]);
      jsonResponse(res, 200, { deleted });
      return;
    }

    if (req.method === "PATCH" && monitorSeasonMatch) {
      const series = await setSeasonMonitoring(monitorSeasonMatch[1], monitorSeasonMatch[2], true);
      jsonResponse(res, 200, { series });
      return;
    }

    if (req.method === "PATCH" && monitorSeriesMatch) {
      const series = await setSeriesMonitoring(monitorSeriesMatch[1], true);
      jsonResponse(res, 200, { series });
      return;
    }

    if (req.method === "DELETE" && seasonMatch) {
      const removed = await removeSeason(seasonMatch[1], seasonMatch[2]);
      jsonResponse(res, 200, { removed });
      return;
    }

    const match = pathname.match(/^\/api\/library\/(radarr|sonarr)\/(\d+)$/);

    if (!match) {
      jsonResponse(res, 404, { error: "Not found" });
      return;
    }

    if (req.method !== "DELETE") {
      jsonResponse(res, 405, { error: "Method not allowed" });
      return;
    }

    const deleted = await deleteFromService(match[1], match[2]);
    jsonResponse(res, 200, { deleted });
  }

  return async function handleRequest(req, res) {
    try {
      requireSafeWrite(req);
      if (req.url?.startsWith("/api/settings")) {
        await handleSettings(req, res);
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && req.url?.startsWith("/api/storage")) {
        await handleApiStorage(req, res);
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && req.url?.startsWith("/api/media")) {
        await proxyMedia(req, res);
        return;
      }

      if ((req.method === "PATCH" || req.method === "DELETE") && req.url?.startsWith("/api/library/")) {
        await handleLibraryAction(req, res);
        return;
      }

      if ((req.method === "PATCH" || req.method === "DELETE") && req.url?.startsWith("/api/collections/")) {
        await handleCollectionAction(req, res);
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && req.url?.startsWith("/api/collections")) {
        await handleApiCollections(req, res);
        return;
      }

      const seasonAvailabilityMatch = new URL(req.url, `http://${req.headers.host}`).pathname
        .match(/^\/api\/library\/sonarr\/(\d+)\/season-availability$/);
      if ((req.method === "GET" || req.method === "HEAD") && seasonAvailabilityMatch) {
        await handleSeasonAvailability(req, res, seasonAvailabilityMatch[1]);
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && req.url?.startsWith("/api/library")) {
        await handleApiLibrary(req, res);
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(req, res);
        return;
      }

      jsonResponse(res, 405, { error: "Method not allowed" });
    } catch (error) {
      jsonResponse(res, error.status || 500, {
        error: error.message || "Internal server error",
        ...(error.partialResult ? { partialResult: error.partialResult } : {}),
        ...(error.uncertain ? { uncertain: true } : {}),
      });
    }
  };
}
