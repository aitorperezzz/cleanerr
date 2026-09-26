export function groupStorageDisks(disks, serviceName, source) {
  const groups = new Map();

  for (const disk of disks || []) {
    const freeSpace = Number(disk.freeSpace) || 0;
    const totalSpace = Number(disk.totalSpace) || 0;
    const key = totalSpace > 0
      ? `${disk.label || ""}:${totalSpace}`
      : `path:${disk.path}`;
    let group = groups.get(key);

    if (!group) {
      group = { service: serviceName, source, paths: [], freeSpace, totalSpace };
      groups.set(key, group);
    } else {
      group.freeSpace = Math.min(group.freeSpace, freeSpace);
    }

    if (disk.path && !group.paths.includes(disk.path)) group.paths.push(disk.path);
  }

  return [...groups.values()];
}
