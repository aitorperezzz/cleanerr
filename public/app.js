import { readJsonResponse } from "./http-client.js";
import { createActionConfirmation } from "./action-confirmation.js";
import { createDetailPanel } from "./detail-panel.js";
import { createServiceSettings } from "./service-settings.js";
import { sendLibraryAction, refreshAfterActionError } from "./library-action-client.js";
import { loadLibrarySnapshot } from "./library-loader.js";
import {
  formatBytes,
  formatDate,
  normalizeSearchValue,
  sortCollectionItems,
  sortMediaItems,
} from "./library-utils.js";

const refreshButton = document.querySelector("#refreshButton");
const loadingState = document.querySelector("#loadingState");
const emptyState = document.querySelector("#emptyState");
const mediaGrid = document.querySelector("#mediaGrid");
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
const confirmationTitle = document.querySelector("#confirmationTitle");
const confirmationMessage = document.querySelector("#confirmationMessage");
const storageStateElement = document.querySelector("#storageState");
const storageList = document.querySelector("#storageList");
const storageUpdatedAt = document.querySelector("#storageUpdatedAt");
const detailBackdrop = document.querySelector("#detailBackdrop");
const detailPanel = document.querySelector("#detailPanel");
const detailContent = document.querySelector("#detailContent");
const detailCloseButton = document.querySelector("#detailCloseButton");

let libraryItems = [];
let collectionItems = [];
let storageState = null;
let activeView = "all";
let activeSort = "size";
let activeQuery = "";
let lastUpdatedAt = "";
let searchRenderTimer = null;
let libraryRevision = 0;
let configurationRevision = "";
let libraryLoadGeneration = 0;
let renderedGridKey = null;

const searchTextCache = new WeakMap();
const viewRenderCache = new Map();
const mediaCards = new WeakMap();
const GRID_BATCH_SIZE = 24;
let gridRenderToken = 0;

const confirmations = createActionConfirmation({
  detailPanel, detailContent, confirmationNotice, confirmationTitle, confirmationMessage,
  requestAnimationFrame, setTimeout, clearTimeout,
});
const { confirmAction, confirmDestructiveAction } = confirmations;
const { createSeasonItem, renderSeasonAvailability, openMediaDetail, openCollectionDetail, closeDetail } = createDetailPanel({
  document, window, detailPanel, detailBackdrop, detailContent, detailCloseButton,
  renderPoster, getConfigurationRevision: () => configurationRevision,
  confirmations, fetchImpl: fetch, requestAnimationFrame,
});
const settingsController = createServiceSettings({
  serviceForms, fetchImpl: fetch, invalidateLibrary,
  onServiceSaved(service) {
    if (service === "radarr" || service === "sonarr") {
      storageState = null;
      loadStorage();
    }
  },
});
const { loadSettings, renderSettings, testConnection, saveServiceSettings } = settingsController;

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
  return sortMediaItems(items, activeSort);
}

function sortCollections(collections) {
  return sortCollectionItems(collections, activeSort);
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

function currentViewCacheKey() {
  if (activeQuery) return null;
  return `${libraryRevision}:${activeView}:${activeSort}`;
}

function clearViewRenderCache() {
  gridRenderToken += 1;
  viewRenderCache.clear();
  renderedGridKey = null;
  mediaGrid.replaceChildren();
}

function renderPoster(element, item) {
  element.replaceChildren();
  if (item.posterUrl) {
    const image = document.createElement("img");
    image.className = "poster-image";
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.fetchPriority = "low";
    image.src = item.posterUrl;
    image.addEventListener(
      "error",
      () => {
        image.remove();
        element.textContent = item.type?.slice(0, 1) || "C";
      },
      { once: true },
    );
    element.append(image);
    return;
  }

  element.textContent = item.type?.slice(0, 1) || "C";
}

function createMediaCard(item) {
  const card = document.createElement("article");
  const showType = activeView === "all";
  card.className = `media-card source-${item.service}`;
  card.innerHTML = `
    <button class="media-card-button" type="button">
      <span class="poster media-card-poster" aria-hidden="true"></span>
      <span class="media-card-shade" aria-hidden="true"></span>
      <span class="media-card-type"${showType ? "" : " hidden"}></span>
      <strong class="media-card-size"></strong>
    </button>
    <div class="media-card-copy">
      <h2 class="media-card-title"></h2>
    </div>
  `;
  const title = item.year ? `${item.title} (${item.year})` : item.title;
  const button = card.querySelector(".media-card-button");
  button.setAttribute("aria-label", `Open details for ${title}`);
  renderPoster(card.querySelector(".media-card-poster"), item);
  card.querySelector(".media-card-type").textContent = item.type;
  card.querySelector(".media-card-size").textContent = formatBytes(item.sizeOnDisk);
  card.querySelector(".media-card-title").textContent = item.title;
  mediaCards.set(card, { kind: "media", item });
  return card;
}

function createCollectionCard(collection) {
  const card = document.createElement("article");
  card.className = "media-card source-radarr collection-grid-card";
  card.innerHTML = `
    <button class="media-card-button" type="button">
      <span class="poster media-card-poster" aria-hidden="true"></span>
      <span class="media-card-shade" aria-hidden="true"></span>
      <span class="media-card-type">Collection</span>
      <span class="collection-monitor-indicator" role="img" aria-label="Monitored" title="Monitored"${collection.monitored ? "" : " hidden"}></span>
      <strong class="media-card-size"></strong>
    </button>
    <div class="media-card-copy">
      <h2 class="media-card-title"></h2>
    </div>
  `;
  const button = card.querySelector(".media-card-button");
  button.setAttribute("aria-label", `Open details for ${collection.title}`);
  renderPoster(card.querySelector(".media-card-poster"), { ...collection, type: "Collection" });
  card.querySelector(".media-card-size").textContent = formatBytes(collection.sizeOnDisk);
  card.querySelector(".media-card-title").textContent = collection.title;
  mediaCards.set(card, { kind: "collection", item: collection });
  return card;
}

function renderGrid(items, cacheKey, kind = "media") {
  if (cacheKey && renderedGridKey === cacheKey) return;
  const token = ++gridRenderToken;
  const entry = (cacheKey && viewRenderCache.get(cacheKey)) || {
    items,
    kind,
    nodes: [],
  };
  mediaGrid.replaceChildren(...entry.nodes);
  renderedGridKey = cacheKey;
  if (cacheKey) viewRenderCache.set(cacheKey, entry);

  function appendBatch() {
    if (token !== gridRenderToken) return;
    const end = Math.min(entry.nodes.length + GRID_BATCH_SIZE, entry.items.length);
    const fragment = document.createDocumentFragment();
    for (let index = entry.nodes.length; index < end; index += 1) {
      const node = entry.kind === "collection"
        ? createCollectionCard(entry.items[index])
        : createMediaCard(entry.items[index]);
      entry.nodes.push(node);
      fragment.append(node);
    }
    mediaGrid.append(fragment);
    if (end < entry.items.length) {
      requestAnimationFrame(() => setTimeout(appendBatch, 0));
    }
  }

  appendBatch();
}

function detailRouteKey(record) {
  return record.kind === "collection"
    ? `collection:${record.item.id}`
    : `${record.item.service}:${record.item.id}`;
}

function openCardDetail(card) {
  const record = mediaCards.get(card);
  if (!record) return;
  if (window.innerWidth <= 720) {
    const url = new URL(window.location.href);
    url.searchParams.set("detail", detailRouteKey(record));
    window.history.pushState({ detailEntry: true }, "", url);
  }
  if (record.kind === "collection") openCollectionDetail(card, record.item);
  else openMediaDetail(card, record.item);
}

function openDetailFromLocation() {
  const key = new URLSearchParams(window.location.search).get("detail");
  if (!key || activeView === "settings") return;
  const [source, id] = key.split(":");
  if (!id) return;
  if (source === "collection") {
    const collection = collectionItems.find((item) => String(item.id) === id);
    if (collection) openCollectionDetail(null, collection);
    return;
  }
  const item = libraryItems.find((entry) => entry.service === source && String(entry.id) === id);
  if (item) openMediaDetail(null, item);
}

function dismissDetail() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("detail")) {
    closeDetail();
    return;
  }
  if (window.history.state?.detailEntry) {
    closeDetail();
    window.history.back();
    return;
  }
  url.searchParams.delete("detail");
  window.history.replaceState({}, "", url);
  closeDetail();
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
        <div class="storage-available">
          <strong></strong>
          <span>available</span>
        </div>
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
      card.querySelector(".storage-available strong").textContent = formatBytes(freeSpace);
      card.querySelector(".storage-used").textContent = formatBytes(usedSpace);
      card.querySelector(".storage-total").textContent = formatBytes(totalSpace);
      const meter = card.querySelector(".storage-meter");
      meter.setAttribute("aria-valuenow", String(Math.round(usedPercent)));
      meter.setAttribute(
        "aria-valuetext",
        `${formatBytes(usedSpace)} used, ${formatBytes(freeSpace)} available`,
      );
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
  const viewChanged = activeView !== view;
  const fromDetail = new URLSearchParams(window.location.search).has("detail");
  closeDetail({ restoreFocus: false });
  if (resetSearch) clearSearch();
  selectView(view);
  if (historyMode) updateRoute(view, fromDetail ? "replace" : historyMode);
  renderView();
  if (viewChanged) window.scrollTo(0, 0);

  if (activeView === "settings") {
    await loadStorage();
  } else if (libraryItems.length === 0) {
    await loadLibrary();
  }
  if (!historyMode) openDetailFromLocation();
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
  mediaGrid.hidden = true;

  if (isSettingsView) {
    gridRenderToken += 1;
    renderedGridKey = null;
    renderSettings();
    renderStorage();
    return;
  }

  if (isCollectionsView) {
    const visibleCollections = getVisibleCollections();
    renderGrid(visibleCollections, currentViewCacheKey(), "collection");

    const hasCollections = visibleCollections.length > 0;
    emptyState.textContent = activeQuery ? "No matching results." : "No content to show.";
    mediaGrid.hidden = !hasCollections;
    emptyState.hidden = hasCollections;
    return;
  }

  const visibleItems = getVisibleItems();
  renderGrid(visibleItems, currentViewCacheKey());

  const hasItems = visibleItems.length > 0;
  emptyState.textContent = activeQuery ? "No matching results." : "No content to show.";
  mediaGrid.hidden = !hasItems;
  emptyState.hidden = hasItems;
}

async function fetchLibraryAction(url, options) {
  return sendLibraryAction(url, options, { configurationRevision, fetchImpl: fetch, readResponse: readJsonResponse });
}

async function reportLibraryActionError(error) {
  await refreshAfterActionError(error, { reload: loadLibrary, render: renderErrors });
  errorPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function invalidateLibrary() {
  libraryLoadGeneration += 1;
  loadingState.hidden = true;
  refreshButton.disabled = false;
  refreshButton.classList.remove("is-busy");
  configurationRevision = "";
  libraryItems = [];
  collectionItems = [];
  libraryRevision += 1;
  clearViewRenderCache();
  closeDetail({ restoreFocus: false });
  lastUpdatedAt = "";
  updatedAt.textContent = "-";
  updatedAt.removeAttribute("title");
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
    const response = await fetchLibraryAction(endpoint, { method: "DELETE" });
    const data = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(data.error || "Could not delete the library item");
    }

    await loadLibrary();
  } catch (error) {
    await reportLibraryActionError(error);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Delete";
  }
}

async function monitorSeries(row) {
  const title = row.dataset.title;
  const button = row.querySelector(".monitor-series-button");
  const message = `“${title}” and any seasons already marked as monitored will be monitored in Sonarr.`;
  if (!confirmAction(button, message)) return;

  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Updating...";

  try {
    const response = await fetchLibraryAction(`/api/library/sonarr/${row.dataset.id}/monitor`, {
      method: "PATCH",
    });
    const data = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(data.error || "Could not monitor the series");
    }

    await loadLibrary();
  } catch (error) {
    await reportLibraryActionError(error);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Monitor";
  }
}

async function removeSeason(seasonItem) {
  const button = seasonItem.querySelector(".remove-season-button");
  const hasFiles = seasonItem.dataset.hasFiles === "true";
  const message = hasFiles
    ? `${seasonItem.dataset.seasonName} of “${seasonItem.dataset.seriesTitle}” will be unmonitored in Sonarr and its downloaded episode files will be deleted from disk.`
    : `${seasonItem.dataset.seasonName} of “${seasonItem.dataset.seriesTitle}” will be unmonitored in Sonarr. There are no files to delete.`;
  if (!confirmDestructiveAction(button, message)) return;

  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Removing...";

  try {
    const response = await fetchLibraryAction(
      `/api/library/sonarr/${seasonItem.dataset.seriesId}/seasons/${seasonItem.dataset.seasonNumber}`,
      { method: "DELETE" },
    );
    const data = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(data.error || "Could not remove the season");
    }

    await loadLibrary();
  } catch (error) {
    await reportLibraryActionError(error);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Delete";
  }
}

async function monitorSeason(seasonItem) {
  const seriesTitle = seasonItem.dataset.seriesTitle;
  const seasonName = seasonItem.dataset.seasonName;
  const button = seasonItem.querySelector(".monitor-season-button");
  const message = `${seasonName} of “${seriesTitle}” will be monitored and searched in Sonarr now.`;
  if (!confirmAction(button, message)) return;

  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Starting search...";

  try {
    const response = await fetchLibraryAction(
      `/api/library/sonarr/${seasonItem.dataset.seriesId}/seasons/${seasonItem.dataset.seasonNumber}/monitor`,
      { method: "PATCH" },
    );
    const data = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(data.error || "Could not monitor and search the season");
    }

    await loadLibrary();
  } catch (error) {
    await reportLibraryActionError(error);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Monitor";
  }
}

async function setCollectionMonitoring(card) {
  const title = card.dataset.title;
  const button = card.querySelector(".toggle-collection-monitor-button");
  const shouldMonitor = button.dataset.monitored !== "true";
  const message = shouldMonitor
    ? `“${title}” will be monitored and synced in Radarr. Missing movies will be added and searched now.`
    : `Radarr will stop monitoring “${title}”.`;
  if (!confirmAction(button, message)) return;

  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Updating...";

  try {
    const action = shouldMonitor ? "monitor" : "unmonitor";
    const response = await fetchLibraryAction(`/api/collections/${card.dataset.id}/${action}`, {
      method: "PATCH",
    });
    const data = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(data.error || (shouldMonitor ? "Could not monitor and sync the collection" : "Could not unmonitor the collection"));
    }

    await loadLibrary();
  } catch (error) {
    await reportLibraryActionError(error);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = shouldMonitor ? "Monitor" : "Unmonitor";
  }
}

async function deleteCollection(card) {
  const button = card.querySelector(".delete-collection-button");
  const title = card.dataset.title;
  const message = `The collection “${title}” will remain in Radarr but will be unmonitored. Its ${card.dataset.existingMovieCount} existing movie(s) (${formatBytes(Number(card.dataset.sizeOnDisk || 0))}) will be deleted from Radarr and disk.`;
  if (!confirmDestructiveAction(button, message)) return;

  button.disabled = true;
  button.classList.add("is-busy");
  button.textContent = "Deleting...";

  try {
    const response = await fetchLibraryAction(`/api/collections/${card.dataset.id}`, {
      method: "DELETE",
    });
    const data = await readJsonResponse(response);

    if (!response.ok) {
      throw new Error(data.error || "Could not delete the collection movies");
    }

    const refreshed = await loadLibrary();
    if (data.deleted?.failure) {
      const { deletedMovies, totalMovies, failure } = data.deleted;
      const notAttempted = totalMovies - deletedMovies - 1;
      renderErrors([...(refreshed?.errors || []), {
        source: "Radarr",
        message: `The collection was unmonitored. ${deletedMovies} of ${totalMovies} movie(s) confirmed deleted from “${title}”. Could not confirm deletion of “${failure.title}”: ${failure.message}${notAttempted ? ` ${notAttempted} remaining movie(s) were not attempted.` : ""} Check Radarr before retrying.`,
      }]);
      errorPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    await reportLibraryActionError(error);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Delete movies";
  }
}

async function loadLibrary() {
  const generation = ++libraryLoadGeneration;
  if (!detailPanel.hidden && new URLSearchParams(window.location.search).has("detail")) {
    if (window.history.state?.detailEntry) window.history.back();
    else window.history.replaceState({}, "", viewPaths[activeView]);
  }
  closeDetail({ restoreFocus: false });
  refreshButton.disabled = true;
  refreshButton.classList.add("is-busy");
  loadingState.hidden = false;
  emptyState.hidden = true;
  mediaGrid.hidden = true;

  try {
    const data = await loadLibrarySnapshot({ fetchImpl: fetch, readResponse: readJsonResponse });
    if (generation !== libraryLoadGeneration) return;
    configurationRevision = data.configurationRevision;
    libraryItems = data.items;
    collectionItems = data.collections;
    libraryRevision += 1;
    clearViewRenderCache();
    lastUpdatedAt = data.updatedAt;
    renderUpdatedAt();
    renderErrors(data.errors);
    renderView();
    return data;
  } catch (error) {
    if (generation !== libraryLoadGeneration) return;
    configurationRevision = "";
    libraryItems = [];
    collectionItems = [];
    libraryRevision += 1;
    clearViewRenderCache();
    const errors = [{ source: "Cleanerr", message: error.message }];
    renderErrors(errors);
    lastUpdatedAt = "";
    updatedAt.textContent = "-";
    updatedAt.removeAttribute("title");
    emptyState.hidden = false;
    return { errors };
  } finally {
    if (generation !== libraryLoadGeneration) return;
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
    if (activeSort === button.dataset.sort) return;
    activeSort = button.dataset.sort;
    clearViewRenderCache();
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
  if (!new URLSearchParams(window.location.search).has("detail")) closeDetail();
  navigateToView(viewFromLocation(), { historyMode: null, resetSearch: false });
});
document.addEventListener("click", (event) => {
  if (event.target.closest(".is-confirming")) return;
  confirmations.resetWithin();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (confirmations.resetWithin()) return;
  dismissDetail();
});
mediaGrid.addEventListener("click", (event) => {
  const button = event.target.closest(".media-card-button");
  if (button) openCardDetail(button.closest(".media-card"));
});
detailContent.addEventListener("click", (event) => {
  const monitorSeriesButton = event.target.closest(".monitor-series-button");
  if (monitorSeriesButton) {
    monitorSeries(detailPanel);
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

  const deleteButton = event.target.closest(".delete-button");
  if (deleteButton) {
    deleteItem(detailPanel);
    return;
  }

  const monitorButton = event.target.closest(".toggle-collection-monitor-button");
  if (monitorButton) {
    setCollectionMonitoring(detailPanel);
    return;
  }

  const deleteCollectionButton = event.target.closest(".delete-collection-button");
  if (deleteCollectionButton) {
    deleteCollection(detailPanel);
  }
});
detailCloseButton.addEventListener("click", dismissDetail);
detailBackdrop.addEventListener("click", dismissDetail);

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
    openDetailFromLocation();
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
