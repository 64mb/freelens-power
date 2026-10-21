// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ enabled: false, list: vi.fn(), cluster: "test-cluster" }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.cluster } }) } },
    K8sApi: { nodesMetricsApi: { list: state.list } },
  },
}));
vi.mock("../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => state },
}));

import { aggregateMetrics, parseQuantity, startMonitoring } from "./monitoring";

describe("metrics-server overview", () => {
  beforeEach(() => {
    state.enabled = false;
    state.cluster = "test-cluster";
    state.list.mockReset();
  });
  it("converts CPU and memory quantities without inventing missing values", () => {
    expect(parseQuantity("125000000n")).toBe(0.125);
    expect(parseQuantity("250m")).toBe(0.25);
    expect(parseQuantity("2Gi", true)).toBe(2 * 1024 ** 3);
    expect(parseQuantity("2G", true)).toBe(2e9);
    expect(() => parseQuantity("unknown")).toThrow();
    expect(() => parseQuantity("2Gi")).toThrow();
  });
  it("aggregates fresh node samples and rejects empty, stale and incomplete metrics", () => {
    const now = Date.now();
    const node = { usage: { cpu: "250m", memory: "512Mi" }, timestamp: new Date(now).toISOString() };
    expect(aggregateMetrics([node, node], now)).toEqual({ time: now, cpu: 0.5, memory: 1024 ** 3 });
    expect(() => aggregateMetrics([], now)).toThrow();
    expect(() => aggregateMetrics([{ ...node, timestamp: new Date(now - 180000).toISOString() }], now)).toThrow();
    expect(() => aggregateMetrics([{ ...node, usage: { cpu: "", memory: "512Mi" } }], now)).toThrow();
  });
  it("replaces only native CPU and memory panels and restores exact styles on cleanup", async () => {
    vi.useFakeTimers();
    state.enabled = true;
    state.list.mockResolvedValue([{ usage: { cpu: "500m", memory: "1Gi" }, timestamp: new Date().toISOString() }]);
    document.body.innerHTML =
      '<div data-testid="cluster-overview-page"><div id="cpu" style="color:red"><div class="PieChart"><div class="chart-title">CPU</div></div></div><div id="memory"><div class="PieChart"><div class="chart-title">Memory</div></div></div><div id="pods"><div class="PieChart"><div class="chart-title">Pods</div></div></div></div>';
    const original = document.body.innerHTML;
    const stop = startMonitoring();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.list).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLElement>("#cpu")?.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#memory")?.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#pods")?.style.display).toBe("");
    expect(document.body.textContent).toContain("0.50 cores");
    stop();
    expect(document.body.innerHTML).toBe(original);
    await vi.advanceTimersByTimeAsync(60000);
    expect(state.list).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  it("bounds samples to 60 and reports denied reads without synthetic zero", async () => {
    vi.useFakeTimers();
    state.enabled = true;
    state.list.mockImplementation(async () => [
      { usage: { cpu: "1", memory: "1Gi" }, timestamp: new Date().toISOString() },
    ]);
    document.body.innerHTML = '<div data-testid="cluster-overview-page"></div>';
    const stop = startMonitoring();
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(document.querySelectorAll("circle")).toHaveLength(120);
    state.list.mockRejectedValue(new Error("Forbidden"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(document.body.textContent).toContain("Unavailable");
    expect(document.body.textContent).toContain("access denied");
    expect(document.body.textContent).not.toContain("0.00 cores");
    stop();
    vi.useRealTimers();
  });
  it("starts a new cluster request while the previous cluster request is pending without clearing the new request guard", async () => {
    vi.useFakeTimers();
    state.enabled = true;
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    state.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    state.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
    );
    document.body.innerHTML = '<div data-testid="cluster-overview-page"></div>';
    const stop = startMonitoring();
    expect(state.list).toHaveBeenCalledTimes(1);
    state.cluster = "other-cluster";
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.list).toHaveBeenCalledTimes(2);
    resolveOld([{ usage: { cpu: "9", memory: "9Gi" }, timestamp: new Date().toISOString() }]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(state.list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("9.00 cores");
    resolveNew([{ usage: { cpu: "1", memory: "1Gi" }, timestamp: new Date().toISOString() }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.body.textContent).toContain("1.00 cores");
    stop();
    vi.useRealTimers();
  });
  it("does not change native charts or read cluster metrics by default", () => {
    document.body.innerHTML =
      '<div data-testid="cluster-overview-page"><div style="color:red"><div class="PieChart"><div class="chart-title">CPU</div></div></div></div>';
    const original = document.body.innerHTML;
    const stop = startMonitoring();
    expect(state.list).not.toHaveBeenCalled();
    expect(document.body.innerHTML).toBe(original);
    stop();
    expect(document.body.innerHTML).toBe(original);
  });
});
