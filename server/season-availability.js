// Count missing aired episodes independently of their monitoring flags.
export function getSeasonAvailability(episodes, now = Date.now()) {
  const seasons = new Map();
  for (const episode of episodes) {
    const number = episode.seasonNumber;
    if (!Number.isInteger(number) || number < 0) continue;
    if (!seasons.has(number)) seasons.set(number, {
      seasonNumber: number, totalEpisodeCount: 0, episodeFileCount: 0,
      airedEpisodeCount: 0, missingEpisodeCount: 0, unknownDateCount: 0,
    });
    const season = seasons.get(number);
    const hasFile = episode.hasFile === true || Number(episode.episodeFileId) > 0;
    const airTime = typeof episode.airDateUtc === "string" ? Date.parse(episode.airDateUtc) : NaN;
    const aired = Number.isFinite(airTime) && airTime <= now;
    season.totalEpisodeCount += 1;
    if (hasFile) season.episodeFileCount += 1;
    if (aired) season.airedEpisodeCount += 1;
    if (aired && !hasFile) season.missingEpisodeCount += 1;
    if (!hasFile && !Number.isFinite(airTime)) season.unknownDateCount += 1;
  }
  return [...seasons.values()].map(season => ({
    ...season,
    state: season.missingEpisodeCount > 0 ? "missing" : "up-to-date",
  }));
}
