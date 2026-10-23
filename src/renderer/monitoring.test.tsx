// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: false,
  list: vi.fn(),
  nodes: vi.fn(),
  pods: vi.fn(),
  cluster: "test-cluster",
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      Select: ({ value, options, onChange, ...props }: any) => (
        <select
          aria-label={props["aria-label"]}
          value={value}
          onChange={(event) => onChange(options.find((option: any) => option.value === event.target.value))}
        >
          {options.map((option: any) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ),
    },
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.cluster } }) } },
    K8sApi: { nodesMetricsApi: { list: state.list }, nodesApi: { list: state.nodes }, podsApi: { list: state.pods } },
  },
}));
vi.mock("../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => state },
}));

import { fireEvent, render } from "@testing-library/react";
import {
  aggregateMetrics,
  aggregateResources,
  effectivePodResource,
  formatMonitoringTime,
  MetricChart,
  parseQuantity,
  startMonitoring as startMonitoringImpl,
} from "./monitoring";

const cleanups = new Set<() => void>();
const startMonitoring = () => {
  const stop = startMonitoringImpl();
  cleanups.add(stop);
  return stop;
};
afterEach(() => {
  for (const stop of cleanups) stop();
  cleanups.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("metrics-server overview", () => {
  beforeEach(() => {
    state.enabled = false;
    state.cluster = "test-cluster";
    state.list.mockReset();
    state.nodes.mockReset().mockRejectedValue(new Error("Forbidden"));
    state.pods.mockReset().mockRejectedValue(new Error("Forbidden"));
  });
  it("fills a wide plot and tracks the nearest sample in the same coordinate system", async () => {
    vi.useFakeTimers();
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1000,
      height: 250,
      left: 100,
      top: 0,
      right: 1100,
      bottom: 250,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
    state.enabled = true;
    state.list.mockImplementation(async () => [
      { usage: { cpu: "1", memory: "1Gi" }, timestamp: new Date().toISOString() },
    ]);
    document.body.innerHTML = '<div data-testid="cluster-overview-page"></div>';
    startMonitoring();
    await vi.advanceTimersByTimeAsync(60_001);
    const chart = document.querySelector("[data-monitoring-trend]")!;
    expect(chart.getAttribute("viewBox")).toBe("0 0 1000 250");
    const points = chart.querySelectorAll("circle");
    expect(points[2].getAttribute("cx")).toBe("976");
    fireEvent.mouseMove(chart, { clientX: 100 + 88 + (976 - 88) * 0.7 });
    expect(document.querySelector("[data-monitoring-crosshair]")?.getAttribute("x1")).toBe("532");
    const latestTitle = points[1].querySelector("title")!.textContent!.split(": 1.00")[0];
    expect(latestTitle).toMatch(/^\d{2}\.\d{2}\.\d{4} {2}\d{2}:\d{2}:\d{2}$/);
    expect(document.querySelector("[role=tooltip]")?.textContent).toContain(latestTitle);
    const tooltip = document.querySelector("[role=tooltip]");
    fireEvent.mouseMove(chart, { clientX: 1076 });
    expect(document.querySelector("[role=tooltip]")).toBe(tooltip);
  });
  it("pins a tooltip through pointer movement and leaving, supports keyboard unpinning, and resets expired selections", () => {
    const samples = [
      { time: 1000, cpu: 1, memory: 1024 },
      { time: 31000, cpu: 2, memory: 2048 },
    ];
    const view = render(<MetricChart metric="cpu" samples={samples} status="" />);
    cleanups.add(() => view.unmount());
    const chart = view.getByRole("img");
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(view.getByRole("tooltip").textContent).toContain("Usage: 1.00 cores");
    fireEvent.keyDown(chart, { key: "Enter" });
    fireEvent.mouseLeave(chart);
    fireEvent.mouseMove(chart, { clientX: 500 });
    expect(view.getByRole("tooltip").textContent).toContain("Pinned");
    expect(view.getByRole("tooltip").textContent).toContain("Usage: 1.00 cores");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(chart);
    fireEvent.click(chart);
    fireEvent.mouseLeave(chart);
    expect(view.getByRole("tooltip").textContent).toContain("Pinned");
    fireEvent.click(chart);
    fireEvent.mouseLeave(chart);
    expect(view.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: " " });
    view.rerender(<MetricChart metric="cpu" samples={[{ time: 61000, cpu: 3, memory: 4096 }]} status="" />);
    expect(view.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "Enter" });
    view.rerender(<MetricChart metric="memory" samples={[{ time: 61000, cpu: 3, memory: 4096 }]} status="" />);
    expect(view.queryByRole("tooltip")).toBeNull();
    expect(view.container.querySelector(".Icon.material > .icon")?.textContent).toBe("memory");
  });
  it("consumes Escape only while pinned so dismissing a tooltip preserves the host drawer", () => {
    const hostEscape = vi.fn();
    window.addEventListener("keydown", hostEscape);
    cleanups.add(() => window.removeEventListener("keydown", hostEscape));
    const view = render(
      <MetricChart metric="cpu" samples={[{ time: 1000, cpu: 1, memory: 1024 }]} status="" scope="pod" />,
    );
    cleanups.add(() => view.unmount());
    const chart = view.getByRole("img");
    expect(fireEvent.keyDown(chart, { key: "Escape" })).toBe(true);
    expect(hostEscape).toHaveBeenCalledTimes(1);
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(view.getByRole("tooltip").textContent).toContain("Pinned");
    expect(fireEvent.keyDown(chart, { key: "Escape" })).toBe(false);
    expect(view.queryByRole("tooltip")).toBeNull();
    expect(hostEscape).toHaveBeenCalledTimes(2);
    expect(hostEscape.mock.calls[1][0].key).toBe("Enter");
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(hostEscape).toHaveBeenCalledTimes(3);
  });
  it("keeps native usage and requests independently visible and restores bars on stop", () => {
    state.enabled = true;
    document.body.innerHTML = `<style>.LineProgress{height:5px}.LineProgress .line{height:100%}.LineProgress .line.secondary{position:absolute;top:0}</style><div class="Nodes">${["cpu", "memory"].map((metric, i) => `<div class="TableCell ${metric}"><div class="LineProgress" title="Usage / Requests / Allocatable"><div class="line secondary" style="width:${i ? 26 : 75}%"></div><div class="line" style="width:${i ? 37 : 12.5}%"></div></div></div>`).join("")}<div class="TableCell disk"><div class="LineProgress"><div class="line"></div></div></div></div>`;
    const original = document.body.innerHTML;
    const stop = startMonitoring();
    for (const metric of ["cpu", "memory"]) {
      const bar = document.querySelector(`.${metric} .LineProgress`)!;
      expect(getComputedStyle(bar.querySelector(".line:not(.secondary)")!).height).toBe("60%");
      expect(getComputedStyle(bar.querySelector(".secondary")!).height).toBe("40%");
      expect(getComputedStyle(bar.querySelector(".secondary")!).top).toBe("60%");
      expect(getComputedStyle(bar.querySelector(".line:not(.secondary)")!).borderRadius).toBe("0px");
      expect(getComputedStyle(bar.querySelector(".secondary")!).borderRadius).toBe("0px");
      expect(getComputedStyle(bar).overflow).toBe("hidden");
      expect(getComputedStyle(bar).height).toBe("5px");
      expect(bar.getAttribute("title")).toBe("Usage / Requests / Allocatable");
    }
    expect(getComputedStyle(document.querySelector(".disk .line")!).height).toBe("100%");
    stop();
    expect(document.body.innerHTML).toBe(original);
    expect(getComputedStyle(document.querySelector(".memory .line:not(.secondary)")!).height).toBe("100%");
    expect(getComputedStyle(document.querySelector(".memory .secondary")!).top).toBe("0px");
  });
  it("suppresses native loading panels before overview insertion and replaces them without waiting for the polling interval", async () => {
    vi.useFakeTimers();
    state.enabled = true;
    state.list.mockResolvedValue([{ usage: { cpu: "1", memory: "1Gi" }, timestamp: new Date().toISOString() }]);
    document.body.innerHTML = "";
    const stop = startMonitoring();
    expect(document.head.querySelector("[data-freelens-power-native-metrics-suppression]")).not.toBeNull();
    expect(state.list).not.toHaveBeenCalled();
    document.body.innerHTML =
      '<div data-testid="cluster-overview-page"><div id="native" class="cluster-metrics-module__ClusterMetrics--example">Loading</div><div id="pie-loading"><div class="cluster-pie-charts-module__empty--example">Loading</div></div><div id="pods"><div class="PieChart"><div class="chart-title">Pods</div></div></div></div>';
    const original = document.body.innerHTML;
    expect(getComputedStyle(document.querySelector("#native")!).display).toBe("none");
    expect(getComputedStyle(document.querySelector("#pie-loading")!).display).toBe("none");
    expect(getComputedStyle(document.querySelector("#pods")!).display).not.toBe("none");
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector("[data-freelens-power-monitoring]")).not.toBeNull();
    expect(state.list).toHaveBeenCalledTimes(1);
    stop();
    expect(document.head.querySelector("[data-freelens-power-native-metrics-suppression]")).toBeNull();
    expect(document.body.innerHTML).toBe(original);
    expect(getComputedStyle(document.querySelector("#native")!).display).not.toBe("none");
  });
  it("limits Pod charts to usage and requests without the normal data footnote while retaining errors and collecting status", () => {
    const samples = [
      {
        time: 1000,
        cpu: 1,
        memory: 1024,
        resources: { cpu: { requests: 2, allocatable: 3, capacity: 4 }, memory: {} },
      },
    ];
    const view = render(<MetricChart metric="cpu" samples={samples} status="" scope="pod" />);
    cleanups.add(() => view.unmount());
    expect(view.container.querySelectorAll("[data-monitoring-series]")).toHaveLength(2);
    expect(view.container.textContent).not.toContain("Allocatable");
    expect(view.container.textContent).not.toContain("Capacity");
    expect(view.container.textContent).not.toContain("metrics-server data");
    fireEvent.focus(view.getByRole("img"));
    expect(view.getByRole("tooltip").textContent).toContain("Requests: 2.00 cores");
    expect(view.getByRole("tooltip").textContent).not.toContain("Capacity");
    expect(view.getByRole("tooltip").textContent).not.toContain("Allocatable");
    view.rerender(<MetricChart metric="cpu" samples={samples} status="Metrics access denied" scope="pod" />);
    expect(view.getByRole("status", { name: "pod metrics status" }).textContent).toBe("Metrics access denied");
    view.rerender(<MetricChart metric="cpu" samples={[]} status="" scope="pod" />);
    expect(view.getByRole("status", { name: "pod metrics status" }).textContent).toContain(
      "Waiting for metrics-server data",
    );
    view.rerender(<MetricChart metric="cpu" samples={samples} status="" scope="node" />);
    expect(view.container.querySelectorAll("[data-monitoring-series]")).toHaveLength(4);
    expect(view.getByRole("status", { name: "node metrics status" }).textContent).toContain("*metrics-server data");
  });
  it("accounts for init peaks, restartable sidecars, pod-level budgets and overhead", () => {
    const pod = {
      spec: {
        containers: [{ resources: { requests: { cpu: "2" }, limits: { cpu: "3" } } }],
        initContainers: [
          { restartPolicy: "Always", resources: { requests: { cpu: "1" }, limits: { cpu: "2" } } },
          { resources: { requests: { cpu: "4" }, limits: { cpu: "5" } } },
        ],
        overhead: { cpu: "100m" },
      },
    };
    expect(effectivePodResource(pod, "cpu", "requests")).toBe(5.1);
    expect(effectivePodResource(pod, "cpu", "limits")).toBe(7.1);
    expect(
      effectivePodResource({ spec: { ...pod.spec, resources: { requests: { cpu: "6" } } } }, "cpu", "requests"),
    ).toBe(6.1);
    expect(effectivePodResource({ spec: { containers: [{}] } }, "cpu", "limits")).toBe(Infinity);
    expect(
      effectivePodResource({ spec: { containers: [{ resources: { limits: { cpu: "1" } } }] } }, "cpu", "requests"),
    ).toBe(1);
  });
  it("uses scheduled active pods, preserves overcommit and distinguishes missing inventory from unbounded limits", () => {
    const nodes = [
      {
        metadata: { name: "node-a" },
        status: { capacity: { cpu: "4", memory: "8Gi" }, allocatable: { cpu: "3", memory: "7Gi" } },
      },
    ];
    const pod = {
      spec: { nodeName: "node-a", containers: [{ resources: { requests: { cpu: "5", memory: "1Gi" } } }] },
      status: { phase: "Running" },
    };
    const totals = aggregateResources(nodes, [
      pod,
      { ...pod, status: { phase: "Succeeded" } },
      { ...pod, spec: { ...pod.spec, nodeName: "" } },
    ]);
    expect(totals.cpu).toEqual({ capacity: 4, allocatable: 3, requests: 5, limits: undefined, unbounded: true });
    expect(totals.cpu.allocatable! - totals.cpu.requests!).toBe(-2);
    expect(aggregateResources(nodes).cpu.requests).toBeUndefined();
    expect(() => aggregateResources([])).toThrow();
  });
  it("renders consistent resource series and coverage-aware allocation summaries", async () => {
    vi.useFakeTimers();
    state.enabled = true;
    state.nodes.mockResolvedValue([
      {
        metadata: { name: "node-a" },
        status: { capacity: { cpu: "4", memory: "8Gi" }, allocatable: { cpu: "3", memory: "7Gi" } },
      },
    ]);
    state.pods.mockResolvedValue([
      {
        spec: {
          nodeName: "node-a",
          containers: [{ resources: { requests: { cpu: "5", memory: "1Gi" }, limits: { cpu: "6", memory: "2Gi" } } }],
        },
        status: { phase: "Running" },
      },
    ]);
    state.list.mockResolvedValue([
      { metadata: { name: "node-a" }, usage: { cpu: "1", memory: "1Gi" }, timestamp: new Date().toISOString() },
    ]);
    document.body.innerHTML = '<div data-testid="cluster-overview-page"></div>';
    const stop = startMonitoring();
    await vi.advanceTimersByTimeAsync(1);
    const summary = document.querySelector('[aria-label="CPU resource summary"]')!;
    const allocationTooltip = () => summary.querySelector('[title^="Allocatable:"]')?.getAttribute("title");
    expect(summary.querySelector("svg > title")).toBeNull();
    expect(allocationTooltip()).toContain("Unrequested: -2.00 cores");
    expect(allocationTooltip()).toContain("Unused allocatable (usage): 2.00 cores");
    expect(summary.querySelectorAll("g")).toHaveLength(2);
    const donutRings = summary.querySelectorAll("g");
    fireEvent.mouseEnter(donutRings[0]);
    expect(summary.querySelector('[role="tooltip"]')?.textContent).toContain("Usage: 1.00 cores");
    expect(summary.querySelector('[role="tooltip"]')?.textContent).toContain("33.3% of allocatable");
    fireEvent.mouseMove(donutRings[1]);
    expect(summary.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    expect(summary.querySelector('[role="tooltip"]')?.textContent).toContain("Requests: 5.00 cores");
    fireEvent.mouseLeave(donutRings[1]);
    expect(summary.querySelector('[role="tooltip"]')).toBeNull();
    fireEvent.focus(donutRings[1]);
    expect(summary.querySelector('[role="tooltip"]')?.textContent).toContain(
      "166.7% of allocatable (over allocatable)",
    );
    expect(donutRings[1].getAttribute("aria-describedby")).toBe(summary.querySelector('[role="tooltip"]')?.id);
    donutRings[1].setAttribute("tabindex", "0");
    (donutRings[1] as SVGGElement).focus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    fireEvent(donutRings[1], escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(summary.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.activeElement).toBe(donutRings[1]);
    fireEvent.blur(donutRings[1]);
    expect(summary.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.querySelector('[aria-label="Memory resource summary"] strong')?.textContent).toContain("RAM");
    expect(summary.querySelectorAll("circle:not([data-monitoring-ring])")).toHaveLength(2);
    expect(summary.querySelectorAll("circle:not([data-monitoring-ring])[stroke-dasharray]")).toHaveLength(0);
    expect(summary.querySelector("[data-monitoring-usage-percentage]")?.textContent).toBe("33.3%");
    expect(summary.querySelector('[aria-label="CPU resource totals"]')?.textContent).toContain(
      "Allocatable: 3.00 cores",
    );
    expect(summary.querySelector('[aria-label="CPU resource totals"]')?.textContent).not.toContain("Capacity");
    expect(document.querySelectorAll("[data-monitoring-donut]")).toHaveLength(2);
    expect(document.querySelector('[data-monitoring-ring="Requests"]')?.getAttribute("stroke-dasharray")).toBe(
      "100 100",
    );
    expect(document.querySelector('[aria-label="CPU resource summary"]')?.textContent).toContain("166.7%");
    expect(allocationTooltip()).toContain("Physical Capacity: 4.00 cores");
    expect(document.querySelectorAll("[data-monitoring-series]")).toHaveLength(8);
    expect(document.querySelector('[data-monitoring-series="limits"]')).toBeNull();
    expect(allocationTooltip()).not.toContain("Limits");
    expect(document.querySelector('[aria-label="node metrics status"]')?.textContent).toContain("metrics-server data");
    fireEvent.focus(document.querySelector("[data-monitoring-trend]")!);
    expect(document.querySelector("[role=tooltip]")?.textContent).toContain("Requests: 5.00 cores");
    expect(document.querySelector("[role=tooltip]")?.textContent).not.toContain("Limits");
    state.pods.mockResolvedValue([{ spec: { nodeName: "node-a", containers: [{}] }, status: { phase: "Running" } }]);
    state.list.mockResolvedValue([
      { metadata: { name: "other-node" }, usage: { cpu: "1", memory: "1Gi" }, timestamp: new Date().toISOString() },
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(document.body.textContent).toContain("Partial node metrics coverage");
    expect(allocationTooltip()).not.toContain("Limits");
    expect(document.querySelectorAll('[data-monitoring-ring="Limits"]')).toHaveLength(0);
    expect(allocationTooltip()).toContain("Unused allocatable (usage): Unavailable");
    stop();
    vi.useRealTimers();
  });
  it("converts CPU and memory quantities without inventing missing values", () => {
    expect(parseQuantity("125000000n")).toBe(0.125);
    expect(parseQuantity("250m")).toBe(0.25);
    expect(parseQuantity(".5")).toBe(0.5);
    expect(parseQuantity("1e3", true)).toBe(1000);
    expect(parseQuantity("1E-3")).toBe(0.001);
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
  it("replaces CSS-module native panels, preserves Pods, fills the grid and restores its original layout", async () => {
    vi.useFakeTimers();
    state.enabled = true;
    state.list.mockResolvedValue([{ usage: { cpu: "500m", memory: "1Gi" }, timestamp: new Date().toISOString() }]);
    document.body.innerHTML =
      '<div data-testid="cluster-overview-page" style="height:100%"><div id="legacy" class="ClusterMetrics_abcd flex column">Master Worker 1 hour CPU Memory Loading</div><div id="pies"><div id="cpu"><div class="PieChart"><div class="chart-title">CPU</div></div></div><div id="pods"><div class="PieChart"><div class="chart-title">Pods</div></div></div></div><div id="issues" style="grid-area:issues">Issues</div></div>';
    const original = document.body.innerHTML;
    const stop = startMonitoring();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector<HTMLElement>("#legacy")?.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#cpu")?.style.display).toBe("none");
    expect(document.querySelector<HTMLElement>("#pies")?.style.display).toBe("");
    expect(document.querySelector<HTMLElement>("#pods")?.style.display).toBe("");
    expect(document.querySelector<HTMLElement>("[data-freelens-power-monitoring]")?.style.gridColumn).toBe("1 / -1");
    const chart = document.querySelector("[data-monitoring-trend]")!;
    fireEvent.focus(chart);
    expect(document.querySelector("[role=tooltip]")?.textContent).toContain("0.50 cores");
    expect(document.querySelector("[data-monitoring-crosshair]")).not.toBeNull();
    expect(chart.querySelectorAll("text")).toHaveLength(6);
    expect(formatMonitoringTime(new Date(2026, 0, 1, 23, 4, 5).getTime())).toBe("23:04:05");
    stop();
    expect(document.body.innerHTML).toBe(original);
    vi.useRealTimers();
  });
  it.each([
    '<div id="unavailable"><div class="noMetrics_abcd">Prometheus unavailable</div></div>',
    '<div id="unavailable" class="noMetrics_abcd"><div data-testid="no-metrics-message">Prometheus unavailable</div></div>',
    '<div id="unavailable" class="flex"><div class="cluster-pie-charts-module__empty--abc flex"><div class="Spinner">Loading</div></div></div>',
  ])("hides native unavailable Prometheus markup and restores it on cleanup: %s", async (markup) => {
    vi.useFakeTimers();
    state.enabled = true;
    state.list.mockResolvedValue([]);
    document.body.innerHTML = `<div data-testid="cluster-overview-page">${markup}</div>`;
    const original = document.body.innerHTML;
    const stop = startMonitoring();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector<HTMLElement>("#unavailable")?.style.display).toBe("none");
    stop();
    expect(document.body.innerHTML).toBe(original);
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
    const range = document.querySelector<HTMLElement>('[aria-label="History range"]')!;
    expect(document.querySelector(".power-history-compact")?.textContent).toContain("5 min");
    expect(document.querySelectorAll("[data-monitoring-trend] circle")).toHaveLength(22);
    fireEvent.keyDown(range, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.click(
      [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent === "30 min")!,
    );
    expect(document.querySelectorAll("[data-monitoring-trend] circle")).toHaveLength(120);
    state.list.mockRejectedValue(new Error("Forbidden"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(document.body.textContent).toContain("Unavailable");
    expect(document.body.textContent).toContain("access denied");
    expect(document.querySelectorAll("[data-monitoring-donut]")).toHaveLength(2);
    expect(document.querySelectorAll('[data-monitoring-ring="Requests"]')).toHaveLength(0);
    expect(document.querySelector("[data-monitoring-heading]")?.textContent).toContain("CPUUnavailable");
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
    await vi.advanceTimersByTimeAsync(1);
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

it("connects missing intervals with dashed segments without inventing measured points", () => {
  const view = render(
    <MetricChart
      metric="cpu"
      status=""
      samples={[
        { time: 1000, cpu: 1, memory: 1024, resources: { cpu: { requests: 2 }, memory: {} } },
        { time: 31000, cpu: 2, memory: 2048 },
        { time: 121000, cpu: 3, memory: 3072, breakBefore: true, resources: { cpu: { requests: 4 }, memory: {} } },
      ]}
    />,
  );
  const usage = view.container.querySelector('[data-monitoring-series="usage"]')!;
  expect(usage.getAttribute("d")).toMatch(/M[^M]+L[^M]+M/);
  expect(view.container.querySelector('[data-monitoring-gap="usage"]')?.getAttribute("stroke-dasharray")).toBe("3 4");
  expect(view.container.querySelector('[data-monitoring-gap="requests"]')).not.toBeNull();
  expect(view.container.querySelectorAll("[data-monitoring-trend] circle")).toHaveLength(3);
  view.unmount();
});
