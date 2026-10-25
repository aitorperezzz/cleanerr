import assert from "node:assert/strict";
import test from "node:test";
import { createLibraryActions } from "../library-actions.js";

function setup({ responses = {}, deleteEndpoint } = {}) {
  const services = {
    radarr: { label: "Radarr", url: "http://radarr:7878" },
    sonarr: { label: "Sonarr", url: "http://sonarr:8989" },
  };
  const calls = { fetch: [], send: [], delete: [], jellyfinRefresh: [] };
  const actions = createLibraryActions({
    getService: (name) => services[name],
    fetchJson: async (service, endpoint) => {
      calls.fetch.push({ service: service.label, endpoint });
      const response = responses[`${service.label}:${endpoint}`];
      return typeof response === "function" ? response() : structuredClone(response);
    },
    sendJson: async (service, endpoint, method, body) => {
      calls.send.push({ service: service.label, endpoint, method, body: structuredClone(body) });
      return body;
    },
    deleteEndpoint: deleteEndpoint || (async (service, url) => {
      calls.delete.push({ service: service.label, url: String(url) });
    }),
    refreshJellyfinLibrary: async () => {
      calls.jellyfinRefresh.push(true);
    },
  });
  return { actions, calls };
}

test("movie deletion removes files without adding a Radarr import exclusion", async () => {
  const { actions, calls } = setup();
  const result = await actions.deleteFromService("radarr", "42");

  assert.deepEqual(result, { source: "Radarr", id: 42 });
  assert.equal(calls.delete.length, 1);
  const url = new URL(calls.delete[0].url);
  assert.equal(url.pathname, "/api/v3/movie/42");
  assert.equal(url.searchParams.get("deleteFiles"), "true");
  assert.equal(url.searchParams.get("addImportExclusion"), "false");
  assert.equal(calls.jellyfinRefresh.length, 1);
});

test("series deletion uses the Sonarr import-list exclusion", async () => {
  const { actions, calls } = setup();
  await actions.deleteFromService("sonarr", 7);
  const url = new URL(calls.delete[0].url);
  assert.equal(url.pathname, "/api/v3/series/7");
  assert.equal(url.searchParams.get("deleteFiles"), "true");
  assert.equal(url.searchParams.get("addImportListExclusion"), "true");
  assert.equal(calls.jellyfinRefresh.length, 1);
});

test("removing a season unmonitors it and deletes each episode file once", async () => {
  const { actions, calls } = setup({
    responses: {
      "Sonarr:series/5": {
        id: 5,
        monitored: true,
        seasons: [{ seasonNumber: 1, monitored: true }],
      },
      "Sonarr:episode?seriesId=5&includeEpisodeFile=true": [
        { seasonNumber: 1, episodeFileId: 10, episodeFile: { size: 100 } },
        { seasonNumber: 1, episodeFileId: 10, episodeFile: { size: 100 } },
        { seasonNumber: 1, episodeFileId: 11, episodeFile: { size: 250 } },
        { seasonNumber: 2, episodeFileId: 12, episodeFile: { size: 500 } },
      ],
    },
  });
  const result = await actions.removeSeason(5, 1);

  assert.deepEqual(result, {
    source: "Sonarr",
    seriesId: 5,
    seasonNumber: 1,
    deletedFiles: 2,
    deletedSize: 350,
  });
  assert.equal(calls.send[0].body.seasons[0].monitored, false);
  assert.deepEqual(
    calls.delete.map((call) => new URL(call.url).pathname),
    ["/api/v3/episodefile/10", "/api/v3/episodefile/11"],
  );
  assert.equal(calls.jellyfinRefresh.length, 1);
});

test("removing an empty monitored season only unmonitors it", async () => {
  const { actions, calls } = setup({
    responses: {
      "Sonarr:series/5": {
        id: 5,
        seasons: [{ seasonNumber: 1, monitored: true }],
      },
      "Sonarr:episode?seriesId=5&includeEpisodeFile=true": [],
    },
  });

  const result = await actions.removeSeason(5, 1);

  assert.equal(result.deletedFiles, 0);
  assert.equal(calls.send[0].body.seasons[0].monitored, false);
  assert.equal(calls.delete.length, 0);
  assert.equal(calls.jellyfinRefresh.length, 0);
});

test("collection-safe movie deletion unmonitors its collection first", async () => {
  const { actions, calls } = setup({
    responses: {
      "Radarr:movie/8": { id: 8, tmdbId: 80 },
      "Radarr:collection": [
        { id: 3, title: "Saga", monitored: true, movies: [{ tmdbId: 80 }] },
      ],
    },
  });
  const result = await actions.unmonitorCollectionAndDeleteMovie(8);

  assert.equal(result.unmonitoredCollection, true);
  assert.equal(result.collectionTitle, "Saga");
  assert.equal(calls.send[0].endpoint, "collection/3");
  assert.equal(calls.send[0].body.monitored, false);
  assert.equal(new URL(calls.delete[0].url).pathname, "/api/v3/movie/8");
  assert.equal(new URL(calls.delete[0].url).searchParams.get("addImportExclusion"), "false");
  assert.equal(calls.jellyfinRefresh.length, 1);
});

test("deleting a collection only deletes movies belonging to it", async () => {
  const { actions, calls } = setup({
    responses: {
      "Radarr:collection/4": {
        id: 4,
        monitored: true,
        movies: [{ tmdbId: 1 }, { tmdbId: 2 }, { title: "Unknown" }],
      },
      "Radarr:movie": [
        { id: 11, tmdbId: 1 },
        { id: 12, tmdbId: 2 },
        { id: 13, tmdbId: 3 },
        { id: 14 },
      ],
    },
  });
  const result = await actions.deleteCollection(4);

  assert.equal(result.deletedMovies, 2);
  assert.equal(result.totalMovies, 2);
  assert.equal(result.failure, null);
  assert.equal(calls.send[0].body.monitored, false);
  assert.deepEqual(
    calls.delete.map((call) => new URL(call.url).pathname),
    ["/api/v3/movie/11", "/api/v3/movie/12"],
  );
  assert.ok(calls.delete.every((call) => new URL(call.url).searchParams.get("addImportExclusion") === "false"));
  assert.equal(calls.jellyfinRefresh.length, 1);
});

test("a partial collection deletion still refreshes Jellyfin", async () => {
  let deleteCount = 0;
  const { actions, calls } = setup({
    responses: {
      "Radarr:collection/4": {
        id: 4,
        monitored: true,
        movies: [{ tmdbId: 1 }, { tmdbId: 2 }, { tmdbId: 3 }],
      },
      "Radarr:movie": [
        { id: 11, tmdbId: 1, title: "First" },
        { id: 12, tmdbId: 2, title: "Second" },
        { id: 13, tmdbId: 3, title: "Third" },
      ],
    },
    deleteEndpoint: async () => {
      deleteCount += 1;
      if (deleteCount === 2) throw new Error("Radarr deletion failed");
    },
  });

  const result = await actions.deleteCollection(4);
  assert.equal(deleteCount, 2);
  assert.equal(result.deletedMovies, 1);
  assert.equal(result.totalMovies, 3);
  assert.deepEqual(result.failure, {
    id: 12,
    title: "Second",
    message: "Radarr deletion failed",
  });
  assert.equal(calls.jellyfinRefresh.length, 1);
});

test("a partial season deletion still refreshes Jellyfin", async () => {
  let deleteCount = 0;
  const { actions, calls } = setup({
    responses: {
      "Sonarr:series/5": {
        id: 5,
        seasons: [{ seasonNumber: 1, monitored: true }],
      },
      "Sonarr:episode?seriesId=5&includeEpisodeFile=true": [
        { seasonNumber: 1, episodeFileId: 10 },
        { seasonNumber: 1, episodeFileId: 11 },
      ],
    },
    deleteEndpoint: async () => {
      deleteCount += 1;
      if (deleteCount === 2) throw new Error("Sonarr deletion failed");
    },
  });

  await assert.rejects(actions.removeSeason(5, 1), error => {
    assert.match(error.message, /1 of 2 episode files confirmed deleted/);
    assert.equal(error.partialResult.monitored, false);
    assert.equal(error.partialResult.deletedFiles, 1);
    assert.equal(error.partialResult.failedFileId, 11);
    return true;
  });
  assert.equal(deleteCount, 2);
  assert.equal(calls.jellyfinRefresh.length, 1);
});

test("monitoring a season also monitors its parent series and starts a season search", async () => {
  const { actions, calls } = setup({
    responses: {
      "Sonarr:series/9": {
        id: 9,
        monitored: false,
        seasons: [{ seasonNumber: 2, monitored: false }],
      },
    },
  });
  await actions.setSeasonMonitoring(9, 2, true);

  assert.equal(calls.send[0].body.monitored, true);
  assert.equal(calls.send[0].body.seasons[0].monitored, true);
  assert.deepEqual(calls.send[1], {
    service: "Sonarr",
    endpoint: "command",
    method: "POST",
    body: { name: "SeasonSearch", seriesId: 9, seasonNumber: 2 },
  });
});

test("monitoring a collection enables search on add and queues a refresh for that collection", async () => {
  const { actions, calls } = setup({
    responses: { "Radarr:collection/6": { id: 6, monitored: false, searchOnAdd: false, qualityProfileId: 3, rootFolderPath: "/movies" } },
  });
  const result = await actions.setCollectionMonitoring(6, true);
  assert.equal(calls.send[0].endpoint, "collection/6");
  assert.equal(calls.send[0].body.monitored, true);
  assert.equal(calls.send[0].body.searchOnAdd, true);
  assert.equal(calls.send[0].body.qualityProfileId, 3);
  assert.equal(calls.send[0].body.rootFolderPath, "/movies");
  assert.deepEqual(calls.send[1], {
    service: "Radarr",
    endpoint: "command",
    method: "POST",
    body: { name: "RefreshCollections", collectionIds: [6] },
  });
  assert.equal(calls.send.length, 2);
  assert.deepEqual(result, calls.send[0].body);
});

test("unmonitoring a collection preserves search settings and does not queue a refresh", async () => {
  const { actions, calls } = setup({
    responses: { "Radarr:collection/6": { id: 6, monitored: true, searchOnAdd: false } },
  });
  await actions.setCollectionMonitoring(6, false);
  assert.equal(calls.send[0].endpoint, "collection/6");
  assert.equal(calls.send[0].body.monitored, false);
  assert.equal(calls.send[0].body.searchOnAdd, false);
  assert.equal(calls.send.length, 1);
});

test("invalid identifiers are rejected before calling a service", async () => {
  const { actions, calls } = setup();
  await assert.rejects(actions.deleteFromService("radarr", 0), { message: "Invalid library item", status: 400 });
  await assert.rejects(actions.removeSeason(1, -1), { message: "Invalid season", status: 400 });
  assert.deepEqual(calls, { fetch: [], send: [], delete: [], jellyfinRefresh: [] });
});

test("concurrent actions from separate requests preserve both season updates", async () => {
  let persisted = { id: 1, monitored: true, seasons: [{ seasonNumber: 1, monitored: false }, { seasonNumber: 2, monitored: false }] };
  const makeActions = () => createLibraryActions({
    getService: () => ({ url: "http://concurrent-sonarr" }),
    fetchJson: async () => { const snapshot = structuredClone(persisted); await new Promise(resolve => setImmediate(resolve)); return snapshot; },
    sendJson: async (_service, endpoint, _method, body) => { if (endpoint === "series/1") persisted = structuredClone(body); return body; },
  });
  await Promise.all([makeActions().setSeasonMonitoring(1, 1, true), makeActions().setSeasonMonitoring("1", 2, true)]);
  assert.ok(persisted.seasons.every(season => season.monitored));
});

test("a failed series action does not block later actions on the same series", async () => {
  let fetches = 0;
  const actions = createLibraryActions({
    getService: () => ({ url: "http://recovering-sonarr" }),
    fetchJson: async () => { if (++fetches === 1) throw new Error("offline"); return { id: 1, monitored: false }; },
    sendJson: async (_service, _endpoint, _method, body) => body,
  });
  const results = await Promise.allSettled([actions.setSeriesMonitoring(1, true), actions.setSeriesMonitoring(1, true)]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].value.monitored, true);
});

test("season monitoring remains confirmed when search submission fails", async () => {
  const actions = createLibraryActions({
    getService: () => ({ url: "http://partial-sonarr" }),
    fetchJson: async () => ({ id: 1, seasons: [{ seasonNumber: 1, monitored: false }] }),
    sendJson: async (_service, endpoint, _method, body) => {
      if (endpoint === "command") throw new Error("search unavailable");
      return body;
    },
  });
  await assert.rejects(actions.setSeasonMonitoring(1, 1, true), error => {
    assert.equal(error.partialResult.monitored, true);
    assert.equal(error.partialResult.commandConfirmed, false);
    assert.match(error.message, /monitoring was enabled/);
    return true;
  });
});

test("movie deletion failures report the collection that was already unmonitored", async () => {
  const { actions, calls } = setup({
    responses: {
      "Radarr:movie/8": { id: 8, tmdbId: 80 },
      "Radarr:collection": [{ id: 3, monitored: true, movies: [{ tmdbId: 80 }] }],
    },
    deleteEndpoint: async () => { throw new Error("deletion rejected"); },
  });
  await assert.rejects(actions.unmonitorCollectionAndDeleteMovie(8), error => {
    assert.equal(error.partialResult.collectionId, 3);
    assert.equal(error.partialResult.unmonitoredCollection, true);
    assert.equal(error.partialResult.deletionConfirmed, false);
    return true;
  });
  assert.equal(calls.jellyfinRefresh.length, 1);
});
