const refreshButton = document.querySelector("#refreshButton");
const loadingState = document.querySelector("#loadingState");
const emptyState = document.querySelector("#emptyState");
const table = document.querySelector("#libraryTable");
const rows = document.querySelector("#libraryRows");
const collectionList = document.querySelector("#collectionList");
const itemCount = document.querySelector("#itemCount");
const totalSize = document.querySelector("#totalSize");
const updatedAt = document.querySelector("#updatedAt");
const errorPanel = document.querySelector("#errorPanel");
const tabButtons = document.querySelectorAll(".tab-button");
const sortButtons = document.querySelectorAll(".sort-button");

let libraryItems = [];
let collectionItems = [];
let activeView = "all";
let activeSort = "size";

const sizeFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

function formatBytes(bytes) {
  if (!bytes) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${sizeFormatter.format(value)} ${units[exponent]}`;
}

function formatDate(isoDate) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(isoDate));
}

function renderErrors(errors) {
  if (!errors.length) {
    errorPanel.hidden = true;
    errorPanel.textContent = "";
    return;
  }

  errorPanel.hidden = false;
  errorPanel.textContent = errors
    .map((error) => `${error.source}: ${error.message}`)
    .join(" · ");
}

function normalizeTitle(title) {
  return title
    .toLocaleLowerCase("en-US")
    .replace(/^(the|a|an)\s+/, "")
    .trim();
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    if (activeSort === "name") {
      const titleCompare = normalizeTitle(a.title).localeCompare(normalizeTitle(b.title), "en-US");
      if (titleCompare) return titleCompare;
      return (a.year || 0) - (b.year || 0);
    }

    return b.sizeOnDisk - a.sizeOnDisk || normalizeTitle(a.title).localeCompare(normalizeTitle(b.title), "en-US");
  });
}

function sortCollections(collections) {
  return [...collections].sort((a, b) => {
    if (activeSort === "name") {
      return normalizeTitle(a.title).localeCompare(normalizeTitle(b.title), "en-US");
    }

    return b.sizeOnDisk - a.sizeOnDisk || normalizeTitle(a.title).localeCompare(normalizeTitle(b.title), "en-US");
  });
}

function getVisibleItems() {
  let items = libraryItems;
  if (activeView === "movies") items = libraryItems.filter((item) => item.service === "radarr");
  if (activeView === "series") items = libraryItems.filter((item) => item.service === "sonarr");
  return sortItems(items);
}

function getVisibleCollections() {
  return sortCollections(collectionItems);
}

function renderRows() {
  const items = getVisibleItems();

  rows.replaceChildren(
    ...items.flatMap((item) => {
      const row = document.createElement("tr");
      const title = item.year ? `${item.title} (${item.year})` : item.title;
      row.classList.add(`source-${item.service}`);
      row.dataset.service = item.service;
      row.dataset.id = item.id;
      row.dataset.title = title;
      row.dataset.type = item.type;
      row.dataset.monitored = item.monitored;
      row.dataset.collection = item.collection || "";
      row.dataset.collectionMonitored = item.collectionMonitored || false;

      row.innerHTML = `
        <td>
          <div class="media-cell">
            <div class="poster" aria-hidden="true"></div>
            <div>
              <div class="title"></div>
              <div class="collection muted"></div>
            </div>
          </div>
        </td>
        <td><span class="badge"></span></td>
        <td></td>
        <td class="muted"></td>
        <td class="number"></td>
        <td class="actions"><button class="delete-button" type="button"></button></td>
      `;

      row.children[0].querySelector(".title").textContent = title;
      const poster = row.children[0].querySelector(".poster");
      const collection = row.children[0].querySelector(".collection");

      if (item.posterUrl) {
        poster.style.backgroundImage = `url("${item.posterUrl}")`;
      } else {
        poster.textContent = item.type.slice(0, 1);
      }

      if (item.collection) {
        collection.textContent = item.collection;
      } else {
        collection.remove();
      }

      row.children[1].querySelector(".badge").textContent = item.type;
      row.children[2].textContent = item.source;
      row.children[3].textContent = item.path || "-";
      row.children[4].textContent = formatBytes(item.sizeOnDisk);
      const actions = row.children[5];
      const deleteButton = actions.querySelector(".delete-button");
      deleteButton.textContent = "Delete";

      if (item.service === "radarr" && item.collection && item.collectionMonitored) {
        deleteButton.classList.add("collection-safe-delete-button");
        deleteButton.textContent = "Unmonitor collection and delete movie";
      }

      if (activeView === "series" && item.service === "sonarr" && !item.monitored) {
        const monitorButton = document.createElement("button");
        monitorButton.className = "monitor-series-button";
        monitorButton.type = "button";
        monitorButton.textContent = "Monitor";
        actions.prepend(monitorButton);
      }

      if (activeView !== "series") return [row];

      const seasonsRow = document.createElement("tr");
      seasonsRow.className = "season-detail-row source-sonarr";
      seasonsRow.innerHTML = `
        <td colspan="6">
          <div class="season-list"></div>
        </td>
      `;

      const seasonList = seasonsRow.querySelector(".season-list");
      const seasons = [...(item.seasons || [])].sort((a, b) => a.seasonNumber - b.seasonNumber);

      seasonList.replaceChildren(
        ...seasons.map((season) => {
          const seasonItem = document.createElement("div");
          seasonItem.className = "season-item";
          const label = season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`;
          const episodes = `${season.episodeFileCount}/${season.totalEpisodeCount} episodes`;
          seasonItem.dataset.seriesId = item.id;
          seasonItem.dataset.seriesTitle = title;
          seasonItem.dataset.seasonNumber = season.seasonNumber;
          seasonItem.dataset.seasonName = label;
          seasonItem.dataset.seasonSize = season.sizeOnDisk;
          seasonItem.dataset.episodeFileCount = season.episodeFileCount;
          seasonItem.dataset.monitored = season.monitored;
          seasonItem.classList.toggle(
            "is-unmonitored-missing",
            (!season.monitored || !item.monitored) && season.sizeOnDisk === 0,
          );

          seasonItem.innerHTML = `
            <span class="season-name"></span>
            <span class="season-episodes muted"></span>
            <strong class="season-size"></strong>
            <button class="season-action-button" type="button"></button>
          `;
          seasonItem.querySelector(".season-name").textContent = label;
          seasonItem.querySelector(".season-episodes").textContent = episodes;
          seasonItem.querySelector(".season-size").textContent = formatBytes(season.sizeOnDisk);
          const actionButton = seasonItem.querySelector(".season-action-button");

          if (season.sizeOnDisk > 0) {
            actionButton.classList.add("remove-season-button");
            actionButton.textContent = "Remove season";
          } else if (!season.monitored || !item.monitored) {
            actionButton.classList.add("monitor-season-button");
            actionButton.textContent = "Monitor season";
          } else {
            actionButton.disabled = true;
            actionButton.textContent = "No files";
          }

          return seasonItem;
        }),
      );

      return [row, seasonsRow];
    }),
  );
}

function renderPoster(element, item) {
  if (item.posterUrl) {
    element.style.backgroundImage = `url("${item.posterUrl}")`;
    return;
  }

  element.textContent = item.type?.slice(0, 1) || "C";
}

function renderCollections() {
  const collections = getVisibleCollections();

  collectionList.replaceChildren(
    ...collections.map((collection) => {
      const card = document.createElement("article");
      card.className = "collection-card";
      card.dataset.id = collection.id;
      card.dataset.title = collection.title;

      card.innerHTML = `
        <div class="collection-header">
          <div class="poster collection-poster" aria-hidden="true"></div>
          <div class="collection-main">
            <div class="collection-title-row">
              <div>
                <h2 class="collection-title"></h2>
                <div class="collection-meta muted"></div>
              </div>
              <strong class="collection-size"></strong>
            </div>
            <div class="collection-actions">
              <button class="toggle-collection-monitor-button" type="button"></button>
              <button class="delete-collection-button" type="button"></button>
            </div>
          </div>
        </div>
        <div class="collection-movies"></div>
      `;

      renderPoster(card.querySelector(".collection-poster"), collection);
      card.querySelector(".collection-title").textContent = collection.title;
      card.querySelector(".collection-meta").textContent =
        `${collection.existingMovieCount}/${collection.movieCount} movies in library · ${collection.monitored ? "Monitored" : "Not monitored"}`;
      card.querySelector(".collection-size").textContent = formatBytes(collection.sizeOnDisk);
      const monitorButton = card.querySelector(".toggle-collection-monitor-button");
      monitorButton.dataset.monitored = collection.monitored;
      monitorButton.textContent = collection.monitored ? "Unmonitor" : "Monitor";
      card.querySelector(".delete-collection-button").textContent = "Delete collection";

      const movieList = card.querySelector(".collection-movies");
      movieList.replaceChildren(
        ...collection.movies.map((movie) => {
          const item = document.createElement("div");
          item.className = "collection-movie";
          const title = movie.year ? `${movie.title} (${movie.year})` : movie.title;

          item.innerHTML = `
            <div class="poster movie-poster" aria-hidden="true"></div>
            <div class="collection-movie-title"></div>
            <div class="collection-movie-state muted"></div>
            <div class="collection-movie-size"></div>
          `;

          renderPoster(item.querySelector(".movie-poster"), { ...movie, type: "Movie" });
          item.querySelector(".collection-movie-title").textContent = title;
          item.querySelector(".collection-movie-state").textContent = movie.isExisting
            ? "In library"
            : "Not in library";
          item.querySelector(".collection-movie-size").textContent = movie.isExisting
            ? formatBytes(movie.sizeOnDisk)
            : "-";

          return item;
        }),
      );

      return card;
    }),
  );
}

function renderView() {
  const isCollectionsView = activeView === "collections";
  table.hidden = true;
  collectionList.hidden = true;

  if (isCollectionsView) {
    const visibleCollections = getVisibleCollections();
    renderCollections();
    itemCount.textContent = visibleCollections.length;
    totalSize.textContent = formatBytes(
      visibleCollections.reduce((sum, collection) => sum + collection.sizeOnDisk, 0),
    );

    const hasCollections = visibleCollections.length > 0;
    collectionList.hidden = !hasCollections;
    emptyState.hidden = hasCollections;
    return;
  }

  const visibleItems = getVisibleItems();
  renderRows();
  itemCount.textContent = visibleItems.length;
  totalSize.textContent = formatBytes(
    visibleItems.reduce((sum, item) => sum + item.sizeOnDisk, 0),
  );

  const hasItems = visibleItems.length > 0;
  table.hidden = !hasItems;
  emptyState.hidden = hasItems;
}

async function deleteItem(row) {
  const title = row.dataset.title;
  const type = row.dataset.type.toLowerCase();
  const isCollectionMovie =
    row.dataset.service === "radarr" &&
    Boolean(row.dataset.collection) &&
    row.dataset.collectionMonitored === "true";
  const message = isCollectionMovie
    ? `This movie belongs to "${row.dataset.collection}".\n\nCleanerr will stop monitoring that collection in Radarr and then delete "${title}" from Radarr and disk.\n\nThis action cannot be undone from Cleanerr.`
    : `You are about to delete this ${type}: "${title}" from ${row.dataset.service} and disk.\n\nThis action cannot be undone from Cleanerr.`;
  const confirmed = window.confirm(message);

  if (!confirmed) return;

  const button = row.querySelector(".delete-button");
  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Deleting...";

  try {
    const endpoint = isCollectionMovie
      ? `/api/library/radarr/${row.dataset.id}/collection-safe`
      : `/api/library/${row.dataset.service}/${row.dataset.id}`;
    const response = await fetch(endpoint, { method: "DELETE" });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not delete the library item");
    }

    await loadLibrary();
  } catch (error) {
    renderErrors([{ source: "Cleanerr", message: error.message }]);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Delete";
  }
}

async function monitorSeries(row) {
  const title = row.dataset.title;
  const confirmed = window.confirm(`Monitor "${title}" in Sonarr?`);
  if (!confirmed) return;

  const button = row.querySelector(".monitor-series-button");
  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Updating...";

  try {
    const response = await fetch(`/api/library/sonarr/${row.dataset.id}/monitor`, {
      method: "PATCH",
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not monitor the series");
    }

    await loadLibrary();
  } catch (error) {
    renderErrors([{ source: "Cleanerr", message: error.message }]);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Monitor";
  }
}

async function removeSeason(seasonItem) {
  const seriesTitle = seasonItem.dataset.seriesTitle;
  const seasonName = seasonItem.dataset.seasonName;
  const seasonSize = Number(seasonItem.dataset.seasonSize || 0);
  const episodeFileCount = Number(seasonItem.dataset.episodeFileCount || 0);
  const confirmation = window.prompt(
    `This will unmonitor ${seasonName} of "${seriesTitle}" in Sonarr and delete ${episodeFileCount} episode file(s) from disk, freeing about ${formatBytes(seasonSize)}.\n\nThe series and other seasons will stay in Sonarr.\n\nType DELETE to continue.`,
  );

  if (confirmation !== "DELETE") return;

  const button = seasonItem.querySelector(".remove-season-button");
  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Removing...";

  try {
    const response = await fetch(
      `/api/library/sonarr/${seasonItem.dataset.seriesId}/seasons/${seasonItem.dataset.seasonNumber}`,
      { method: "DELETE" },
    );
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not remove the season");
    }

    await loadLibrary();
  } catch (error) {
    renderErrors([{ source: "Cleanerr", message: error.message }]);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Remove season";
  }
}

async function monitorSeason(seasonItem) {
  const seriesTitle = seasonItem.dataset.seriesTitle;
  const seasonName = seasonItem.dataset.seasonName;
  const confirmed = window.confirm(
    `Monitor "${seriesTitle}" in Sonarr and monitor ${seasonName}?`,
  );
  if (!confirmed) return;

  const button = seasonItem.querySelector(".monitor-season-button");
  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Updating...";

  try {
    const response = await fetch(
      `/api/library/sonarr/${seasonItem.dataset.seriesId}/seasons/${seasonItem.dataset.seasonNumber}/monitor`,
      { method: "PATCH" },
    );
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not monitor the season");
    }

    await loadLibrary();
  } catch (error) {
    renderErrors([{ source: "Cleanerr", message: error.message }]);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Monitor season";
  }
}

async function setCollectionMonitoring(card) {
  const title = card.dataset.title;
  const button = card.querySelector(".toggle-collection-monitor-button");
  const shouldMonitor = button.dataset.monitored !== "true";
  const confirmed = window.confirm(
    `${shouldMonitor ? "Monitor" : "Stop monitoring"} "${title}" in Radarr?`,
  );
  if (!confirmed) return;

  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Updating...";

  try {
    const action = shouldMonitor ? "monitor" : "unmonitor";
    const response = await fetch(`/api/collections/${card.dataset.id}/${action}`, {
      method: "PATCH",
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not unmonitor the collection");
    }

    await loadLibrary();
  } catch (error) {
    renderErrors([{ source: "Cleanerr", message: error.message }]);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = shouldMonitor ? "Monitor" : "Unmonitor";
  }
}

async function deleteCollection(card) {
  const title = card.dataset.title;
  const confirmation = window.prompt(
    `This will delete "${title}" from Radarr and delete every existing movie in this collection from disk.\n\nType DELETE to continue.`,
  );

  if (confirmation !== "DELETE") return;

  const button = card.querySelector(".delete-collection-button");
  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Deleting...";

  try {
    const response = await fetch(`/api/collections/${card.dataset.id}`, {
      method: "DELETE",
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not delete the collection");
    }

    await loadLibrary();
  } catch (error) {
    renderErrors([{ source: "Cleanerr", message: error.message }]);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Delete collection";
  }
}

async function loadLibrary() {
  refreshButton.disabled = true;
  refreshButton.classList.add("is-busy");
  loadingState.hidden = false;
  emptyState.hidden = true;
  table.hidden = true;
  collectionList.hidden = true;

  try {
    const refresh = Date.now();
    const [libraryResponse, collectionsResponse] = await Promise.all([
      fetch(`/api/library?refresh=${refresh}`, { cache: "no-store" }),
      fetch(`/api/collections?refresh=${refresh}`, { cache: "no-store" }),
    ]);
    const data = await libraryResponse.json();
    const collectionsData = await collectionsResponse.json();

    if (!libraryResponse.ok && libraryResponse.status !== 207) {
      throw new Error(data.error || "Could not load the library");
    }
    if (!collectionsResponse.ok) {
      throw new Error(collectionsData.error || "Could not load collections");
    }

    libraryItems = data.items || [];
    collectionItems = collectionsData.collections || [];
    updatedAt.textContent = formatDate(data.updatedAt || collectionsData.updatedAt);
    renderErrors([...(data.errors || []), ...(collectionsData.errors || [])]);
    renderView();
  } catch (error) {
    libraryItems = [];
    collectionItems = [];
    renderErrors([{ source: "Cleanerr", message: error.message }]);
    itemCount.textContent = "-";
    totalSize.textContent = "-";
    updatedAt.textContent = "-";
    emptyState.hidden = false;
  } finally {
    loadingState.hidden = true;
    refreshButton.disabled = false;
    refreshButton.classList.remove("is-busy");
  }
}

refreshButton.addEventListener("click", loadLibrary);
tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeView = button.dataset.view;
    tabButtons.forEach((tabButton) => {
      tabButton.classList.toggle("is-active", tabButton === button);
    });
    renderView();
  });
});
sortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeSort = button.dataset.sort;
    sortButtons.forEach((sortButton) => {
      sortButton.classList.toggle("is-active", sortButton === button);
    });
    renderView();
  });
});
rows.addEventListener("click", (event) => {
  const monitorSeriesButton = event.target.closest(".monitor-series-button");
  if (monitorSeriesButton) {
    monitorSeries(monitorSeriesButton.closest("tr"));
    return;
  }

  const monitorSeasonButton = event.target.closest(".monitor-season-button");
  if (monitorSeasonButton) {
    monitorSeason(monitorSeasonButton.closest(".season-item"));
    return;
  }

  const removeSeasonButton = event.target.closest(".remove-season-button");
  if (removeSeasonButton) {
    removeSeason(removeSeasonButton.closest(".season-item"));
    return;
  }

  const button = event.target.closest(".delete-button");
  if (!button) return;
  deleteItem(button.closest("tr"));
});
collectionList.addEventListener("click", (event) => {
  const monitorButton = event.target.closest(".toggle-collection-monitor-button");
  if (monitorButton) {
    setCollectionMonitoring(monitorButton.closest(".collection-card"));
    return;
  }

  const deleteButton = event.target.closest(".delete-collection-button");
  if (deleteButton) {
    deleteCollection(deleteButton.closest(".collection-card"));
  }
});
loadLibrary();
