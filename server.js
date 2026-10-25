import { randomUUID } from "node:crypto";
import { requireLibraryRevision, requireSafeWrite } from "./request-guards.js";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { createOperationQueue } from "./operation-queue.js";
import { createLibraryActions } from "./library-actions.js";
import {
  createJellyfinRefreshScheduler,
  requestJellyfinLibraryRefresh,
} from "./jellyfin-refresh.js";
import { createRadarrSnapshot } from "./radarr-snapshot.js";
import { createServiceTransport, requireConfiguredService } from "./service-transport.js";
import { groupStorageDisks } from "./storage-disks.js";
import {
  loadSettings,
  normalizeServiceSettings,
  publicSettings,
  saveSettings,
  validateServiceName,
} from "./settings-store.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const execFileAsync = promisify(execFile);

const { host: HOST, port: PORT } = config;
const serviceLabels = { radarr: "Radarr", sonarr: "Sonarr", jellyfin: "Jellyfin" };
let settings = await loadSettings(config.settingsFile);
let services = buildServices(settings);
let configurationRevision = randomUUID();
const runSettingsUpdate = createOperationQueue();
const { fetchJson, sendJson, deleteEndpoint } = createServiceTransport({
  readFallback: curlJson,
  onWrite: (service) => {
    if (service === services.radarr) radarrSnapshot.invalidate();
  },
});
const radarrSnapshot = createRadarrSnapshot({
  getService: () => services.radarr,
  fetchJson,
});

function buildServices(currentSettings) {
  return Object.fromEntries(
    Object.entries(serviceLabels).map(([name, label]) => [
      name,
      { label, ...currentSettings[name] },
    ]),
  );
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const appRoutes = new Set(["/", "/overview", "/movies", "/shows", "/collections", "/settings"]);

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (res.req?.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

function bytesToNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function getPosterUrl(serviceName, images = []) {
  const poster = images.find((image) => image.coverType === "poster");
  if (!poster) return "";
  if (poster.remoteUrl) return poster.remoteUrl;
  if (poster.url?.startsWith("http://") || poster.url?.startsWith("https://")) return poster.url;
  if (!poster.url) return "";
  return `/api/media?service=${serviceName}&path=${encodeURIComponent(poster.url)}`;
}

const scheduleJellyfinLibraryRefresh = createJellyfinRefreshScheduler(
  () => requestJellyfinLibraryRefresh(services.jellyfin),
  {
    onError: (error) => {
      console.warn(`Could not refresh Jellyfin after deletion: ${error.message}`);
    },
  },
);

async function curlJson(service, url) {
  const text = await curlText(service, url);
  if (!text) return null;
  return JSON.parse(text);
}

async function curlText(service, url) {
  requireConfiguredService(service);
  const args = [
    "-sS",
    "-w",
    "\n%{http_code}",
    "-X",
    "GET",
    "-H",
    `X-Api-Key: ${service.apiKey}`,
    "-H",
    "accept: application/json",
  ];

  args.push(url);

  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: 50 * 1024 * 1024,
    timeout: 30000,
  });
  const separator = stdout.lastIndexOf("\n");
  const responseBody = separator === -1 ? "" : stdout.slice(0, separator);
  const status = Number(separator === -1 ? stdout : stdout.slice(separator + 1));

  if (status < 200 || status >= 300) {
    throw new Error(`${service.label} responded ${status}${responseBody ? `: ${responseBody}` : ""}`);
  }

  return responseBody;
}

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

  const response = await fetch(mediaUrl, {
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

async function getRadarrItems() {
  const { movies, collections } = await radarrSnapshot.get();
  const collectionByMovieTmdbId = new Map();

  for (const collection of collections) {
    for (const movie of collection.movies || []) {
      collectionByMovieTmdbId.set(movie.tmdbId, {
        id: collection.id,
        title: collection.title || "Untitled",
        monitored: Boolean(collection.monitored),
      });
    }
  }

  return movies.map((movie) => {
    const collection = collectionByMovieTmdbId.get(movie.tmdbId);

    return {
      id: movie.id,
      service: "radarr",
      source: "Radarr",
      type: "Movie",
      title: movie.title || "Untitled",
      year: movie.year || null,
      collection: collection?.title || movie.collection?.title || "",
      collectionId: collection?.id || null,
      collectionMonitored: collection?.monitored || false,
      posterUrl: getPosterUrl("radarr", movie.images),
      path: movie.path || "",
      sizeOnDisk: bytesToNumber(movie.sizeOnDisk),
    };
  });
}

async function getRadarrCollections() {
  const { collections, movies } = await radarrSnapshot.get();
  const moviesByTmdbId = new Map(movies.map((movie) => [movie.tmdbId, movie]));

  return collections.map((collection) => {
    const collectionMovies = collection.movies.map((collectionMovie) => {
      const movie = moviesByTmdbId.get(collectionMovie.tmdbId);
      const isExisting = Boolean(movie);

      return {
        id: movie?.id || null,
        tmdbId: collectionMovie.tmdbId,
        title: movie?.title || collectionMovie.title || "Untitled",
        year: movie?.year || collectionMovie.year || null,
        isExisting,
        path: movie?.path || "",
        posterUrl: getPosterUrl("radarr", movie?.images?.length ? movie.images : collectionMovie.images),
        sizeOnDisk: isExisting ? bytesToNumber(movie.sizeOnDisk) : 0,
      };
    });

    return {
      id: collection.id,
      source: "Radarr",
      type: "Collection",
      title: collection.title || "Untitled",
      monitored: Boolean(collection.monitored),
      posterUrl: getPosterUrl("radarr", collection.images),
      movieCount: collectionMovies.length,
      existingMovieCount: collectionMovies.filter((movie) => movie.isExisting).length,
      missingMovieCount: collectionMovies.filter((movie) => !movie.isExisting).length,
      sizeOnDisk: collectionMovies.reduce((sum, movie) => sum + movie.sizeOnDisk, 0),
      movies: collectionMovies.sort((a, b) => (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title)),
    };
  });
}

async function getSonarrItems() {
  const series = await fetchJson(services.sonarr, "series");

  return series.map((show) => ({
    id: show.id,
    service: "sonarr",
    source: "Sonarr",
    type: "Show",
    title: show.title || "Untitled",
    year: show.year || null,
    monitored: Boolean(show.monitored),
    collection: "",
    posterUrl: getPosterUrl("sonarr", show.images),
    path: show.path || "",
    sizeOnDisk: bytesToNumber(show.statistics?.sizeOnDisk),
    seasons: (show.seasons || []).map((season) => ({
      seasonNumber: season.seasonNumber,
      monitored: Boolean(season.monitored),
      episodeFileCount: bytesToNumber(season.statistics?.episodeFileCount),
      episodeCount: bytesToNumber(season.statistics?.episodeCount),
      totalEpisodeCount: bytesToNumber(season.statistics?.totalEpisodeCount),
      sizeOnDisk: bytesToNumber(season.statistics?.sizeOnDisk),
    })),
  }));
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

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.status = 400;
    throw error;
  }
}

async function testServiceConnection(serviceName, input) {
  validateServiceName(serviceName);
  const candidate = normalizeServiceSettings(input, settings[serviceName]);
  const isJellyfin = serviceName === "jellyfin";
  const endpoint = isJellyfin ? "System/Info" : "api/v3/system/status";
  const url = `${candidate.url}/${endpoint}`;
  let response;

  try {
    response = await fetch(url, {
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
      await saveSettings(config.settingsFile, nextSettings);
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

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const safePath = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, appRoutes.has(safePath) ? "index.html" : safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
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
});

server.listen(PORT, HOST, () => {
  console.log(`Cleanerr running at http://${HOST}:${PORT}`);
});
