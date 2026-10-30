import type { LogRecord } from "../common/power-logs";

export function withLogContext<T extends LogRecord>(
  records: readonly T[],
  matches: ReadonlySet<T>,
  radius: number,
): T[] {
  const distance = Number.isFinite(radius) && radius > 0 ? Math.floor(radius) : 0;
  if (distance === 0 || matches.size === 0) return records.filter((record) => matches.has(record));
  const included = new Set<T>();
  const sourceKeys = records.map((record) =>
    JSON.stringify([record.podUid, record.pod, record.container, Boolean(record.previous)]),
  );
  const remaining = new Map<string, number>();

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const source = sourceKeys[index];
    if (matches.has(record)) {
      included.add(record);
      remaining.set(source, distance);
    } else {
      const count = remaining.get(source) ?? 0;
      if (count > 0) {
        included.add(record);
        remaining.set(source, count - 1);
      }
    }
  }

  remaining.clear();
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    const source = sourceKeys[index];
    if (matches.has(record)) {
      remaining.set(source, distance);
    } else {
      const count = remaining.get(source) ?? 0;
      if (count > 0) {
        included.add(record);
        remaining.set(source, count - 1);
      }
    }
  }

  return records.filter((record) => included.has(record));
}
