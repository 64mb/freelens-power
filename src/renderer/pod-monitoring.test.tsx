// @vitest-environment jsdom
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  preferences: {} as { enabled: boolean },
  cluster: "example-cluster",
  metrics: vi.fn(),
  pod: vi.fn(),
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.cluster } }) } },
    K8sApi: { podsMetricsApi: { list: state.metrics }, podsApi: { get: state.pod } },
  },
}));
vi.mock("../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => state.preferences },
}));

import { aggregatePodMetrics, startPodMonitoring } from "./pod-monitoring";

const identity = { name: "worker", namespace: "default" };
const usage = () => ({
  metadata: identity,
  timestamp: new Date().toISOString(),
  containers: [
    { name: "app", usage: { cpu: "250m", memory: "64Mi" } },
    { name: "helper", usage: { cpu: "50m", memory: "32Mi" } },
  ],
});
let stop: (() => void) | undefined;
function selectTab(label: string) {
  for (const item of document.querySelectorAll(".Radio")) item.classList.toggle("checked", item.textContent === label);
}
function drawer() {
  document.body.innerHTML = `<div class="KubeObjectDetails"><div class="drawer-title-text">Pod: worker<span>content_copy</span></div><div class="PodDetails">Pod metadata</div><div class="ResourceMetrics"><div class="switchers">${["CPU", "Memory", "Network", "Filesystem"].map((label) => `<label class="Radio ${label === "CPU" ? "checked" : ""}"><div class="label">${label}</div></label>`).join("")}</div><div class="graph" style="height: 250px; color: red">Native graph</div></div></div>`;
}
beforeEach(() => {
  vi.useFakeTimers();
  state.preferences = observable({ enabled: true });
  state.cluster = "example-cluster";
  state.metrics.mockReset().mockImplementation(async () => [usage()]);
  state.pod.mockReset().mockResolvedValue({
    metadata: identity,
    spec: {
      containers: [{ resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "1", memory: "128Mi" } } }],
    },
  });
  window.history.replaceState({}, "", "/pods?kube-details=/api/v1/namespaces/default/pods/worker");
  drawer();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

it("sums all container usage and rejects stale or mismatched identities", () => {
  expect(aggregatePodMetrics(usage(), identity)).toMatchObject({ cpu: 0.3, memory: 96 * 1024 ** 2 });
  expect(() => aggregatePodMetrics({ ...usage(), metadata: { ...identity, namespace: "other" } }, identity)).toThrow();
  expect(() =>
    aggregatePodMetrics({ ...usage(), timestamp: new Date(Date.now() - 121_000).toISOString() }, identity),
  ).toThrow();
  expect(() => aggregatePodMetrics({ ...usage(), containers: [] }, identity)).toThrow();
});

it("replaces only the selected CPU or Memory graph and restores native styles exactly", async () => {
  const graph = document.querySelector<HTMLElement>(".graph")!;
  const original = graph.getAttribute("style");
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  expect(state.metrics).toHaveBeenCalledWith({ namespace: "default" }, { fieldSelector: "metadata.name=worker" });
  expect(state.pod).toHaveBeenCalledWith(identity);
  expect(graph.style.display).toBe("none");
  expect(document.querySelector("[data-power-pod-monitoring] section")?.getAttribute("aria-label")).toContain("CPU");
  expect(document.body.textContent).toContain("Pod metadata");
  selectTab("Memory");
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("[data-power-pod-monitoring] section")?.getAttribute("aria-label")).toContain("Memory");
  for (const native of ["Network", "Filesystem"]) {
    selectTab(native);
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector("[data-power-pod-monitoring]")).toBeNull();
    expect(graph.getAttribute("style")).toBe(original);
  }
  selectTab("CPU");
  await vi.advanceTimersByTimeAsync(1000);
  runInAction(() => {
    state.preferences.enabled = false;
  });
  expect(document.querySelector("[data-power-pod-monitoring]")).toBeNull();
  expect(graph.getAttribute("style")).toBe(original);
});

it("reports metrics failure safely and keeps usage available when pod resource permission fails", async () => {
  state.pod.mockRejectedValue(new Error("Forbidden"));
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.body.textContent).toContain("0.30 cores");
  expect(document.body.textContent).toContain("Pod requests and limits unavailable");
  state.metrics.mockRejectedValue(new Error("private backend failure"));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(document.body.textContent).toContain("Pod metrics unavailable");
  expect(document.body.textContent).not.toContain("private backend failure");
});

it("discards late results after namespace navigation and stops polling when drawer closes", async () => {
  let finish: (value: unknown) => void = () => {};
  state.metrics.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  window.history.replaceState({}, "", "/pods?kube-details=/api/v1/namespaces/other/pods/worker");
  finish([usage()]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelectorAll("[data-power-pod-monitoring] circle")).toHaveLength(0);
  document.querySelector(".KubeObjectDetails")?.remove();
  const reads = state.metrics.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.metrics).toHaveBeenCalledTimes(reads);
  expect(document.querySelector("[data-power-pod-monitoring]")).toBeNull();
});

it("clears session samples across cluster changes and ignores hidden drawers", async () => {
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.querySelectorAll("[data-power-pod-monitoring] circle")).toHaveLength(1);
  state.cluster = "other-cluster";
  state.metrics.mockRejectedValue(new Error("Forbidden"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelectorAll("[data-power-pod-monitoring] circle")).toHaveLength(0);
  document.querySelector<HTMLElement>(".KubeObjectDetails")!.hidden = true;
  const calls = state.metrics.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.metrics).toHaveBeenCalledTimes(calls);
  expect(document.querySelector("[data-power-pod-monitoring]")).toBeNull();
});

it("rejects metrics from a previous pod incarnation instead of joining histories", async () => {
  state.pod.mockResolvedValue({ metadata: { ...identity, uid: "new-pod" }, spec: { containers: [{}] } });
  state.metrics.mockResolvedValue([{ ...usage(), metadata: { ...identity, uid: "old-pod" } }]);
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.querySelectorAll("[data-power-pod-monitoring] circle")).toHaveLength(0);
  expect(document.body.textContent).toContain("Pod metrics unavailable");
});

it("rejects cached metrics without a UID that predate a recreated pod and clears old samples", async () => {
  const originalTime = Date.now();
  state.pod.mockResolvedValue({
    metadata: { ...identity, uid: "original-pod", creationTimestamp: new Date(originalTime - 60_000).toISOString() },
    spec: { containers: [{}] },
  });
  state.metrics.mockResolvedValue([{ ...usage(), timestamp: new Date(originalTime).toISOString() }]);
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.querySelectorAll("[data-power-pod-monitoring] circle")).toHaveLength(1);
  state.pod.mockResolvedValue({
    metadata: { ...identity, uid: "replacement-pod", creationTimestamp: new Date(originalTime + 10_000).toISOString() },
    spec: { containers: [{}] },
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(document.querySelectorAll("[data-power-pod-monitoring] circle")).toHaveLength(0);
  expect(document.body.textContent).toContain("Pod metrics unavailable");
  state.metrics.mockResolvedValue([usage()]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(document.querySelectorAll("[data-power-pod-monitoring] circle")).toHaveLength(1);
});

it("clears an old incarnation even when its replacement has no usable metrics", async () => {
  state.pod.mockResolvedValue({ metadata: { ...identity, uid: "original-pod" }, spec: { containers: [{}] } });
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.querySelectorAll("[data-power-pod-monitoring] circle")).toHaveLength(1);
  state.pod.mockResolvedValue({ metadata: { ...identity, uid: "replacement-pod" }, spec: { containers: [{}] } });
  state.metrics.mockRejectedValue(new Error("Not found"));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(document.querySelectorAll("[data-power-pod-monitoring] circle")).toHaveLength(0);
});

it("accepts metrics-server list entries without UID or resourceVersion and selects the exact pod", async () => {
  state.metrics.mockResolvedValue([
    {
      ...usage(),
      metadata: { ...identity, name: "other-worker" },
      containers: [{ name: "app", usage: { cpu: "9", memory: "9Gi" } }],
    },
    usage(),
    { ...usage(), metadata: { ...identity, namespace: "other" } },
  ]);
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.body.textContent).toContain("0.30 cores");
  expect(document.body.textContent).not.toContain("9.00 cores");
  expect(document.querySelectorAll("[data-power-pod-monitoring] circle")).toHaveLength(1);
});

it.each([
  null,
  [],
  [{ ...usage(), metadata: { ...identity, namespace: "other" } }],
])("treats missing exact metrics as unavailable", async (response) => {
  state.metrics.mockResolvedValue(response);
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.body.textContent).toContain("Pod metrics unavailable");
  expect(document.querySelectorAll("[data-power-pod-monitoring] circle")).toHaveLength(0);
});
