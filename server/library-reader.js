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

export function createLibraryReader({ radarrSnapshot, fetchJson, getServices }) {
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
    const series = await fetchJson(getServices().sonarr, "series");

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

  return { getRadarrItems, getRadarrCollections, getSonarrItems };
}
