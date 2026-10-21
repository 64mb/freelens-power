// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  preferences: {} as { enabled: boolean; historyEnabled: boolean },
  cluster: {} as { uid: string },
  snapshot: vi.fn(),
  sample: vi.fn(),
  release: vi.fn(),
  retain: vi.fn(),
  historyQuery: vi.fn(),
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
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.cluster.uid } }) } },
  },
}));
vi.mock("../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => state.preferences },
}));
vi.mock("./monitoring-collector", () => ({
  getMonitoringSnapshot: state.snapshot,
  getNodeSample: state.sample,
  retainMonitoringCollector: state.retain,
}));
vi.mock("./monitoring-history", () => ({
  monitoringHistory: { query: state.historyQuery },
}));
vi.mock("./monitoring", () => ({
  MetricChart: ({ metric, samples, status }: any) => (
    <div data-metric={metric}>
      {status}
      {samples.map((sample: any) => (
        <span key={sample.time}>
          {sample.cpu}:{sample.resourceStatus}
        </span>
      ))}
    </div>
  ),
}));

import { NodeMonitoringDetails } from "./node-monitoring";

const node = { metadata: { name: "worker", uid: "worker-uid" } } as any;
const data = () => ({ clusterId: state.cluster.uid, time: Date.now(), nodes: [node], pods: [], errors: [] });
async function tick(milliseconds = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  state.preferences = observable({ enabled: true, historyEnabled: true });
  state.cluster = observable({ uid: "cluster-uid" });
  state.snapshot.mockReset().mockImplementation(async () => data());
  state.sample.mockReset().mockImplementation(() => ({ time: Date.now(), cpu: 1, memory: 1024 }));
  state.retain.mockReset().mockReturnValue(state.release);
  state.release.mockReset();
  state.historyQuery.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

it("uses the shared snapshot for the selected node and restores native controls on disable", async () => {
  const drawer = document.createElement("div");
  drawer.className = "KubeObjectDetails";
  drawer.innerHTML =
    '<div data-time-range="30m" style="color: red">Range</div><div class="ResourceMetrics" style="color: blue">Native metrics</div><div class="NodeDetails">Node metadata</div>';
  document.body.append(drawer);
  const host = document.createElement("div");
  drawer.append(host);
  render(<NodeMonitoringDetails object={node} />, { container: host });
  await tick();
  expect(state.sample).toHaveBeenCalledWith(
    expect.objectContaining({ clusterId: "cluster-uid" }),
    "worker",
    "worker-uid",
  );
  expect(host.querySelectorAll("[data-metric]")).toHaveLength(2);
  const metrics = drawer.querySelector<HTMLElement>(".ResourceMetrics")!;
  const range = drawer.querySelector<HTMLElement>("[data-time-range]")!;
  expect(getComputedStyle(metrics).display).toBe("none");
  expect(getComputedStyle(range).display).toBe("none");
  expect(getComputedStyle(drawer.querySelector<HTMLElement>(".NodeDetails")!).display).not.toBe("none");
  act(() => {
    runInAction(() => {
      state.preferences.enabled = false;
    });
  });
  expect(host.querySelector("[data-power-node-monitoring]")).toBeNull();
  expect(metrics.getAttribute("style")).toBe("color: blue");
  expect(range.getAttribute("style")).toBe("color: red");
  expect(getComputedStyle(metrics).display).not.toBe("none");
  expect(state.release).toHaveBeenCalledOnce();
  const reads = state.snapshot.mock.calls.length;
  await tick(10_000);
  expect(state.snapshot).toHaveBeenCalledTimes(reads);
});

it("keeps requests coverage warnings and reports sanitized collection failures", async () => {
  state.sample.mockImplementation(() => ({
    time: Date.now(),
    cpu: 1,
    memory: 1024,
    resourceStatus: "Cluster-wide Pods unavailable or access denied; requests unavailable",
  }));
  const view = render(<NodeMonitoringDetails object={node} />);
  await tick();
  expect(view.container.textContent).toContain("requests unavailable");
  state.sample.mockImplementation(() => {
    throw new Error("private server error");
  });
  await tick(1000);
  expect(view.container.textContent).toContain("Node metrics unavailable");
  expect(view.container.textContent).not.toContain("private server error");
  expect(view.container.querySelectorAll("[data-metric] span")).toHaveLength(2);
});

it("clears old samples across node UID and cluster changes and ignores late responses", async () => {
  const view = render(<NodeMonitoringDetails object={node} />);
  await tick();
  expect(view.container.querySelectorAll("[data-metric] span")).toHaveLength(2);
  let finish!: (value: unknown) => void;
  state.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await tick(1000);
  const replacement = { metadata: { name: "worker", uid: "replacement-uid" } } as any;
  state.sample.mockReturnValue(undefined);
  view.rerender(<NodeMonitoringDetails object={replacement} />);
  await tick();
  expect(view.container.querySelectorAll("[data-metric] span")).toHaveLength(0);
  await act(async () => {
    finish(data());
  });
  expect(view.container.querySelectorAll("[data-metric] span")).toHaveLength(0);
  act(() => {
    runInAction(() => {
      state.cluster.uid = "next-cluster";
    });
  });
  await tick();
  expect(view.container.querySelectorAll("[data-metric] span")).toHaveLength(0);
  expect(state.retain).toHaveBeenCalledTimes(3);
  expect(state.release).toHaveBeenCalledTimes(2);
});

it("discards outstanding results after unmount", async () => {
  let finish!: (value: unknown) => void;
  state.snapshot.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<NodeMonitoringDetails object={node} />);
  view.unmount();
  await act(async () => {
    finish(data());
  });
  expect(state.sample).not.toHaveBeenCalled();
  expect(state.release).toHaveBeenCalledOnce();
  const reads = state.snapshot.mock.calls.length;
  await tick(10_000);
  expect(state.snapshot).toHaveBeenCalledTimes(reads);
});

it("clears samples when inventory reports a recreated node with the same name", async () => {
  const view = render(<NodeMonitoringDetails object={node} />);
  await tick();
  expect(view.container.querySelectorAll("[data-metric] span")).toHaveLength(2);
  state.snapshot.mockResolvedValue({ ...data(), nodes: [{ metadata: { name: "worker", uid: "replacement" } }] });
  await tick(1000);
  expect(view.container.querySelectorAll("[data-metric] span")).toHaveLength(0);
  expect(view.container.textContent).toContain("Node metrics unavailable");
});

it("queries node history by UID and updates the selected history range", async () => {
  const view = render(<NodeMonitoringDetails object={node} />);
  await tick();
  expect(state.historyQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      clusterId: "cluster-uid",
      scope: "node",
      uid: "worker-uid",
    }),
  );
  const range = view.getByRole("combobox", { name: "History range" });
  fireEvent.change(range, { target: { value: "24h" } });
  await tick();
  expect((range as HTMLSelectElement).value).toBe("24h");
  const query = state.historyQuery.mock.lastCall![0];
  expect(query.to - query.from).toBe(24 * 60 * 60_000 - 1000);
});
