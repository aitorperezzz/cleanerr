import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBytes,
  formatDate,
  normalizeSearchValue,
  normalizeTitle,
  sortCollectionItems,
  sortMediaItems,
} from "../public/library-utils.js";

test("formats byte sizes with binary units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1610612736), "1.5 GB");
});

test("normalizes search accents and title articles", () => {
  assert.equal(normalizeSearchValue("Amélie"), "amelie");
  assert.equal(normalizeTitle("The Wire"), "wire");
  assert.equal(normalizeTitle("A Quiet Place"), "quiet place");
});

test("sorts media without mutating the source array", () => {
  const items = [
    { title: "Zulu", year: 2000, sizeOnDisk: 20 },
    { title: "The Alpha", year: 2001, sizeOnDisk: 10 },
  ];
  assert.deepEqual(sortMediaItems(items, "name").map((item) => item.title), ["The Alpha", "Zulu"]);
  assert.deepEqual(sortMediaItems(items, "size").map((item) => item.title), ["Zulu", "The Alpha"]);
  assert.equal(items[0].title, "Zulu");
});

test("sorts collections by size or normalized name", () => {
  const collections = [
    { title: "The Saga", sizeOnDisk: 5 },
    { title: "Alien", sizeOnDisk: 10 },
  ];
  assert.deepEqual(sortCollectionItems(collections, "name").map((item) => item.title), ["Alien", "The Saga"]);
  assert.deepEqual(sortCollectionItems(collections, "size").map((item) => item.title), ["Alien", "The Saga"]);
});

test("formats recent dates relative to a supplied clock", () => {
  const now = Date.parse("2026-09-19T12:00:00Z");
  assert.equal(formatDate("2026-09-19T11:59:40Z", now), "Just now");
  assert.equal(formatDate("2026-09-19T11:55:00Z", now), "5 minutes ago");
});
