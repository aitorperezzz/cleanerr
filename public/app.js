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
let settingsState = null;
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
let detailTrigger = null;

const searchTextCache = new WeakMap();
const viewRenderCache = new Map();
const mediaCards = new WeakMap();
const GRID_BATCH_SIZE = 24;
let gridRenderToken = 0;

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

function createSeasonItem(season, series, title) {
  const seasonItem = document.createElement("div");
  seasonItem.className = "season-item";
  const label = season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`;
  const episodes = `${season.episodeFileCount}/${season.totalEpisodeCount} episodes`;
  const hasFiles = season.episodeFileCount > 0 || season.sizeOnDisk > 0;
  seasonItem.dataset.seriesId = series.id;
  seasonItem.dataset.seriesTitle = title;
  seasonItem.dataset.seasonNumber = season.seasonNumber;
  seasonItem.dataset.seasonName = label;
  seasonItem.dataset.hasFiles = hasFiles;
  seasonItem.classList.toggle(
    "is-unmonitored-missing",
    (!season.monitored || !series.monitored) && !hasFiles,
  );
  seasonItem.innerHTML = `
    <span class="season-name"></span>
    <span class="season-episodes muted"></span>
    <strong class="season-size"></strong>
    <button class="season-action-button" type="button"></button>
  `;
  seasonItem.querySelector(".season-name").textContent = label;
  const episodeCount = seasonItem.querySelector(".season-episodes");
  episodeCount.textContent = episodes;
  episodeCount.dataset.short = `${season.episodeFileCount}/${season.totalEpisodeCount}`;
  episodeCount.setAttribute("aria-label", episodes);
  seasonItem.querySelector(".season-size").textContent = formatBytes(season.sizeOnDisk);
  const actionButton = seasonItem.querySelector(".season-action-button");

  if (!series.monitored) {
    actionButton.classList.add("season-series-unmonitored-button");
    actionButton.textContent = "Series not monitored";
    actionButton.disabled = true;
  } else if (!season.monitored) {
    actionButton.classList.add("monitor-season-button");
    actionButton.textContent = "Monitor";
  } else {
    actionButton.classList.add("remove-season-button");
    actionButton.textContent = "Delete";
  }

  return seasonItem;
}

function createCollectionMovie(movie) {
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
}

function detailFact(label, value, className = "") {
  const fact = document.createElement("div");
  fact.className = `detail-fact ${className}`.trim();
  const term = document.createElement("span");
  const description = document.createElement("strong");
  term.textContent = label;
  description.textContent = value || "-";
  fact.append(term, description);
  return fact;
}

function prepareDetailPanel(trigger) {
  detailTrigger = trigger;
  detailContent.scrollTop = 0;
  detailPanel.hidden = false;
  detailBackdrop.hidden = false;
  document.body.classList.add("detail-open");
  detailCloseButton.setAttribute("aria-label", window.innerWidth <= 720 ? "Back to library" : "Close details");
  requestAnimationFrame(() => detailPanel.classList.add("is-open"));
  detailCloseButton.focus({ preventScroll: true });
}

function openMediaDetail(card, item) {
  const title = item.year ? `${item.title} (${item.year})` : item.title;
  detailPanel.dataset.service = item.service;
  detailPanel.dataset.id = item.id;
  detailPanel.dataset.title = title;
  detailPanel.dataset.type = item.type;
  detailPanel.dataset.monitored = item.monitored;
  detailPanel.dataset.collection = item.collection || "";
  detailPanel.dataset.collectionMonitored = item.collectionMonitored || false;
  detailContent.innerHTML = `
    <section class="detail-hero">
      <div class="poster detail-poster" aria-hidden="true"></div>
      <div class="detail-hero-copy">
        <span class="detail-type-badge"></span>
        <h2 id="detailTitle"></h2>
        <p class="detail-source"></p>
        <strong class="detail-size"></strong>
      </div>
    </section>
    <section class="detail-facts" aria-label="Media details"></section>
    <section class="detail-actions"></section>
  `;
  renderPoster(detailContent.querySelector(".detail-poster"), item);
  const typeBadge = detailContent.querySelector(".detail-type-badge");
  typeBadge.textContent = item.type;
  typeBadge.classList.add(`detail-type-${item.service}`);
  detailContent.querySelector("#detailTitle").textContent = item.title;
  detailContent.querySelector(".detail-source").textContent =
    `${item.source}${item.year ? ` · ${item.year}` : ""}`;
  detailContent.querySelector(".detail-size").textContent = formatBytes(item.sizeOnDisk);

  const facts = detailContent.querySelector(".detail-facts");
  facts.append(detailFact("Path", item.path, "detail-path"));
  if (item.collection) {
    facts.append(detailFact(
      "Collection",
      `${item.collection}${item.collectionMonitored ? " · Monitored" : ""}`,
    ));
  }
  if (item.service === "sonarr") {
    facts.append(detailFact("Monitoring", item.monitored ? "Monitored" : "Not monitored"));
  }

  const actions = detailContent.querySelector(".detail-actions");
  if (item.service === "sonarr" && !item.monitored) {
    const monitorButton = document.createElement("button");
    monitorButton.className = "monitor-series-button";
    monitorButton.type = "button";
    monitorButton.textContent = "Monitor";
    actions.append(monitorButton);
  }
  const deleteButton = document.createElement("button");
  deleteButton.className = "delete-button";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  actions.append(deleteButton);

  if (item.service === "sonarr") {
    const section = document.createElement("section");
    section.className = "detail-section";
    const heading = document.createElement("div");
    heading.className = "detail-section-heading";
    const headingTitle = document.createElement("h3");
    const count = item.seasons?.length || 0;
    headingTitle.textContent = "Seasons";
    const headingCount = document.createElement("span");
    headingCount.textContent = `${count} total`;
    heading.append(headingTitle, headingCount);
    const seasonList = document.createElement("div");
    seasonList.className = "season-list";
    seasonList.replaceChildren(
      ...(item.seasons || [])
        .slice()
        .sort((a, b) => a.seasonNumber - b.seasonNumber)
        .map((season) => createSeasonItem(season, item, title)),
    );
    section.append(heading, seasonList);
    detailContent.append(section);
  }
  prepareDetailPanel(card?.querySelector(".media-card-button") || null);
}

function openCollectionDetail(card, collection) {
  detailPanel.dataset.id = collection.id;
  detailPanel.dataset.title = collection.title;
  detailPanel.dataset.existingMovieCount = collection.existingMovieCount;
  detailPanel.dataset.sizeOnDisk = collection.sizeOnDisk;
  delete detailPanel.dataset.service;
  delete detailPanel.dataset.collection;
  detailContent.innerHTML = `
    <section class="detail-hero">
      <div class="poster detail-poster" aria-hidden="true"></div>
      <div class="detail-hero-copy">
        <span class="detail-type-badge">Collection</span>
        <h2 id="detailTitle"></h2>
        <p class="detail-source"></p>
        <strong class="detail-size"></strong>
      </div>
    </section>
    <section class="detail-facts" aria-label="Collection details"></section>
    <section class="detail-actions">
      <button class="toggle-collection-monitor-button" type="button"></button>
      <button class="delete-collection-button" type="button">Delete movies</button>
    </section>
    <section class="detail-section">
      <div class="detail-section-heading"><h3>Movies</h3><span class="detail-movie-count"></span></div>
      <div class="collection-movies"></div>
    </section>
  `;
  renderPoster(detailContent.querySelector(".detail-poster"), {
    ...collection,
    type: "Collection",
  });
  detailContent.querySelector("#detailTitle").textContent = collection.title;
  detailContent.querySelector(".detail-source").textContent = "Radarr";
  detailContent.querySelector(".detail-size").textContent = formatBytes(collection.sizeOnDisk);
  detailContent.querySelector(".detail-facts").append(
    detailFact("Library", `${collection.existingMovieCount}/${collection.movieCount} movies available`),
    detailFact("Monitoring", collection.monitored ? "Monitored" : "Not monitored"),
  );
  const monitorButton = detailContent.querySelector(".toggle-collection-monitor-button");
  monitorButton.dataset.monitored = collection.monitored;
  monitorButton.textContent = collection.monitored ? "Unmonitor" : "Monitor";
  const deleteMoviesButton = detailContent.querySelector(".delete-collection-button");
  deleteMoviesButton.disabled = collection.existingMovieCount === 0;
  if (deleteMoviesButton.disabled) deleteMoviesButton.textContent = "No movies to delete";
  detailContent.querySelector(".detail-movie-count").textContent = `${collection.movieCount} total`;
  detailContent
    .querySelector(".collection-movies")
    .replaceChildren(...collection.movies.map(createCollectionMovie));
  prepareDetailPanel(card?.querySelector(".media-card-button") || null);
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

function closeDetail({ restoreFocus = true } = {}) {
  if (detailPanel.hidden) return;
  if (activeConfirmationButton && detailPanel.contains(activeConfirmationButton)) {
    resetActionConfirmation(activeConfirmationButton);
  }
  detailPanel.classList.remove("is-open");
  detailPanel.hidden = true;
  detailBackdrop.hidden = true;
  document.body.classList.remove("detail-open");
  detailContent.replaceChildren();
  if (restoreFocus && detailTrigger?.isConnected) detailTrigger.focus({ preventScroll: true });
  detailTrigger = null;
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

const confirmationTimers = new WeakMap();
let activeConfirmationButton = null;

function resetActionConfirmation(button) {
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
    detailContent.style.removeProperty("--confirmation-clearance");
    confirmationNotice.hidden = true;
    confirmationNotice.classList.remove("is-action");
    confirmationTitle.textContent = "Confirm action";
    confirmationMessage.textContent = "";
  }
}

function keepConfirmationButtonVisible(button) {
  if (!detailPanel.contains(button)) return;

  requestAnimationFrame(() => {
    if (activeConfirmationButton !== button || !button.isConnected) return;
    const panelBottom = detailPanel.getBoundingClientRect().bottom;
    const noticeTop = confirmationNotice.getBoundingClientRect().top;
    const clearance = Math.max(0, panelBottom - noticeTop + 12);
    detailContent.style.setProperty("--confirmation-clearance", `${clearance}px`);
    button.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  });
}

function confirmAction(button, message, { title = "Confirm action", destructive = false } = {}) {
  if (button.dataset.confirming === "true") {
    resetActionConfirmation(button);
    return true;
  }

  if (activeConfirmationButton) resetActionConfirmation(activeConfirmationButton);
  button.dataset.defaultLabel = button.textContent;
  button.dataset.confirming = "true";
  button.classList.add("is-confirming");
  button.setAttribute("aria-pressed", "true");
  button.textContent = "Are you sure?";
  activeConfirmationButton = button;
  confirmationNotice.classList.toggle("is-action", !destructive);
  confirmationTitle.textContent = title;
  confirmationMessage.textContent = message;
  confirmationNotice.hidden = false;
  keepConfirmationButtonVisible(button);
  confirmationTimers.set(button, setTimeout(() => resetActionConfirmation(button), 5000));
  return false;
}

function confirmDestructiveAction(button, message) {
  return confirmAction(button, message, { title: "Confirm deletion", destructive: true });
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
  if (!configurationRevision) throw new Error("Refresh the library before performing an action.");
  return fetch(url, {
    ...options,
    headers: { ...options.headers, "X-Cleanerr-Request": "1", "X-Cleanerr-Library-Revision": configurationRevision },
  });
}

function invalidateLibrary() {
  libraryLoadGeneration += 1;
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
    renderErrors([{ source: "Cleanerr", message: error.message }]);
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
    renderErrors([{ source: "Cleanerr", message: error.message }]);
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
    renderErrors([{ source: "Cleanerr", message: error.message }]);
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
    renderErrors([{ source: "Cleanerr", message: error.message }]);
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
    renderErrors([{ source: "Cleanerr", message: error.message }]);
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

    await loadLibrary();
    if (data.deleted?.failure) {
      const { deletedMovies, totalMovies, failure } = data.deleted;
      const notAttempted = totalMovies - deletedMovies - 1;
      renderErrors([{
        source: "Radarr",
        message: `${deletedMovies} of ${totalMovies} movie(s) confirmed deleted from “${title}”. Could not confirm deletion of “${failure.title}”: ${failure.message}${notAttempted ? ` ${notAttempted} remaining movie(s) were not attempted.` : ""} Check Radarr before retrying.`,
      }]);
      errorPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    renderErrors([{ source: "Cleanerr", message: error.message }]);
    button.disabled = false;
    button.classList.remove("is-busy");
    button.textContent = "Delete movies";
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
      headers: { "content-type": "application/json", "X-Cleanerr-Request": "1" },
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
      headers: { "content-type": "application/json", "X-Cleanerr-Request": "1" },
      body: JSON.stringify(formPayload(form)),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Could not save settings");
    invalidateLibrary();
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
  } catch (error) {
    if (generation !== libraryLoadGeneration) return;
    configurationRevision = "";
    libraryItems = [];
    collectionItems = [];
    libraryRevision += 1;
    clearViewRenderCache();
    renderErrors([{ source: "Cleanerr", message: error.message }]);
    lastUpdatedAt = "";
    updatedAt.textContent = "-";
    updatedAt.removeAttribute("title");
    emptyState.hidden = false;
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
  if (activeConfirmationButton) resetActionConfirmation(activeConfirmationButton);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (activeConfirmationButton) {
    resetActionConfirmation(activeConfirmationButton);
    return;
  }
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
