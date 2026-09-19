const sizeFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${sizeFormatter.format(bytes / 1024 ** exponent)} ${units[exponent]}`;
}

export function formatDate(isoDate, now = Date.now()) {
  const date = new Date(isoDate);
  const elapsedSeconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  const relativeFormatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

  if (elapsedSeconds < 45) return "Just now";
  if (elapsedSeconds < 3600) {
    return relativeFormatter.format(-Math.round(elapsedSeconds / 60), "minute");
  }
  if (elapsedSeconds < 86400) {
    return relativeFormatter.format(-Math.round(elapsedSeconds / 3600), "hour");
  }
  if (elapsedSeconds < 604800) {
    return relativeFormatter.format(-Math.round(elapsedSeconds / 86400), "day");
  }
  return new Intl.DateTimeFormat("en-US", { dateStyle: "short" }).format(date);
}

export function normalizeTitle(title) {
  return String(title || "")
    .toLocaleLowerCase("en-US")
    .replace(/^(the|a|an)\s+/, "")
    .trim();
}

export function normalizeSearchValue(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US");
}

export function sortMediaItems(items, sort = "size") {
  return [...items].sort((a, b) => {
    if (sort === "name") {
      const titleCompare = normalizeTitle(a.title).localeCompare(normalizeTitle(b.title), "en-US");
      return titleCompare || (a.year || 0) - (b.year || 0);
    }
    return b.sizeOnDisk - a.sizeOnDisk
      || normalizeTitle(a.title).localeCompare(normalizeTitle(b.title), "en-US");
  });
}

export function sortCollectionItems(collections, sort = "size") {
  return [...collections].sort((a, b) => {
    if (sort === "name") {
      return normalizeTitle(a.title).localeCompare(normalizeTitle(b.title), "en-US");
    }
    return b.sizeOnDisk - a.sizeOnDisk
      || normalizeTitle(a.title).localeCompare(normalizeTitle(b.title), "en-US");
  });
}
