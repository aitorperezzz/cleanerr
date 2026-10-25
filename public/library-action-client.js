export async function sendLibraryAction(url, options, { configurationRevision, fetchImpl = fetch, readResponse = response => response.json() }) {
  if (!configurationRevision) throw new Error("Refresh the library before performing an action.");
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      headers: { ...options.headers, "X-Cleanerr-Request": "1", "X-Cleanerr-Library-Revision": configurationRevision },
    });
  } catch (cause) {
    throw new Error("Could not confirm whether the action completed. Check Radarr or Sonarr before retrying.", { cause });
  }
  if (!response.ok) {
    const data = await readResponse(response);
    const error = new Error(data.error || "The library action failed.");
    error.partialResult = data.partialResult;
    error.uncertain = Boolean(data.uncertain);
    throw error;
  }
  return response;
}

export async function refreshAfterActionError(error, { reload, render }) {
  let errors;
  try {
    errors = (await reload())?.errors || [];
  } catch (refreshError) {
    errors = [{ source: "Cleanerr", message: `Could not refresh the library: ${refreshError.message}` }];
  }
  render([{ source: error.partialResult?.source || "Cleanerr", message: error.message }, ...errors]);
}
