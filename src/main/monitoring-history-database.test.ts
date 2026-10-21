import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectHistorySamples } from "../common/monitoring-history";
import { MonitoringHistoryDatabase } from "./monitoring-history-database";
import { MonitoringHistoryWorker } from "./monitoring-history-worker";

const directories: string[] = [];
function path() {
  const directory = mkdtempSync(join(tmpdir(), "power-history-"));
  directories.push(directory);
  return join(directory, "history.sqlite");
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const identity = { clusterId: "cluster-id", scope: "pod" as const, uid: "pod-uid" };
describe("local numeric monitoring history", () => {
  it("projects numeric fields without retaining arbitrary API objects", () => {
    const now = Date.now();
    expect(
      projectHistorySamples(
        [{ ...identity, time: now, values: { cpu: 2, token: "private" }, spec: { private: "payload" } }],
        now,
      ),
    ).toEqual([{ ...identity, time: now, values: { cpu: 2 } }]);
    for (const cpu of [NaN, Infinity, -1, "12"])
      expect(() => projectHistorySamples([{ ...identity, time: now, values: { cpu } }], now)).toThrow();
  });
  it("persists rollup extrema and weighted averages while separating pod UIDs", () => {
    const file = path();
    const now = Math.floor(Date.now() / 1_800_000) * 1_800_000;
    let db = new MonitoringHistoryDatabase(file);
    const time = now - 10_800_000;
    db.append(
      [
        { ...identity, time, values: { cpu: 2 } },
        { ...identity, time: time + 30_000, values: { cpu: 8 } },
        { ...identity, uid: "replacement-uid", time, values: { cpu: 100 } },
      ],
      now,
    );
    db.close();
    db = new MonitoringHistoryDatabase(file);
    expect(db.query({ ...identity, from: time, to: now }, now)).toEqual([
      expect.objectContaining({ resolution: 300_000, min: 2, max: 8, avg: 5, count: 2, gap: true }),
    ]);
    expect(readFileSync(file).includes(Buffer.from("payload"))).toBe(false);
    db.clear();
    expect(db.status().samples).toBe(0);
    db.close();
  });
  it("expires old data and bounds physical storage", () => {
    const now = Date.now();
    const db = new MonitoringHistoryDatabase(path(), 96 * 1024);
    db.append(
      Array.from({ length: 512 }, (_, i) => ({
        ...identity,
        uid: `uid-${i}`,
        time: now - (511 - i) * 30_000,
        values: { cpu: i, memory: i },
      })),
      now,
    );
    expect(db.bytes()).toBeLessThanOrEqual(96 * 1024);
    expect(db.query({ ...identity, uid: "uid-511", from: now - 30_000, to: now }, now)).toEqual(
      expect.arrayContaining([expect.objectContaining({ metric: "cpu", avg: 511 })]),
    );
    expect(db.query({ ...identity, uid: "uid-0", from: now - 512 * 30_000, to: now }, now)).toEqual([]);
    db.prune(now + 604_800_001);
    expect(db.status().samples).toBe(0);
    db.close();
  });
  it("preserves source timestamps in raw buckets at query boundaries", () => {
    const db = new MonitoringHistoryDatabase(path());
    const now = Date.now();
    const time = Math.floor(now / 30_000) * 30_000 + 1234;
    db.append([{ ...identity, time, values: { cpu: 3 } }], now);
    expect(db.query({ ...identity, from: time, to: time }, now)).toEqual([
      expect.objectContaining({ time, resolution: 30_000 }),
    ]);
    expect(db.query({ ...identity, from: time + 1, to: time + 500 }, now)).toEqual([]);
    db.close();
  });
  it("runs the serialized SQLite engine in a worker", async () => {
    const worker = new MonitoringHistoryWorker(path());
    try {
      const now = Date.now();
      await worker.call("append", [{ ...identity, time: now, values: { cpu: 3 } }]);
      expect(await worker.call("query", { ...identity, from: now - 30_000, to: now })).toEqual([
        expect.objectContaining({ avg: 3 }),
      ]);
      await worker.call("clear");
      expect(await worker.call("status")).toEqual(expect.objectContaining({ samples: 0 }));
    } finally {
      worker.close();
    }
  });
});
