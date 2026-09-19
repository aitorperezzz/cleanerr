import assert from "node:assert/strict";
import test from "node:test";
import { createLibraryActions } from "../library-actions.js";

function setup({ responses = {} } = {}) {
  const services = {
    radarr: { label: "Radarr", url: "http://radarr:7878" },
    sonarr: { label: "Sonarr", url: "http://sonarr:8989" },
  };
  const calls = { fetch: [], send: [], delete: [] };
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
    deleteEndpoint: async (service, url) => {
      calls.delete.push({ service: service.label, url: String(url) });
    },
  });
  return { actions, calls };
}

test("movie deletion removes files and adds a Radarr import exclusion", async () => {
  const { actions, calls } = setup();
  const result = await actions.deleteFromService("radarr", "42");

  assert.deepEqual(result, { source: "Radarr", id: 42 });
  assert.equal(calls.delete.length, 1);
  const url = new URL(calls.delete[0].url);
  assert.equal(url.pathname, "/api/v3/movie/42");
  assert.equal(url.searchParams.get("deleteFiles"), "true");
  assert.equal(url.searchParams.get("addImportExclusion"), "true");
});

test("series deletion uses the Sonarr import-list exclusion", async () => {
  const { actions, calls } = setup();
  await actions.deleteFromService("sonarr", 7);
  const url = new URL(calls.delete[0].url);
  assert.equal(url.pathname, "/api/v3/series/7");
  assert.equal(url.searchParams.get("deleteFiles"), "true");
  assert.equal(url.searchParams.get("addImportListExclusion"), "true");
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
});

test("deleting a collection only deletes movies belonging to it", async () => {
  const { actions, calls } = setup({
    responses: {
      "Radarr:collection/4": {
        id: 4,
        monitored: true,
        movies: [{ tmdbId: 1 }, { tmdbId: 2 }],
      },
      "Radarr:movie": [
        { id: 11, tmdbId: 1 },
        { id: 12, tmdbId: 2 },
        { id: 13, tmdbId: 3 },
      ],
    },
  });
  const result = await actions.deleteCollection(4);

  assert.equal(result.deletedMovies, 2);
  assert.equal(calls.send[0].body.monitored, false);
  assert.deepEqual(
    calls.delete.map((call) => new URL(call.url).pathname),
    ["/api/v3/movie/11", "/api/v3/movie/12"],
  );
});

test("monitoring a season also monitors its parent series", async () => {
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
});

test("monitoring and unmonitoring collections updates the requested state", async () => {
  const { actions, calls } = setup({
    responses: { "Radarr:collection/6": { id: 6, monitored: false } },
  });
  await actions.setCollectionMonitoring(6, true);
  assert.equal(calls.send[0].endpoint, "collection/6");
  assert.equal(calls.send[0].body.monitored, true);
});

test("invalid identifiers are rejected before calling a service", async () => {
  const { actions, calls } = setup();
  await assert.rejects(actions.deleteFromService("radarr", 0), { message: "Invalid library item", status: 400 });
  await assert.rejects(actions.removeSeason(1, -1), { message: "Invalid season", status: 400 });
  assert.deepEqual(calls, { fetch: [], send: [], delete: [] });
});
