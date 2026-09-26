export async function requestJellyfinLibraryRefresh(
  jellyfin,
  { fetchImpl = fetch, timeoutMs = 10000 } = {},
) {
  if (!jellyfin?.url || !jellyfin.apiKey) return false;

  const response = await fetchImpl(`${jellyfin.url}/Library/Refresh`, {
    method: "POST",
    headers: {
      Authorization: `MediaBrowser Client="Cleanerr", Device="Cleanerr", DeviceId="cleanerr", Version="0.1.0", Token="${jellyfin.apiKey}"`,
      "X-Emby-Token": jellyfin.apiKey,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Jellyfin responded ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  return true;
}

export function createJellyfinRefreshScheduler(
  refreshLibrary,
  { delayMs = 750, onError = () => {} } = {},
) {
  let timer = null;

  return function scheduleJellyfinRefresh() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try {
        await refreshLibrary();
      } catch (error) {
        onError(error);
      }
    }, delayMs);
    timer.unref?.();
  };
}
