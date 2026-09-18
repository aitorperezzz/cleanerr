const refreshButton = document.querySelector("#refreshButton");
const loadingState = document.querySelector("#loadingState");
const emptyState = document.querySelector("#emptyState");
const table = document.querySelector("#libraryTable");
const rows = document.querySelector("#libraryRows");
const collectionList = document.querySelector("#collectionList");
const updatedAt = document.querySelector("#updatedAt");
const errorPanel = document.querySelector("#errorPanel");
const tabButtons = document.querySelectorAll(".tab-button");
const sortButtons = document.querySelectorAll(".sort-button");
const statusBar = document.querySelector("#statusBar");
const controls = document.querySelector("#controls");
const libraryPanel = document.querySelector("#libraryPanel");
const settingsPanel = document.querySelector("#settingsPanel");
const viewTitle = document.querySelector("#viewTitle");
const viewDescription = document.querySelector("#viewDescription");
const serviceForms = document.querySelectorAll(".service-settings");
const brand = document.querySelector(".brand");
const searchInput = document.querySelector("#searchInput");
const confirmationNotice = document.querySelector("#confirmationNotice");
const confirmationMessage = document.querySelector("#confirmationMessage");
const storageStateElement = document.querySelector("#storageState");
const storageList = document.querySelector("#storageList");
const storageUpdatedAt = document.querySelector("#storageUpdatedAt");

let libraryItems = [];
let collectionItems = [];
let settingsState = null;
let storageState = null;
let activeView = "all";
let activeSort = "size";
let activeQuery = "";
let lastUpdatedAt = "";
let searchRenderTimer = null;

const searchTextCache = new WeakMap();

const viewCopy = {
  all: ["Overview", "Your library sorted by disk usage."],
  movies: ["Movies", "Movies managed by Radarr."],
  series: ["Shows", "Shows and seasons managed by Sonarr."],
  collections: ["Collections", "Movie collections managed by Radarr."],
  settings: ["Settings", "Connect Cleanerr to your media services."],
};

const viewPaths = {
  all: "/overview",
  movies: "/movies",
  series: "/shows",
  collections: "/collections",
  settings: "/settings",
};

const pathViews = Object.fromEntries(
  Object.entries(viewPaths).map(([view, path]) => [path, view]),
);

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
  const date = new Date(isoDate);
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  const relativeFormatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

  if (elapsedSeconds < 45) return "Just now";
  if (elapsedSeconds < 3600) return relativeFormatter.format(-Math.round(elapsedSeconds / 60), "minute");
  if (elapsedSeconds < 86400) return relativeFormatter.format(-Math.round(elapsedSeconds / 3600), "hour");
  if (elapsedSeconds < 604800) return relativeFormatter.format(-Math.round(elapsedSeconds / 86400), "day");

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "short",
  }).format(date);
}

function renderUpdatedAt() {
  if (!lastUpdatedAt) return;
  updatedAt.textContent = formatDate(lastUpdatedAt);
  updatedAt.title = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(lastUpdatedAt));
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

async function readJsonResponse(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    if (response.status === 404) {
      throw new Error(
        "The server is running an older version. Restart Cleanerr and open it on port 3050.",
      );
    }
    throw new Error(`Cleanerr returned an invalid response (${response.status})`);
  }
}

function normalizeTitle(title) {
  return title
    .toLocaleLowerCase("en-US")
    .replace(/^(the|a|an)\s+/, "")
    .trim();
}

function normalizeSearchValue(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US");
}

function matchesSearch(record, values) {
  if (!activeQuery) return true;
  let searchText = searchTextCache.get(record);
  if (!searchText) {
    searchText = normalizeSearchValue(values.join("\n"));
    searchTextCache.set(record, searchText);
  }
  return searchText.includes(activeQuery);
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
  items = items.filter((item) =>
    matchesSearch(item, [
      item.title,
      item.year,
      item.type,
      item.source,
      item.path,
      item.collection,
    ]),
  );
  return sortItems(items);
}

function getVisibleCollections() {
  return sortCollections(
    collectionItems.filter((collection) =>
      matchesSearch(collection, [
        collection.title,
        ...(collection.movies || []).flatMap((movie) => [movie.title, movie.year, movie.path]),
      ]),
    ),
  );
}

function renderRows(items) {
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
              <div class="collection">
                <span class="collection-name muted"></span>
                <span class="collection-monitor-badge">Monitored collection</span>
              </div>
            </div>
          </div>
        </td>
        <td><span class="badge"></span></td>
        <td><span class="source-badge"></span></td>
        <td class="muted path-cell"></td>
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
        collection.querySelector(".collection-name").textContent = item.collection;
        collection
          .querySelector(".collection-monitor-badge")
          .toggleAttribute("hidden", !item.collectionMonitored);
      } else {
        collection.remove();
      }

      row.children[1].querySelector(".badge").textContent = item.type;
      const sourceBadge = row.children[2].querySelector(".source-badge");
      sourceBadge.textContent = item.source;
      sourceBadge.classList.add(`source-badge-${item.service}`);
      row.children[3].textContent = item.path || "-";
      row.children[3].title = item.path || "";
      row.children[4].textContent = formatBytes(item.sizeOnDisk);
      const actions = row.children[5];
      const deleteButton = actions.querySelector(".delete-button");
      deleteButton.textContent = "Delete";

      if (activeView === "series" && item.service === "sonarr" && !item.monitored) {
        const monitorButton = document.createElement("button");
        monitorButton.className = "monitor-series-button";
        monitorButton.type = "button";
        monitorButton.textContent = "Monitor";
        actions.prepend(monitorButton);
      }

      if (activeView !== "series") return [row];

      row.classList.add("has-season-details");
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

function renderCollections(collections) {
  collectionList.replaceChildren(
    ...collections.map((collection) => {
      const card = document.createElement("article");
      card.className = "collection-card";
      card.dataset.id = collection.id;
      card.dataset.title = collection.title;
      card.dataset.existingMovieCount = collection.existingMovieCount;
      card.dataset.sizeOnDisk = collection.sizeOnDisk;

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

function renderServiceSettings(form, service) {
  const status = form.querySelector(".service-status");
  const apiKey = form.elements.apiKey;
  form.elements.url.value = service.url || "";
  apiKey.value = "";
  apiKey.placeholder = service.apiKeyConfigured ? "Saved — leave empty to keep" : "Enter API key";
  status.textContent = service.configured ? "Configured" : "Not configured";
  status.classList.toggle("is-configured", service.configured);
}

function renderSettings() {
  if (!settingsState) return;
  serviceForms.forEach((form) => {
    renderServiceSettings(form, settingsState.services[form.dataset.service]);
  });
}

function renderStorage() {
  if (!storageState) return;

  const disks = storageState.disks || [];
  storageUpdatedAt.textContent = storageState.updatedAt
    ? `Updated ${formatDate(storageState.updatedAt).toLowerCase()}`
    : "";

  storageList.replaceChildren(
    ...disks.map((disk) => {
      const totalSpace = Number(disk.totalSpace || 0);
      const freeSpace = Math.max(0, Number(disk.freeSpace || 0));
      const usedSpace = Math.max(0, totalSpace - freeSpace);
      const usedPercent = totalSpace > 0 ? Math.min(100, (usedSpace / totalSpace) * 100) : 0;
      const card = document.createElement("article");
      card.className = `storage-card storage-${disk.service}`;
      card.innerHTML = `
        <div class="storage-card-heading">
          <span class="storage-service"></span>
          <strong class="storage-percent"></strong>
        </div>
        <div class="storage-name"></div>
        <div class="storage-path"></div>
        <div class="storage-meter" role="meter" aria-label="Disk usage" aria-valuemin="0" aria-valuemax="100">
          <div class="storage-meter-fill"></div>
        </div>
        <div class="storage-usage">
          <span><strong class="storage-used"></strong> used</span>
          <span><strong class="storage-total"></strong> total</span>
        </div>
      `;

      card.querySelector(".storage-service").textContent = disk.source;
      card.querySelector(".storage-percent").textContent = `${Math.round(usedPercent)}% used`;
      const paths = disk.paths || [];
      card.querySelector(".storage-name").textContent =
        paths.length > 1 ? `${paths.length} mapped paths` : paths[0] || "Disk";
      const path = card.querySelector(".storage-path");
      path.textContent = paths.join(" · ");
      path.title = paths.join("\n");
      card.querySelector(".storage-used").textContent = formatBytes(usedSpace);
      card.querySelector(".storage-total").textContent = formatBytes(totalSpace);
      const meter = card.querySelector(".storage-meter");
      meter.setAttribute("aria-valuenow", String(Math.round(usedPercent)));
      const fill = card.querySelector(".storage-meter-fill");
      fill.style.width = `${usedPercent}%`;
      fill.classList.toggle("is-high", usedPercent >= 80 && usedPercent < 90);
      fill.classList.toggle("is-critical", usedPercent >= 90);
      return card;
    }),
  );

  const errors = storageState.errors || [];
  storageStateElement.classList.toggle("is-error", errors.length > 0);
  storageStateElement.textContent = errors.length
    ? errors.map((error) => `${error.source}: ${error.message}`).join(" · ")
    : "No disks available.";
  storageStateElement.hidden = disks.length > 0 && errors.length === 0;
  storageList.hidden = disks.length === 0;
}

async function loadStorage() {
  storageStateElement.hidden = false;
  storageStateElement.classList.remove("is-error");
  storageStateElement.textContent = "Loading storage...";
  storageList.hidden = true;
  storageUpdatedAt.textContent = "";

  try {
    const response = await fetch("/api/storage", { cache: "no-store" });
    const data = await readJsonResponse(response);
    if (!response.ok && response.status !== 207) {
      throw new Error(data.error || "Could not load storage");
    }
    storageState = data;
  } catch (error) {
    storageState = { disks: [], errors: [{ source: "Cleanerr", message: error.message }] };
  }

  renderStorage();
}

function selectView(view) {
  activeView = view;
  tabButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
    if (button.dataset.view === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function viewFromLocation() {
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  return pathViews[path] || "all";
}

function updateRoute(view, mode = "push") {
  const method = mode === "replace" ? "replaceState" : "pushState";
  window.history[method]({}, "", viewPaths[view]);
}

function clearSearch() {
  if (searchRenderTimer) clearTimeout(searchRenderTimer);
  searchRenderTimer = null;
  searchInput.value = "";
  activeQuery = "";
}

async function navigateToView(view, { historyMode = "push", resetSearch = true } = {}) {
  if (resetSearch) clearSearch();
  selectView(view);
  if (historyMode) updateRoute(view, historyMode);
  renderView();

  if (activeView === "settings") {
    await loadStorage();
  } else if (libraryItems.length === 0) {
    await loadLibrary();
  }
}

const confirmationTimers = new WeakMap();
let activeConfirmationButton = null;

function resetDestructiveConfirmation(button) {
  const timer = confirmationTimers.get(button);
  if (timer) clearTimeout(timer);
  confirmationTimers.delete(button);

  if (button.dataset.defaultLabel) button.textContent = button.dataset.defaultLabel;
  delete button.dataset.defaultLabel;
  delete button.dataset.confirming;
  button.classList.remove("is-confirming");
  button.removeAttribute("aria-pressed");

  if (activeConfirmationButton === button) {
    activeConfirmationButton = null;
    confirmationNotice.hidden = true;
    confirmationMessage.textContent = "";
  }
}

function confirmDestructiveAction(button, message) {
  if (button.dataset.confirming === "true") {
    resetDestructiveConfirmation(button);
    return true;
  }

  if (activeConfirmationButton) resetDestructiveConfirmation(activeConfirmationButton);
  button.dataset.defaultLabel = button.textContent;
  button.dataset.confirming = "true";
  button.classList.add("is-confirming");
  button.setAttribute("aria-pressed", "true");
  button.textContent = "Are you sure?";
  activeConfirmationButton = button;
  confirmationMessage.textContent = message;
  confirmationNotice.hidden = false;
  confirmationTimers.set(button, setTimeout(() => resetDestructiveConfirmation(button), 5000));
  return false;
}

function renderView() {
  const [title, description] = viewCopy[activeView];
  const isSettingsView = activeView === "settings";
  const isCollectionsView = activeView === "collections";
  viewTitle.textContent = title;
  viewDescription.textContent = description;
  statusBar.hidden = isSettingsView;
  controls.hidden = isSettingsView;
  libraryPanel.hidden = isSettingsView;
  settingsPanel.hidden = !isSettingsView;
  table.hidden = true;
  collectionList.hidden = true;

  if (isSettingsView) {
    renderSettings();
    renderStorage();
    return;
  }

  if (isCollectionsView) {
    const visibleCollections = getVisibleCollections();
    renderCollections(visibleCollections);

    const hasCollections = visibleCollections.length > 0;
    emptyState.textContent = activeQuery ? "No matching results." : "No content to show.";
    collectionList.hidden = !hasCollections;
    emptyState.hidden = hasCollections;
    return;
  }

  const visibleItems = getVisibleItems();
  renderRows(visibleItems);

  const hasItems = visibleItems.length > 0;
  emptyState.textContent = activeQuery ? "No matching results." : "No content to show.";
  table.hidden = !hasItems;
  emptyState.hidden = hasItems;
}

async function deleteItem(row) {
  const isCollectionMovie =
    row.dataset.service === "radarr" &&
    Boolean(row.dataset.collection) &&
    row.dataset.collectionMonitored === "true";
  const button = row.querySelector(".delete-button");
  const source = row.dataset.service === "radarr" ? "Radarr" : "Sonarr";
  const message = isCollectionMovie
    ? `“${row.dataset.title}” will be deleted from Radarr and disk. The collection “${row.dataset.collection}” will also be unmonitored.`
    : `“${row.dataset.title}” and its media files will be deleted from ${source} and disk.`;
  if (!confirmDestructiveAction(button, message)) return;

  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Deleting...";

  try {
    const endpoint = isCollectionMovie
      ? `/api/library/radarr/${row.dataset.id}/collection-safe`
      : `/api/library/${row.dataset.service}/${row.dataset.id}`;
    const response = await fetch(endpoint, { method: "DELETE" });
    const data = await readJsonResponse(response);

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
    const data = await readJsonResponse(response);

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
  const button = seasonItem.querySelector(".remove-season-button");
  const message = `${seasonItem.dataset.seasonName} of “${seasonItem.dataset.seriesTitle}” will be unmonitored and ${seasonItem.dataset.episodeFileCount} episode file(s) (${formatBytes(Number(seasonItem.dataset.seasonSize || 0))}) will be deleted from disk.`;
  if (!confirmDestructiveAction(button, message)) return;

  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Removing...";

  try {
    const response = await fetch(
      `/api/library/sonarr/${seasonItem.dataset.seriesId}/seasons/${seasonItem.dataset.seasonNumber}`,
      { method: "DELETE" },
    );
    const data = await readJsonResponse(response);

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
    const data = await readJsonResponse(response);

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
    const data = await readJsonResponse(response);

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
  const button = card.querySelector(".delete-collection-button");
  const message = `“${card.dataset.title}” and ${card.dataset.existingMovieCount} existing movie(s) (${formatBytes(Number(card.dataset.sizeOnDisk || 0))}) will be deleted from Radarr and disk.`;
  if (!confirmDestructiveAction(button, message)) return;

  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Deleting...";

  try {
    const response = await fetch(`/api/collections/${card.dataset.id}`, {
      method: "DELETE",
    });
    const data = await readJsonResponse(response);

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

function formPayload(form) {
  return {
    url: form.elements.url.value.trim(),
    apiKey: form.elements.apiKey.value.trim(),
  };
}

function showConnectionResult(form, message, type = "") {
  const result = form.querySelector(".connection-result");
  result.textContent = message;
  result.classList.toggle("is-success", type === "success");
  result.classList.toggle("is-error", type === "error");
}

async function loadSettings() {
  const response = await fetch("/api/settings", { cache: "no-store" });
  const data = await readJsonResponse(response);
  if (!response.ok) throw new Error(data.error || "Could not load settings");
  settingsState = data;
  renderSettings();
  return data;
}

async function testConnection(form) {
  const button = form.querySelector(".test-connection-button");
  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Testing...";
  showConnectionResult(form, "");

  try {
    const response = await fetch(`/api/settings/${form.dataset.service}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formPayload(form)),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Connection failed");
    const detail = data.connection.version ? ` · version ${data.connection.version}` : "";
    showConnectionResult(form, `Connected to ${data.connection.name}${detail}`, "success");
  } catch (error) {
    showConnectionResult(form, error.message, "error");
  } finally {
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Test connection";
  }
}

async function saveServiceSettings(form) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Saving...";
  showConnectionResult(form, "");

  try {
    const response = await fetch(`/api/settings/${form.dataset.service}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formPayload(form)),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Could not save settings");
    settingsState.services[form.dataset.service] = data.service;
    settingsState.complete = data.complete;
    renderServiceSettings(form, data.service);
    showConnectionResult(form, "Settings saved", "success");
    if (form.dataset.service === "radarr" || form.dataset.service === "sonarr") {
      storageState = null;
      loadStorage();
    }
  } catch (error) {
    showConnectionResult(form, error.message, "error");
  } finally {
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Save";
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
    const data = await readJsonResponse(libraryResponse);
    const collectionsData = await readJsonResponse(collectionsResponse);

    if (!libraryResponse.ok && libraryResponse.status !== 207) {
      throw new Error(data.error || "Could not load the library");
    }
    if (!collectionsResponse.ok) {
      throw new Error(collectionsData.error || "Could not load collections");
    }

    libraryItems = data.items || [];
    collectionItems = collectionsData.collections || [];
    lastUpdatedAt = data.updatedAt || collectionsData.updatedAt;
    renderUpdatedAt();
    renderErrors([...(data.errors || []), ...(collectionsData.errors || [])]);
    renderView();
  } catch (error) {
    libraryItems = [];
    collectionItems = [];
    renderErrors([{ source: "Cleanerr", message: error.message }]);
    lastUpdatedAt = "";
    updatedAt.textContent = "-";
    updatedAt.removeAttribute("title");
    emptyState.hidden = false;
  } finally {
    loadingState.hidden = true;
    refreshButton.disabled = false;
    refreshButton.classList.remove("is-busy");
  }
}

refreshButton.addEventListener("click", loadLibrary);
brand.addEventListener("click", async (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  renderErrors([]);
  await navigateToView("all");
});

tabButtons.forEach((button) => {
  button.addEventListener("click", async (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    await navigateToView(button.dataset.view);
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
searchInput.addEventListener("input", () => {
  if (searchRenderTimer) clearTimeout(searchRenderTimer);
  searchRenderTimer = setTimeout(() => {
    activeQuery = normalizeSearchValue(searchInput.value.trim());
    searchRenderTimer = null;
    renderView();
  }, 120);
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !searchInput.value) return;
  clearSearch();
  renderView();
});
window.addEventListener("popstate", () => {
  navigateToView(viewFromLocation(), { historyMode: null });
});
document.addEventListener("click", (event) => {
  if (event.target.closest(".is-confirming")) return;
  if (activeConfirmationButton) resetDestructiveConfirmation(activeConfirmationButton);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (activeConfirmationButton) resetDestructiveConfirmation(activeConfirmationButton);
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

serviceForms.forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveServiceSettings(form);
  });
  form.querySelector(".test-connection-button").addEventListener("click", () => {
    testConnection(form);
  });
});

async function initialize() {
  const initialView = viewFromLocation();
  selectView(initialView);
  if (window.location.pathname === "/" || window.location.pathname.endsWith("/")) {
    updateRoute(initialView, "replace");
  }

  try {
    const currentSettings = await loadSettings();
    if (!currentSettings.complete) {
      await navigateToView("settings", { historyMode: "replace" });
      return;
    }
    if (activeView === "settings") {
      renderView();
      await loadStorage();
      return;
    }
    await loadLibrary();
  } catch (error) {
    await navigateToView("settings", { historyMode: "replace" });
    renderErrors([{ source: "Cleanerr", message: error.message }]);
    renderView();
  } finally {
    loadingState.hidden = true;
    refreshButton.disabled = false;
  }
}

initialize();
setInterval(renderUpdatedAt, 30000);
