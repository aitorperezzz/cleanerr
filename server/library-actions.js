import { createOperationQueue } from "./operation-queue.js";

const runOperation = createOperationQueue();

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function partialActionError(message, partialResult, cause) {
  const error = new Error(`${message} ${cause.message}`, { cause });
  error.status = cause.status || 502;
  error.partialResult = partialResult;
  error.uncertain = Boolean(cause.uncertain);
  return error;
}

function positiveInteger(value, message) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw httpError(message, 400);
  return number;
}

function nonNegativeInteger(value, message) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw httpError(message, 400);
  return number;
}

function bytesToNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function createLibraryActions({
  getService,
  fetchJson,
  sendJson,
  deleteEndpoint,
  refreshJellyfinLibrary = async () => {},
}) {
  function service(name) {
    return getService(name);
  }

  async function deleteFromServiceWithoutRefresh(serviceName, itemId) {
    const targetService = service(serviceName);
    const numericId = positiveInteger(itemId, "Invalid library item");
    if (!targetService || !["radarr", "sonarr"].includes(serviceName)) {
      throw httpError("Invalid library item", 400);
    }

    const endpoint = serviceName === "radarr" ? "movie" : "series";
    const exclusionParam = serviceName === "radarr"
      ? "addImportExclusion"
      : "addImportListExclusion";
    const url = new URL(`${targetService.url}/api/v3/${endpoint}/${numericId}`);
    url.searchParams.set("deleteFiles", "true");
    url.searchParams.set(exclusionParam, serviceName === "radarr" ? "false" : "true");
    await deleteEndpoint(targetService, url);
    return { source: targetService.label, id: numericId };
  }

  async function deleteFromService(serviceName, itemId) {
    const deleted = await deleteFromServiceWithoutRefresh(serviceName, itemId);
    await refreshJellyfinLibrary();
    return deleted;
  }

  async function deleteEpisodeFile(episodeFileId) {
    const numericId = positiveInteger(episodeFileId, "Invalid episode file");
    const sonarr = service("sonarr");
    await deleteEndpoint(sonarr, `${sonarr.url}/api/v3/episodefile/${numericId}`);
  }

  async function removeSeason(seriesId, seasonNumber) {
    const numericSeriesId = positiveInteger(seriesId, "Invalid season");
    const numericSeasonNumber = nonNegativeInteger(seasonNumber, "Invalid season");
    const sonarr = service("sonarr");
    const [series, episodes] = await Promise.all([
      fetchJson(sonarr, `series/${numericSeriesId}`),
      fetchJson(sonarr, `episode?seriesId=${numericSeriesId}&includeEpisodeFile=true`),
    ]);
    const season = series.seasons?.find((item) => item.seasonNumber === numericSeasonNumber);
    if (!season) throw httpError("Season not found", 404);

    season.monitored = false;
    await sendJson(sonarr, `series/${numericSeriesId}`, "PUT", series);
    const episodeFiles = episodes
      .filter((episode) => episode.seasonNumber === numericSeasonNumber && episode.episodeFileId > 0)
      .map((episode) => ({
        id: episode.episodeFileId,
        size: bytesToNumber(episode.episodeFile?.size),
      }));
    const uniqueEpisodeFiles = [...new Map(episodeFiles.map((file) => [file.id, file])).values()];
    let deletedFiles = 0;
    let deletedSize = 0;
    if (uniqueEpisodeFiles.length > 0) {
      try {
        for (const episodeFile of uniqueEpisodeFiles) {
          await deleteEpisodeFile(episodeFile.id);
          deletedFiles += 1;
          deletedSize += episodeFile.size;
        }
      } catch (cause) {
        throw partialActionError(
          `The season was unmonitored. ${deletedFiles} of ${uniqueEpisodeFiles.length} episode files confirmed deleted. Check Sonarr before retrying.`,
          { source: "Sonarr", seriesId: numericSeriesId, seasonNumber: numericSeasonNumber, monitored: false,
            deletedFiles, totalFiles: uniqueEpisodeFiles.length, deletedSize,
            failedFileId: uniqueEpisodeFiles[deletedFiles].id,
            notAttemptedFiles: uniqueEpisodeFiles.length - deletedFiles - 1 },
          cause,
        );
      } finally {
        await refreshJellyfinLibrary();
      }
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
    const numericSeriesId = positiveInteger(seriesId, "Invalid series");
    const sonarr = service("sonarr");
    const series = await fetchJson(sonarr, `series/${numericSeriesId}`);
    series.monitored = monitored;
    return sendJson(sonarr, `series/${numericSeriesId}`, "PUT", series);
  }

  async function setSeasonMonitoring(seriesId, seasonNumber, monitored) {
    const numericSeriesId = positiveInteger(seriesId, "Invalid season");
    const numericSeasonNumber = nonNegativeInteger(seasonNumber, "Invalid season");
    const sonarr = service("sonarr");
    const series = await fetchJson(sonarr, `series/${numericSeriesId}`);
    const season = series.seasons?.find((item) => item.seasonNumber === numericSeasonNumber);
    if (!season) throw httpError("Season not found", 404);

    series.monitored = true;
    season.monitored = monitored;
    const updatedSeries = await sendJson(sonarr, `series/${numericSeriesId}`, "PUT", series);
    if (monitored) {
      try {
        await sendJson(sonarr, "command", "POST", {
          name: "SeasonSearch",
          seriesId: numericSeriesId,
          seasonNumber: numericSeasonNumber,
        });
      } catch (cause) {
        throw partialActionError("Season monitoring was enabled, but the search request could not be confirmed. Check Sonarr before starting another search.",
          { source: "Sonarr", seriesId: numericSeriesId, seasonNumber: numericSeasonNumber, monitored: true, commandConfirmed: false }, cause);
      }
    }
    return updatedSeries;
  }

  async function setCollectionMonitoring(collectionId, monitored) {
    const numericId = positiveInteger(collectionId, "Invalid collection");
    const radarr = service("radarr");
    const collection = await fetchJson(radarr, `collection/${numericId}`);
    collection.monitored = monitored;
    if (monitored) collection.searchOnAdd = true;
    const updatedCollection = await sendJson(radarr, `collection/${numericId}`, "PUT", collection);
    if (monitored) {
      try {
        await sendJson(radarr, "command", "POST", {
          name: "RefreshCollections",
          collectionIds: [numericId],
        });
      } catch (cause) {
        throw partialActionError("Collection monitoring was enabled, but the sync request could not be confirmed. Check Radarr before starting another sync.",
          { source: "Radarr", collectionId: numericId, monitored: true, searchOnAdd: true, commandConfirmed: false }, cause);
      }
    }
    return updatedCollection;
  }

  async function deleteCollection(collectionId) {
    const numericId = positiveInteger(collectionId, "Invalid collection");
    const radarr = service("radarr");
    const [collection, movies] = await Promise.all([
      fetchJson(radarr, `collection/${numericId}`),
      fetchJson(radarr, "movie"),
    ]);
    const collectionTmdbIds = new Set(
      (collection.movies || [])
        .map((movie) => movie.tmdbId)
        .filter((id) => Number.isInteger(id) && id > 0),
    );
    const moviesToDelete = movies.filter((movie) => collectionTmdbIds.has(movie.tmdbId));

    collection.monitored = false;
    await sendJson(radarr, `collection/${numericId}`, "PUT", collection);
    let deletedMovies = 0;
    let failure = null;
    if (moviesToDelete.length > 0) {
      try {
        for (const movie of moviesToDelete) {
          try {
            await deleteFromServiceWithoutRefresh("radarr", movie.id);
            deletedMovies += 1;
          } catch (error) {
            failure = {
              id: movie.id,
              title: movie.title || `Movie ${movie.id}`,
              message: error.message,
            };
            break;
          }
        }
      } finally {
        await refreshJellyfinLibrary();
      }
    }

    return {
      source: "Radarr",
      id: numericId,
      unmonitoredCollection: true,
      totalMovies: moviesToDelete.length,
      deletedMovies,
      failure,
    };
  }

  async function unmonitorCollectionAndDeleteMovie(movieId) {
    const numericMovieId = positiveInteger(movieId, "Invalid movie");
    const radarr = service("radarr");
    const [movie, collections] = await Promise.all([
      fetchJson(radarr, `movie/${numericMovieId}`),
      fetchJson(radarr, "collection"),
    ]);
    const collection = collections.find((item) =>
      (item.movies || []).some((collectionMovie) => collectionMovie.tmdbId === movie.tmdbId),
    );

    if (collection) {
      collection.monitored = false;
      await sendJson(radarr, `collection/${collection.id}`, "PUT", collection);
    }
    try {
      await deleteFromServiceWithoutRefresh("radarr", numericMovieId);
    } catch (cause) {
      if (!collection) throw cause;
      throw partialActionError("The collection was unmonitored, but movie deletion could not be confirmed. Check Radarr before retrying.",
        { source: "Radarr", id: numericMovieId, collectionId: collection.id, unmonitoredCollection: true, deletionConfirmed: false }, cause);
    } finally {
      await refreshJellyfinLibrary();
    }

    return {
      source: "Radarr",
      id: numericMovieId,
      collectionId: collection?.id || null,
      collectionTitle: collection?.title || movie.collection?.title || "",
      unmonitoredCollection: Boolean(collection),
    };
  }

  function serialized(serviceName, seriesId, operation) {
    const target = service(serviceName);
    // Radarr operations can affect both a movie and its collection.
    const resource = serviceName === "sonarr" ? `series:${Number(seriesId)}` : "collections-and-movies";
    return runOperation(`${serviceName}:${target?.url}:${resource}`, operation);
  }

  return {
    deleteCollection: (id) => serialized("radarr", null, () => deleteCollection(id)),
    deleteFromService: (name, id) => serialized(name, id, () => deleteFromService(name, id)),
    removeSeason: (id, season) => serialized("sonarr", id, () => removeSeason(id, season)),
    setCollectionMonitoring: (id, monitored) => serialized("radarr", null, () => setCollectionMonitoring(id, monitored)),
    setSeasonMonitoring: (id, season, monitored) => serialized("sonarr", id, () => setSeasonMonitoring(id, season, monitored)),
    setSeriesMonitoring: (id, monitored) => serialized("sonarr", id, () => setSeriesMonitoring(id, monitored)),
    unmonitorCollectionAndDeleteMovie: (id) => serialized("radarr", null, () => unmonitorCollectionAndDeleteMovie(id)),
  };
}
