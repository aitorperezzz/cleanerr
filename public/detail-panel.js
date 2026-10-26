import { formatBytes } from "./library-utils.js";
import { readJsonResponse } from "./http-client.js";

export function createDetailPanel({
  document, window, detailPanel, detailBackdrop, detailContent, detailCloseButton,
  renderPoster, getConfigurationRevision, confirmations, fetchImpl, requestAnimationFrame,
}) {
  let detailTrigger = null;

  function createSeasonItem(season, series, title) {
    const seasonItem = document.createElement("div");
    seasonItem.className = "season-item";
    const label = season.seasonNumber === 0 ? "Specials" : `Season ${season.seasonNumber}`;
    const episodes = `${season.episodeFileCount}/${season.totalEpisodeCount} episodes`;
    const hasFiles = season.episodeFileCount > 0 || season.sizeOnDisk > 0;
    const isMonitored = Boolean(season.monitored && series.monitored);
    seasonItem.dataset.seriesId = series.id;
    seasonItem.dataset.seriesTitle = title;
    seasonItem.dataset.seasonNumber = season.seasonNumber;
    seasonItem.dataset.seasonName = label;
    seasonItem.dataset.hasFiles = hasFiles;
    seasonItem.classList.toggle(
      "is-unmonitored-missing",
      !isMonitored && !hasFiles,
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
    episodeCount.dataset.monitored = String(isMonitored);
    const availabilityHint = isMonitored ? "Checking air dates..." : "Not monitored.";
    episodeCount.setAttribute("aria-label", `${episodes}. ${availabilityHint}`);
    episodeCount.title = availabilityHint;
    seasonItem.querySelector(".season-size").textContent = formatBytes(season.sizeOnDisk);
    const actionButton = seasonItem.querySelector(".season-action-button");

    if (!isMonitored && !hasFiles) {
      actionButton.classList.add("monitor-season-button");
      actionButton.textContent = "Monitor";
    } else {
      actionButton.classList.add("remove-season-button");
      actionButton.textContent = "Delete";
    }

    return seasonItem;
  }

  function renderSeasonAvailability(counter, status) {
    const isMonitored = counter.dataset.monitored === "true";
    counter.classList.toggle("is-up-to-date", isMonitored && Boolean(status) && status.state !== "missing");
    counter.classList.toggle("is-missing", isMonitored && status?.state === "missing");
    let description = "Episode air dates are unavailable.";
    if (status) {
      const episodes = `${status.episodeFileCount}/${status.totalEpisodeCount}`;
      counter.textContent = `${episodes} episodes`;
      counter.dataset.short = episodes;
      if (status.state === "missing") {
        description = `${status.missingEpisodeCount} aired episode(s) missing.`;
      } else if (status.unknownDateCount > 0) {
        description = `No known aired episodes are missing. Air dates are unknown for ${status.unknownDateCount} undownloaded episode(s).`;
      } else if (status.episodeFileCount === status.totalEpisodeCount) {
        description = "All episodes downloaded.";
      } else if (status.episodeFileCount === 0) {
        description = "Up to date. No episodes have aired yet.";
      } else {
        description = "Up to date. Remaining episodes have not aired yet.";
      }
    }
    if (!isMonitored) description = "Not monitored.";
    counter.title = description;
    counter.setAttribute("aria-label", `${counter.dataset.short} episodes. ${description}`);
  }

  async function loadSeasonAvailability(seasonList, seriesId) {
    const revision = getConfigurationRevision();
    const counters = [...seasonList.querySelectorAll(".season-item")];
    try {
      const response = await fetchImpl(`/api/library/sonarr/${seriesId}/season-availability`, { cache: "no-store" });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "Could not check air dates");
      if (revision !== getConfigurationRevision() || data.configurationRevision !== revision) return;
      const bySeason = new Map(data.seasons.map(season => [season.seasonNumber, season]));
      for (const row of counters) {
        renderSeasonAvailability(row.querySelector(".season-episodes"), bySeason.get(Number(row.dataset.seasonNumber)));
      }
    } catch {
      for (const row of counters) renderSeasonAvailability(row.querySelector(".season-episodes"), null);
    }
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
      loadSeasonAvailability(seasonList, item.id);
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

  function closeDetail({ restoreFocus = true } = {}) {
    if (detailPanel.hidden) return;
    confirmations.resetWithin(detailPanel);
    detailPanel.classList.remove("is-open");
    detailPanel.hidden = true;
    detailBackdrop.hidden = true;
    document.body.classList.remove("detail-open");
    detailContent.replaceChildren();
    if (restoreFocus && detailTrigger?.isConnected) detailTrigger.focus({ preventScroll: true });
    detailTrigger = null;
  }

  return { createSeasonItem, renderSeasonAvailability, openMediaDetail, openCollectionDetail, closeDetail };
}
