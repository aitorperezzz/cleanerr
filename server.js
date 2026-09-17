import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const execFileAsync = promisify(execFile);

const { host: HOST, port: PORT, services } = config;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

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

async function fetchJson(service, endpoint) {
  const url = `${service.url}/api/v3/${endpoint}`;
  let response;

  try {
    response = await fetch(url, {
      headers: {
        "X-Api-Key": service.apiKey,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    return curlJson(service, url);
  }

  if (!response.ok) {
    throw new Error(`${service.label} responded ${response.status}`);
  }

  return response.json();
}

async function sendJson(service, endpoint, method, body) {
  const url = `${service.url}/api/v3/${endpoint}`;
  let response;

  try {
    response = await fetch(url, {
      method,
      headers: {
        "X-Api-Key": service.apiKey,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return curlJson(service, url, { method, body });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${service.label} responded ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

async function deleteEndpoint(service, url) {
  let response;

  try {
    response = await fetch(url, {
      method: "DELETE",
      headers: {
        "X-Api-Key": service.apiKey,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    await curlText(service, url, { method: "DELETE" });
    return;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${service.label} responded ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

async function curlJson(service, url, options = {}) {
  const text = await curlText(service, url, options);
  if (!text) return null;
  return JSON.parse(text);
}

async function curlText(service, url, { method = "GET", body } = {}) {
  const args = [
    "-sS",
    "-L",
    "-w",
    "\n%{http_code}",
    "-X",
    method,
    "-H",
    `X-Api-Key: ${service.apiKey}`,
    "-H",
    "accept: application/json",
  ];

  if (body !== undefined) {
    args.push("-H", "content-type: application/json", "--data", JSON.stringify(body));
  }

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

async function proxyMedia(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const serviceName = url.searchParams.get("service");
  const path = url.searchParams.get("path");
  const service = services[serviceName];

  if (!service || !path?.startsWith("/MediaCover/")) {
    jsonResponse(res, 400, { error: "Invalid media request" });
    return;
  }

  const mediaUrl = new URL(`${service.url}${path}`);
  mediaUrl.searchParams.set("apikey", service.apiKey);

  const response = await fetch(mediaUrl, {
    method,
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
    "cache-control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(image);
}

async function deleteFromService(serviceName, itemId) {
  const service = services[serviceName];
  const numericId = Number(itemId);

  if (!service || !Number.isInteger(numericId) || numericId <= 0) {
    const error = new Error("Invalid library item");
    error.status = 400;
    throw error;
  }

  const endpoint = serviceName === "radarr" ? "movie" : "series";
  const exclusionParam = serviceName === "radarr" ? "addImportExclusion" : "addImportListExclusion";
  const url = new URL(`${service.url}/api/v3/${endpoint}/${numericId}`);
  url.searchParams.set("deleteFiles", "true");
  url.searchParams.set(exclusionParam, "true");

  await deleteEndpoint(service, url);

  return { source: service.label, id: numericId };
}

async function deleteEpisodeFile(episodeFileId) {
  const numericId = Number(episodeFileId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    const error = new Error("Invalid episode file");
    error.status = 400;
    throw error;
  }

  await deleteEndpoint(services.sonarr, `${services.sonarr.url}/api/v3/episodefile/${numericId}`);
}

async function removeSeason(seriesId, seasonNumber) {
  const numericSeriesId = Number(seriesId);
  const numericSeasonNumber = Number(seasonNumber);

  if (
    !Number.isInteger(numericSeriesId) ||
    numericSeriesId <= 0 ||
    !Number.isInteger(numericSeasonNumber) ||
    numericSeasonNumber < 0
  ) {
    const error = new Error("Invalid season");
    error.status = 400;
    throw error;
  }

  const [series, episodes] = await Promise.all([
    fetchJson(services.sonarr, `series/${numericSeriesId}`),
    fetchJson(services.sonarr, `episode?seriesId=${numericSeriesId}&includeEpisodeFile=true`),
  ]);
  const season = series.seasons?.find((item) => item.seasonNumber === numericSeasonNumber);

  if (!season) {
    const error = new Error("Season not found");
    error.status = 404;
    throw error;
  }

  season.monitored = false;
  await sendJson(services.sonarr, `series/${numericSeriesId}`, "PUT", series);

  const episodeFiles = episodes
    .filter((episode) => episode.seasonNumber === numericSeasonNumber && episode.episodeFileId > 0)
    .map((episode) => ({
      id: episode.episodeFileId,
      size: bytesToNumber(episode.episodeFile?.size),
    }));
  const uniqueEpisodeFiles = [...new Map(episodeFiles.map((file) => [file.id, file])).values()];

  for (const episodeFile of uniqueEpisodeFiles) {
    await deleteEpisodeFile(episodeFile.id);
  }

  return {
    source: "Sonarr",
    seriesId: numericSeriesId,
    seasonNumber: numericSeasonNumber,
    deletedFiles: uniqueEpisodeFiles.length,
    deletedSize: uniqueEpisodeFiles.reduce((sum, file) => sum + file.size, 0),
  };
}

async function setSeriesMonitoring(seriesId, monitored) {
  const numericSeriesId = Number(seriesId);
  if (!Number.isInteger(numericSeriesId) || numericSeriesId <= 0) {
    const error = new Error("Invalid series");
    error.status = 400;
    throw error;
  }

  const series = await fetchJson(services.sonarr, `series/${numericSeriesId}`);
  series.monitored = monitored;
  return sendJson(services.sonarr, `series/${numericSeriesId}`, "PUT", series);
}

async function setSeasonMonitoring(seriesId, seasonNumber, monitored) {
  const numericSeriesId = Number(seriesId);
  const numericSeasonNumber = Number(seasonNumber);

  if (
    !Number.isInteger(numericSeriesId) ||
    numericSeriesId <= 0 ||
    !Number.isInteger(numericSeasonNumber) ||
    numericSeasonNumber < 0
  ) {
    const error = new Error("Invalid season");
    error.status = 400;
    throw error;
  }

  const series = await fetchJson(services.sonarr, `series/${numericSeriesId}`);
  series.monitored = true;
  const season = series.seasons?.find((item) => item.seasonNumber === numericSeasonNumber);

  if (!season) {
    const error = new Error("Season not found");
    error.status = 404;
    throw error;
  }

  season.monitored = monitored;
  return sendJson(services.sonarr, `series/${numericSeriesId}`, "PUT", series);
}

async function getRadarrItems() {
  const [movies, collections] = await Promise.all([
    fetchJson(services.radarr, "movie"),
    fetchJson(services.radarr, "collection"),
  ]);
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
  const [collections, movies] = await Promise.all([
    fetchJson(services.radarr, "collection"),
    fetchJson(services.radarr, "movie"),
  ]);
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
    type: "Series",
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
    updatedAt: new Date().toISOString(),
    totalSizeOnDisk: items.reduce((sum, item) => sum + item.sizeOnDisk, 0),
    count: items.length,
    items,
    errors,
  });
}

async function handleApiCollections(req, res) {
  const collections = await getRadarrCollections();

  jsonResponse(res, 200, {
    updatedAt: new Date().toISOString(),
    totalSizeOnDisk: collections.reduce((sum, collection) => sum + collection.sizeOnDisk, 0),
    count: collections.length,
    collections,
    errors: [],
  });
}

async function setCollectionMonitoring(collectionId, monitored) {
  const numericId = Number(collectionId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    const error = new Error("Invalid collection");
    error.status = 400;
    throw error;
  }

  const collection = await fetchJson(services.radarr, `collection/${numericId}`);
  collection.monitored = monitored;
  return sendJson(services.radarr, `collection/${numericId}`, "PUT", collection);
}

async function deleteCollection(collectionId) {
  const numericId = Number(collectionId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    const error = new Error("Invalid collection");
    error.status = 400;
    throw error;
  }

  const [collection, movies] = await Promise.all([
    fetchJson(services.radarr, `collection/${numericId}`),
    fetchJson(services.radarr, "movie"),
  ]);
  const collectionTmdbIds = new Set(collection.movies.map((movie) => movie.tmdbId));
  const moviesToDelete = movies.filter((movie) => collectionTmdbIds.has(movie.tmdbId));

  collection.monitored = false;
  await sendJson(services.radarr, `collection/${numericId}`, "PUT", collection);

  for (const movie of moviesToDelete) {
    await deleteFromService("radarr", movie.id);
  }

  return {
    source: "Radarr",
    id: numericId,
    deletedMovies: moviesToDelete.length,
  };
}

async function unmonitorCollectionAndDeleteMovie(movieId) {
  const numericMovieId = Number(movieId);
  if (!Number.isInteger(numericMovieId) || numericMovieId <= 0) {
    const error = new Error("Invalid movie");
    error.status = 400;
    throw error;
  }

  const [movie, collections] = await Promise.all([
    fetchJson(services.radarr, `movie/${numericMovieId}`),
    fetchJson(services.radarr, "collection"),
  ]);
  const collection = collections.find((item) =>
    (item.movies || []).some((collectionMovie) => collectionMovie.tmdbId === movie.tmdbId),
  );

  if (collection) {
    collection.monitored = false;
    await sendJson(services.radarr, `collection/${collection.id}`, "PUT", collection);
  }

  await deleteFromService("radarr", numericMovieId);

  return {
    source: "Radarr",
    id: numericMovieId,
    collectionId: collection?.id || null,
    collectionTitle: collection?.title || movie.collection?.title || "",
    unmonitoredCollection: Boolean(collection),
  };
}

async function handleCollectionAction(req, res) {
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
    jsonResponse(res, 200, { deleted });
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
}

async function handleLibraryAction(req, res) {
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
  const filePath = join(publicDir, safePath === "/" ? "index.html" : safePath);

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
    jsonResponse(res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Cleanerr running at http://${HOST}:${PORT}`);
});
