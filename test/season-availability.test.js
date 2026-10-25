import assert from "node:assert/strict";
import test from "node:test";
import { getSeasonAvailability } from "../season-availability.js";

const now = Date.parse("2026-10-25T12:00:00Z");
function episodes({ downloaded, aired, total = 10, monitored = true }) {
  return Array.from({ length: total }, (_, i) => ({
    seasonNumber: 1, monitored, hasFile: i < downloaded,
    airDateUtc: i < aired ? "2026-10-24T12:00:00Z" : "2026-10-26T12:00:00Z",
  }));
}

test("6/10 is up to date when the four missing episodes have not aired", () => {
  const [season] = getSeasonAvailability(episodes({ downloaded: 6, aired: 6 }), now);
  assert.equal(season.state, "up-to-date");
  assert.equal(season.missingEpisodeCount, 0);
});

test("missing aired episodes are red regardless of monitoring", () => {
  for (const monitored of [true, false]) {
    const [season] = getSeasonAvailability(episodes({ downloaded: 0, aired: 10, monitored }), now);
    assert.equal(season.state, "missing");
    assert.equal(season.missingEpisodeCount, 10);
  }
});

test("partially downloaded seasons are missing if even one aired episode lacks a file", () => {
  const [season] = getSeasonAvailability(episodes({ downloaded: 6, aired: 7 }), now);
  assert.equal(season.state, "missing");
  assert.equal(season.missingEpisodeCount, 1);
});

test("a future season with no files is up to date", () => {
  assert.equal(getSeasonAvailability(episodes({ downloaded: 0, aired: 0 }), now)[0].state, "up-to-date");
});

test("unknown dates are reported without counting unaired episodes as missing", () => {
  const [season] = getSeasonAvailability([{ seasonNumber: 1, hasFile: false, airDateUtc: null }], now);
  assert.equal(season.state, "up-to-date");
  assert.equal(season.unknownDateCount, 1);
});

test("multiple episodes in a single file count as downloaded episodes and seasons stay separate", () => {
  const seasons = getSeasonAvailability([
    { seasonNumber: 0, episodeFileId: 12 },
    { seasonNumber: 1, episodeFileId: 42, airDateUtc: "2026-10-24T12:00:00Z" },
    { seasonNumber: 1, episodeFileId: 42, airDateUtc: "2026-10-24T12:00:00Z" },
  ], now);
  assert.equal(seasons[0].state, "up-to-date");
  assert.equal(seasons[1].episodeFileCount, 2);
  assert.equal(seasons[1].state, "up-to-date");
});
