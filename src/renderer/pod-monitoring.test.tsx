// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
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
  document.body.innerHTML = `<div class="KubeObjectDetails"><div class="drawer-title-text">Pod: worker<span>content_copy</span></div><div class="PodDetails">Pod metadata</div><div class="ResourceMetrics"><div class="switchers">${["CPU", "Memory", "Network", "Filesystem"].map((label) => `<label class="Radio${label === "CPU" ? " checked" : ""}"><input type="radio" /><div class="label">${label}</div></label>`).join("")}</div><div class="graph" style="height: 250px; color: red">Native graph</div></div></div>`;
  for (const radio of document.querySelectorAll<HTMLElement>(".Radio")) {
    radio.addEventListener("click", () => selectTab(radio.querySelector(".label")?.textContent ?? ""));
  }
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
  expect(state.metrics).toHaveBeenCalledWith();
  expect(state.pod).toHaveBeenCalledWith(identity);
  expect(graph.style.display).toBe("none");
  expect(document.querySelector("[data-power-pod-monitoring] section")?.getAttribute("aria-label")).toContain("CPU");
  expect(document.body.textContent).toContain("Pod metadata");
  selectTab("Memory");
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("[data-power-pod-monitoring] section")?.getAttribute("aria-label")).toContain("Memory");
  for (const native of ["Network", "Filesystem"]) {
    const radio = [...document.querySelectorAll<HTMLElement>(".Radio")].find(
      (item) => item.querySelector(".label")?.textContent === native,
    )!;
    expect(radio.hidden).toBe(true);
    expect(radio.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
    radio.click();
    expect(document.querySelector(".Radio.checked .label")?.textContent).toBe("Memory");
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
  expect(document.body.textContent).toContain("Pod requests unavailable");
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

it("falls back from a selected unsupported tab and fully restores native controls on disable", async () => {
  const network = [...document.querySelectorAll<HTMLElement>(".Radio")].find(
    (radio) => radio.querySelector(".label")?.textContent === "Network",
  )!;
  network.setAttribute("style", "color: red");
  network.setAttribute("tabindex", "2");
  const original = network.outerHTML;
  selectTab("Network");
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.querySelector(".Radio.checked .label")?.textContent).toBe("CPU");
  expect(network.hidden).toBe(true);
  expect(network.getAttribute("aria-hidden")).toBe("true");
  expect(network.tabIndex).toBe(2);
  runInAction(() => {
    state.preferences.enabled = false;
  });
  const restored = network.outerHTML;
  expect(restored).toBe(original);
  network.click();
  expect(document.querySelector(".Radio.checked .label")?.textContent).toBe("Network");
});

it("restores hidden tabs and event handling when monitoring is disposed", async () => {
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  const filesystem = [...document.querySelectorAll<HTMLElement>(".Radio")].find(
    (radio) => radio.querySelector(".label")?.textContent === "Filesystem",
  )!;
  expect(filesystem.hidden).toBe(true);
  stop();
  stop = undefined;
  expect(filesystem.hasAttribute("style")).toBe(false);
  expect(filesystem.hasAttribute("hidden")).toBe(false);
  expect(filesystem.hasAttribute("tabindex")).toBe(false);
  expect(filesystem.hasAttribute("aria-hidden")).toBe(false);
  expect(filesystem.querySelector<HTMLInputElement>("input")?.disabled).toBe(false);
  filesystem.click();
  expect(document.querySelector(".Radio.checked .label")?.textContent).toBe("Filesystem");
});

it.each([
  "DeploymentDetails",
  "ReplicaSetDetails",
  "DaemonSetDetails",
  "StatefulSetDetails",
  "JobDetails",
  "CronJobDetails",
  "_ReplicationControllerDetails_generated",
])("hides unsupported controller metrics and time controls reversibly for %s", (detailsClass) => {
  window.history.replaceState({}, "", "/workloads");
  document.body.innerHTML = `<div class="KubeObjectDetails"><div class="${detailsClass}">Controller metadata</div><div data-time-range="30m" style="color: red">Native time range</div><div class="ResourceMetrics" style="height: 250px">Native controller metrics</div></div>`;
  const metrics = document.querySelector<HTMLElement>(".ResourceMetrics")!;
  const time = document.querySelector<HTMLElement>("[data-time-range]")!;
  const originalMetrics = metrics.getAttribute("style");
  const originalTime = time.getAttribute("style");
  stop = startPodMonitoring();
  expect(getComputedStyle(metrics).display).toBe("none");
  expect(getComputedStyle(time).display).toBe("none");
  expect(getComputedStyle(document.querySelector<HTMLElement>(`.${detailsClass}`)!).display).not.toBe("none");
  runInAction(() => {
    state.preferences.enabled = false;
  });
  expect(getComputedStyle(metrics).display).not.toBe("none");
  expect(getComputedStyle(time).display).not.toBe("none");
  expect(metrics.getAttribute("style")).toBe(originalMetrics);
  expect(time.getAttribute("style")).toBe(originalTime);
  expect(document.head.querySelector("[data-power-detail-monitoring]")).toBeNull();
});

it("hides the native pod time filter and loader while a custom graph is mounted", async () => {
  const metrics = document.querySelector<HTMLElement>(".ResourceMetrics")!;
  const time = document.createElement("div");
  time.dataset.timeRange = "30m";
  time.style.color = "red";
  metrics.before(time);
  const loader = document.createElement("div");
  loader.className = "loader";
  metrics.append(loader);
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  expect(getComputedStyle(time).display).toBe("none");
  expect(getComputedStyle(loader).display).toBe("none");
  stop();
  stop = undefined;
  expect(getComputedStyle(time).display).not.toBe("none");
  expect(getComputedStyle(loader).display).not.toBe("none");
  expect(time.getAttribute("style")).toBe("color: red;");
});

it("immediately hides native container metrics and restores their controls on disable", async () => {
  const main = document.querySelector<HTMLElement>(".ResourceMetrics")!;
  const mainRange = document.createElement("div");
  mainRange.dataset.timeRange = "30m";
  main.before(mainRange);
  const container = document.createElement("div");
  container.innerHTML = `<div data-time-range="30m" style="color: blue">Container time range</div><div class="ResourceMetrics"><div class="RadioGroup">${["CPU", "Memory", "Filesystem"].map((label) => `<label class="Radio"><div class="label">${label}</div></label>`).join("")}</div><div class="graph">Native container metrics</div></div>`;
  document.querySelector(".PodDetails")!.append(container);
  const containerRange = container.querySelector<HTMLElement>("[data-time-range]")!;
  const originalRange = containerRange.getAttribute("style");
  const containerMetrics = container.querySelector<HTMLElement>(".ResourceMetrics")!;
  stop = startPodMonitoring();
  expect(getComputedStyle(containerRange).display).toBe("none");
  expect(getComputedStyle(containerMetrics).display).toBe("none");
  await vi.advanceTimersByTimeAsync(1);
  expect(getComputedStyle(mainRange).display).toBe("none");
  expect(getComputedStyle(containerRange).display).toBe("none");
  expect(container.querySelector("[data-power-pod-monitoring]")).toBeNull();
  expect(containerRange.getAttribute("style")).toBe(originalRange);
  runInAction(() => {
    state.preferences.enabled = false;
  });
  expect(getComputedStyle(containerMetrics).display).not.toBe("none");
  expect(getComputedStyle(mainRange).display).not.toBe("none");
  expect(getComputedStyle(containerRange).display).not.toBe("none");
  expect(containerRange.getAttribute("style")).toBe(originalRange);
});

it("preserves the native radio keyboard tab stop updated during CPU fallback", async () => {
  const radios = [...document.querySelectorAll<HTMLElement>(".Radio")];
  const network = radios.find((radio) => radio.querySelector(".label")?.textContent === "Network")!;
  const cpu = radios.find((radio) => radio.querySelector(".label")?.textContent === "CPU")!;
  selectTab("Network");
  network.removeAttribute("tabindex");
  cpu.addEventListener("click", () => {
    network.tabIndex = 0;
    cpu.removeAttribute("tabindex");
  });
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  expect(network.hidden).toBe(true);
  expect(network.tabIndex).toBe(0);
  runInAction(() => {
    state.preferences.enabled = false;
  });
  expect(network.hidden).toBe(false);
  expect(network.getAttribute("tabindex")).toBe("0");
  network.click();
  expect(document.querySelector(".Radio.checked .label")?.textContent).toBe("Network");
});

it("suppresses graphs inserted between polling ticks before mounting their replacement", async () => {
  document.body.innerHTML = "";
  stop = startPodMonitoring();
  drawer();
  const graph = document.querySelector<HTMLElement>(".graph")!;
  expect(document.querySelector("[data-power-pod-monitoring]")).toBeNull();
  expect(graph.style.display).toBe("");
  expect(getComputedStyle(graph).display).toBe("none");
  expect(getComputedStyle(document.querySelector<HTMLElement>(".switchers")!).display).not.toBe("none");
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("[data-power-pod-monitoring]")).not.toBeNull();
  runInAction(() => {
    state.preferences.enabled = false;
  });
  expect(getComputedStyle(graph).display).not.toBe("none");
});

it("overlays a compact history selector in the chart and retains its range across CPU and Memory tabs", async () => {
  stop = startPodMonitoring();
  await vi.advanceTimersByTimeAsync(1);
  const chart = document.querySelector("[data-power-pod-monitoring] section")!;
  const action = chart.querySelector<HTMLElement>(".power-monitoring-period-action")!;
  expect(action).not.toBeNull();
  expect(getComputedStyle(action).position).toBe("absolute");
  expect(getComputedStyle(action).right).toBe("16px");
  expect(getComputedStyle(action).top).toBe("19px");
  expect(chart.querySelector<HTMLElement>("[data-monitoring-heading]")?.style.paddingRight).toBe("100px");
  expect(document.querySelector("[data-power-pod-monitoring]")?.textContent).not.toContain("Period");
  const combo = screen.getByRole("combobox", { name: "History range" });
  expect(combo.closest(".power-history-compact")).not.toBeNull();
  fireEvent.keyDown(combo, { key: "ArrowDown", code: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: "24 hours" }));
  expect(action.textContent).toContain("24 hours");
  selectTab("Memory");
  await vi.advanceTimersByTimeAsync(1000);
  expect(document.querySelector("[data-power-pod-monitoring] section")?.getAttribute("aria-label")).toContain("Memory");
  expect(document.querySelector(".power-monitoring-period-action")?.textContent).toContain("24 hours");
});
