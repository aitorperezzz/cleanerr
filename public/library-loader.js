// Keep each successful response even when the other service endpoint fails.
export async function loadLibrarySnapshot({ fetchImpl = fetch, readResponse = response => response.json() } = {}) {
  const refresh = Date.now();
  const paths = [`/api/library?refresh=${refresh}`, `/api/collections?refresh=${refresh}`];
  const results = await Promise.allSettled(paths.map(async path => {
    const response = await fetchImpl(path, { cache: "no-store" });
    const data = await readResponse(response);
    if (!response.ok) throw new Error(data.error || `Could not load ${path.split("?")[0]}`);
    if (!data.configurationRevision) throw new Error("Restart Cleanerr and refresh to load the current server version.");
    return data;
  }));
  const available = results.filter(result => result.status === "fulfilled").map(result => result.value);
  if (!available.length) throw new Error(results.map(result => result.reason.message).join(" · "));
  if (available.some(data => data.configurationRevision !== available[0].configurationRevision)) {
    throw new Error("Service settings changed while loading. Refresh the library.");
  }
  const library = results[0].status === "fulfilled" ? results[0].value : {};
  const collections = results[1].status === "fulfilled" ? results[1].value : {};
  const errors = results.flatMap((result, index) => result.status === "fulfilled"
    ? result.value.errors || []
    : [{ source: index === 0 ? "Library" : "Collections", message: result.reason.message }]);
  return {
    configurationRevision: available[0].configurationRevision,
    items: library.items || [],
    collections: collections.collections || [],
    updatedAt: library.updatedAt || collections.updatedAt,
    errors,
  };
}
