import type { TimelineEntry } from "./resource-diagnostics";

export interface TimelineGroup {
  key: string;
  latest: TimelineEntry;
  entries: TimelineEntry[];
  affected: string[];
  count: number;
}

export function groupTimelineEntries(
  entries: TimelineEntry[],
  identity: (entry: TimelineEntry) => string,
  resource: (entry: TimelineEntry) => string,
): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.reason, identity(entry), entry.message.trim().replace(/\s+/g, " ")]);
    let group = groups.get(key);
    if (!group) {
      group = { key, latest: entry, entries: [], affected: [], count: 0 };
      groups.set(key, group);
    }
    group.entries.push(entry);
    const name = resource(entry);
    if (!group.affected.includes(name)) group.affected.push(name);
    if ((Date.parse(entry.time ?? "") || 0) > (Date.parse(group.latest.time ?? "") || 0)) group.latest = entry;
  }
  for (const group of groups.values()) {
    // each event identity reports a cumulative count, so repeated snapshots use its maximum
    const counts = new Map<string, number>();
    for (const entry of group.entries) counts.set(entry.id, Math.max(counts.get(entry.id) ?? 0, entry.count));
    group.count = [...counts.values()].reduce((total, count) => total + count, 0);
  }
  return [...groups.values()].sort(
    (a, b) => (Date.parse(b.latest.time ?? "") || 0) - (Date.parse(a.latest.time ?? "") || 0),
  );
}
