import assert from "node:assert/strict";
import test from "node:test";
import { requireLibraryRevision } from "../server/request-guards.js";

test("actions require the configuration revision used to load the library", () => {
  for (const revision of [undefined, "old-instance"]) {
    assert.throws(() => requireLibraryRevision({ headers: { "x-cleanerr-library-revision": revision } }, "new-instance"), { status: 409 });
  }
  assert.doesNotThrow(() => requireLibraryRevision({ headers: { "x-cleanerr-library-revision": "new-instance" } }, "new-instance"));
});
