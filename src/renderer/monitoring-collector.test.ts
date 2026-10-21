// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cluster: "cluster-a",
  metrics: vi.fn(),
  nodes: vi.fn(),
  pods: vi.fn(),
  podMetrics: vi.fn(),
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.cluster } }) } },
    K8sApi: {
      nodesMetricsApi: { list: state.metrics },
      nodesApi: { list: state.nodes },
      podsApi: { list: state.pods },
      podsMetricsApi: { list: state.podMetrics },
    },
  },
}));
vi.mock("../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => ({ enabled: true }) },
}));

import {
  getCollectedPodUsage,
  getMonitoringSnapshot,
  getNodeSample,
  resetMonitoringCollector,
} from "./monitoring-collector";

beforeEach(() => {
  vi.useFakeTimers();
  state.cluster = "cluster-a";
  state.metrics.mockReset().mockResolvedValue([]);
  state.nodes.mockReset().mockResolvedValue([]);
  state.pods.mockReset().mockResolvedValue([]);
  state.podMetrics.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  resetMonitoringCollector();
  vi.useRealTimers();
});

it("coalesces simultaneous views and reuses a snapshot for one sampling interval", async () => {
  const values = await Promise.all([getMonitoringSnapshot(), getMonitoringSnapshot(), getMonitoringSnapshot()]);
  expect(values[0]).toBe(values[1]);
  await getMonitoringSnapshot();
  for (const api of [state.metrics, state.nodes, state.pods, state.podMetrics]) expect(api).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_001);
  await getMonitoringSnapshot();
  expect(state.metrics).toHaveBeenCalledTimes(2);
});

it("starts collection for a new cluster while the old request is pending and rejects its result", async () => {
  let finish!: (value: unknown[]) => void;
  state.metrics.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = getMonitoringSnapshot();
  const rejected = expect(old).rejects.toThrow("Cluster changed");
  await Promise.resolve();
  state.cluster = "cluster-b";
  const next = await getMonitoringSnapshot();
  expect(next.clusterId).toBe("cluster-b");
  finish([]);
  await rejected;
  expect((await getMonitoringSnapshot()).clusterId).toBe("cluster-b");
  expect(state.metrics).toHaveBeenCalledTimes(2);
});

it("preserves partial permissions and cancelled inventory as unavailable instead of empty", async () => {
  state.nodes.mockResolvedValue(null);
  state.pods.mockRejectedValue(new Error("Forbidden"));
  const data = await getMonitoringSnapshot();
  expect(data.nodes).toBeUndefined();
  expect(data.pods).toBeUndefined();
  expect(data.errors).toEqual(["Nodes unavailable or access denied", "Pods unavailable or access denied"]);
});

it("rejects stale or recreated pod usage, duplicate container metrics and ambiguous identities", async () => {
  const pod = {
    metadata: {
      uid: "pod-uid",
      name: "worker",
      namespace: "default",
      creationTimestamp: new Date(Date.now() - 1000).toISOString(),
    },
  };
  const usage = {
    metadata: { name: "worker", namespace: "default" },
    timestamp: new Date().toISOString(),
    containers: [{ name: "app", usage: { cpu: "100m", memory: "1Mi" } }],
  };
  state.pods.mockResolvedValue([pod]);
  state.podMetrics.mockResolvedValue([usage]);
  const data = await getMonitoringSnapshot();
  expect(getCollectedPodUsage(data)).toEqual([{ uid: "pod-uid", cpu: 0.1, memory: 1024 ** 2 }]);
  expect(
    getCollectedPodUsage({
      ...data,
      podMetrics: [{ ...usage, metadata: { ...usage.metadata, uid: "replaced" } }] as never,
    }),
  ).toEqual([]);
  expect(
    getCollectedPodUsage({
      ...data,
      podMetrics: [{ ...usage, containers: [usage.containers[0], usage.containers[0]] }] as never,
    }),
  ).toEqual([]);
  expect(getCollectedPodUsage({ ...data, podMetrics: [usage, usage] as never })).toEqual([]);
  await vi.advanceTimersByTimeAsync(121_000);
  expect(getCollectedPodUsage(data)).toEqual([]);
});

it("keeps node usage when resource inventory is incomplete and uses the source timestamp", async () => {
  const time = Date.now() - 5000;
  state.nodes.mockResolvedValue([{ metadata: { uid: "node-uid", name: "worker" }, status: {} }]);
  state.metrics.mockResolvedValue([
    { metadata: { name: "worker" }, timestamp: new Date(time).toISOString(), usage: { cpu: "1", memory: "1Gi" } },
  ]);
  const data = await getMonitoringSnapshot();
  expect(getNodeSample(data, "worker", "node-uid")).toMatchObject({
    cpu: 1,
    time,
    resourceStatus: expect.stringContaining("incomplete"),
  });
  expect(getNodeSample(data, "worker", "replaced")).toBeUndefined();
});
