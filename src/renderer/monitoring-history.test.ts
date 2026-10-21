import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  trackedHistory: [] as unknown[],
  enabled: true,
  historyEnabled: true,
  listener: undefined as undefined | ((data: any) => void),
}));
vi.mock("electron", () => ({ ipcRenderer: { invoke: vi.fn() } }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Catalog: { activeCluster: { get: () => ({ metadata: { uid: "cluster-id" } }) } } },
}));
vi.mock("../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => state },
}));
vi.mock("./monitoring-collector", () => ({
  getCollectedPodUsage: () => [],
  getNodeSample: () => undefined,
  onMonitoringSnapshot: (listener: any) => {
    state.listener = listener;
    return () => {
      state.listener = undefined;
    };
  },
}));

import { monitoringHistory } from "./monitoring-history";
import {
  historySnapshotSamples,
  isHistoryTracked,
  setHistoryTracked,
  startMonitoringHistoryCollection,
} from "./monitoring-history-collection";
import { mergeHistorySamples } from "./monitoring-history-view";

describe("numeric history collection and presentation", () => {
  it("keeps valid cluster usage when capacity or pod request data is incomplete", () => {
    const time = Date.now() - 5000;
    const data: any = {
      clusterId: "cluster-id",
      time: Date.now(),
      errors: [],
      nodes: [{ metadata: { name: "worker", uid: "node-uid" }, status: {} }],
      nodeMetrics: [
        { metadata: { name: "worker" }, timestamp: new Date(time).toISOString(), usage: { cpu: "1", memory: "1Mi" } },
      ],
    };
    expect(historySnapshotSamples(data, [])).toEqual([
      { clusterId: "cluster-id", scope: "cluster", uid: "cluster-id", time, values: { cpu: 1, memory: 1024 ** 2 } },
    ]);
  });
  it("tracks bounded UID identities without retaining extra object fields", () => {
    state.trackedHistory = [];
    const identity = { clusterId: "cluster-id", scope: "pod" as const, uid: "pod-uid", secret: "discard" };
    setHistoryTracked(identity, true);
    expect(state.trackedHistory).toEqual([{ clusterId: "cluster-id", scope: "pod", uid: "pod-uid" }]);
    expect(isHistoryTracked(identity)).toBe(true);
    expect(isHistoryTracked({ ...identity, uid: "replacement-uid" })).toBe(false);
    setHistoryTracked(identity, false);
    expect(state.trackedHistory).toEqual([]);
    for (let i = 0; i < 120; i++) setHistoryTracked({ ...identity, uid: `pod-${i}` }, true);
    expect(state.trackedHistory).toHaveLength(100);
  });
  it("uses the actual metrics timestamp and leaves stale metrics gaps", () => {
    const time = Date.now() - 10_000;
    const data: any = {
      clusterId: "cluster-id",
      time: Date.now(),
      errors: [],
      nodeMetrics: [{ timestamp: new Date(time).toISOString(), usage: { cpu: "1", memory: "1Mi" } }],
    };
    expect(historySnapshotSamples(data, [])).toEqual([
      { clusterId: "cluster-id", scope: "cluster", uid: "cluster-id", time, values: { cpu: 1, memory: 1024 * 1024 } },
    ]);
    data.nodeMetrics[0].timestamp = new Date(Date.now() - 180_000).toISOString();
    expect(historySnapshotSamples(data, [])).toEqual([]);
  });
  it("merges live samples over historical buckets without drawing missing metrics as zeros", () => {
    const base = { time: 0, resolution: 30_000, min: 1, max: 4, avg: 2, count: 2, gap: false };
    const points: any = [
      { ...base, metric: "cpu" },
      { ...base, metric: "memory" },
      { ...base, time: 30_000, metric: "cpu" },
    ];
    expect(mergeHistorySamples(points, [{ time: 10_000, cpu: 3, memory: 4 }], 0)).toEqual([
      { time: 10_000, cpu: 3, memory: 4 },
    ]);
  });
  it("preserves historical extrema and breaks only actual gaps at each resolution", () => {
    const point = { resolution: 300_000, min: 1, max: 9, avg: 4, count: 10, gap: false };
    const points: any = [0, 300_000, 900_000].flatMap((time) =>
      ["cpu", "memory"].map((metric) => ({ ...point, time, metric })),
    );
    const merged = mergeHistorySamples(points, [], 0);
    expect(merged[0].historical?.cpu).toEqual({ min: 1, max: 9, count: 10, resolution: 300_000, gap: false });
    expect(merged[1].breakBefore).toBeUndefined();
    expect(merged[2].breakBefore).toBe(true);
    points[2].gap = true;
    expect(mergeHistorySamples(points, [], 0)[1].breakBefore).toBe(true);
  });
  it("retries failed writes and deduplicates only successful writes", async () => {
    vi.stubGlobal("document", { visibilityState: "visible" });
    const append = vi
      .spyOn(monitoringHistory, "append")
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValue(true);
    const dispose = startMonitoringHistoryCollection();
    const time = Date.now() - 10_000;
    const data: any = {
      clusterId: "cluster-id",
      time: Date.now(),
      errors: [],
      nodeMetrics: [{ timestamp: new Date(time).toISOString(), usage: { cpu: "1", memory: "1Mi" } }],
    };
    try {
      state.listener?.(data);
      await new Promise((resolve) => setTimeout(resolve, 0));
      state.listener?.(data);
      await new Promise((resolve) => setTimeout(resolve, 0));
      state.listener?.(data);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(append).toHaveBeenCalledTimes(2);
    } finally {
      dispose();
      append.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
