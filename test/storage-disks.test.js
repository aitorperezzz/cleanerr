import assert from "node:assert/strict";
import test from "node:test";
import { groupStorageDisks } from "../server/storage-disks.js";

test("groups paths on the same volume despite small free-space differences", () => {
  const disks = [
    { path: "/", label: "", freeSpace: 1000, totalSpace: 2000 },
    { path: "/config", label: "", freeSpace: 992, totalSpace: 2000 },
    { path: "/downloads", label: "", freeSpace: 500, totalSpace: 4000 },
    { path: "/movies", label: "", freeSpace: 496, totalSpace: 4000 },
  ];

  assert.deepEqual(groupStorageDisks(disks, "radarr", "Radarr"), [
    { service: "radarr", source: "Radarr", paths: ["/", "/config"], freeSpace: 992, totalSpace: 2000 },
    { service: "radarr", source: "Radarr", paths: ["/downloads", "/movies"], freeSpace: 496, totalSpace: 4000 },
  ]);
});

test("keeps separately labelled volumes of the same size apart", () => {
  const disks = [
    { path: "/disk-a", label: "A", freeSpace: 1000, totalSpace: 2000 },
    { path: "/disk-b", label: "B", freeSpace: 1000, totalSpace: 2000 },
  ];

  assert.equal(groupStorageDisks(disks, "sonarr", "Sonarr").length, 2);
});
