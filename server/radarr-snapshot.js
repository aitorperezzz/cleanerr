export function createRadarrSnapshot({ getService, fetchJson, graceMs = 250 }) {
  let snapshot = null;

  function invalidate() {
    snapshot = null;
  }

  function get() {
    const now = Date.now();
    if (snapshot && (!snapshot.settled || snapshot.expiresAt > now)) return snapshot.promise;

    const radarr = getService();
    const promise = Promise.all([
      fetchJson(radarr, "movie"),
      fetchJson(radarr, "collection"),
    ]).then(([movies, collections]) => ({ movies, collections }));
    const current = { promise, settled: false, expiresAt: 0 };
    snapshot = current;
    promise.then(
      () => {
        current.settled = true;
        current.expiresAt = Date.now() + graceMs;
      },
      () => {
        if (snapshot === current) invalidate();
      },
    );
    return promise;
  }

  return { get, invalidate };
}
