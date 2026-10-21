// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cluster: "sample-cluster",
  get: vi.fn(),
  release: vi.fn(),
  navigate: vi.fn(),
  track: vi.fn(),
  query: vi.fn(),
  usage: vi.fn(),
  preferences: { historyEnabled: true },
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.cluster } }) } },
    Navigation: { showDetails: state.navigate },
    Component: {
      Select: ({
        value,
        options,
        onChange,
      }: {
        value: string;
        options: { value: string; label: string }[];
        onChange: (option: { value: string }) => void;
      }) => (
        <select aria-label="History range" value={value} onChange={(event) => onChange({ value: event.target.value })}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ),
    },
  },
}));
vi.mock("./monitoring-collector", () => ({
  getMonitoringSnapshot: state.get,
  retainMonitoringCollector: () => state.release,
  getCollectedPodUsage: state.usage,
}));
vi.mock("../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => state.preferences },
}));
vi.mock("./monitoring-history-collection", () => ({ isHistoryTracked: () => false, setHistoryTracked: state.track }));

vi.mock("./monitoring-history", () => ({ monitoringHistory: { query: state.query } }));
vi.mock("./monitoring", () => ({ MetricChart: ({ metric }: { metric: string }) => <div>{metric} history chart</div> }));

import { DiagnosticsPage } from "./diagnostics";

const snapshot = () => ({
  clusterId: "sample-cluster",
  time: Date.now(),
  errors: [],
  pods: [
    {
      kind: "Pod",
      metadata: {
        uid: "pod-a",
        name: "worker",
        namespace: "sample",
        ownerReferences: [{ uid: "deployment-a", controller: true }],
      },
      spec: { containers: [{ resources: { requests: { cpu: "100m", memory: "1Mi" } } }] },
      status: { phase: "Pending" },
    },
  ],
  owners: [{ kind: "Deployment", metadata: { uid: "deployment-a", name: "app", namespace: "sample" } }],
  nodes: [],
  events: [
    {
      metadata: { uid: "event-a" },
      involvedObject: { uid: "pod-a" },
      reason: "FailedScheduling",
      message: "Insufficient cpu",
      type: "Warning",
    },
    {
      metadata: { uid: "event-other" },
      involvedObject: { uid: "other" },
      reason: "Unrelated",
      message: "Other application",
    },
  ],
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.cluster = "sample-cluster";
  state.get.mockReset().mockResolvedValue(snapshot());
  state.release.mockReset();
  state.navigate.mockReset();
  state.track.mockReset();
  state.query.mockReset().mockResolvedValue([]);
  state.usage.mockReset().mockReturnValue([{ uid: "pod-a", cpu: 0.05 }]);
  state.preferences.historyEnabled = true;
});
describe("resource diagnostics views", () => {
  it("renders partial coverage and filters consumers, expands exact pod details and tracks identities", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("sample / Deployment / app")).toBeTruthy());
    expect(view.getByText(/Unavailable \(0\/1 pods covered\)/)).toBeTruthy();
    fireEvent.click(view.getByText("sample / Deployment / app"));
    fireEvent.click(view.getByText("worker"));
    expect(state.navigate).toHaveBeenCalledWith("/api/v1/namespaces/sample/pods/worker");
    fireEvent.click(view.getAllByText("Track history")[0]);
    expect(state.track).toHaveBeenCalledWith(
      { clusterId: "sample-cluster", scope: "workload", uid: "deployment-a" },
      true,
    );
    fireEvent.change(view.getByLabelText("Filter consumers"), { target: { value: "absent" } });
    expect(view.getByText("No consumers available")).toBeTruthy();
    view.unmount();
    expect(state.release).toHaveBeenCalledTimes(1);
  });
  it("filters timeline by exact application UIDs and shows unknown event times", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("sample / Deployment / app")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: /Timeline/ }));
    fireEvent.change(view.getByLabelText("Timeline application"), { target: { value: "sample/deployment-a" } });
    expect(view.getByText("Insufficient cpu")).toBeTruthy();
    expect(view.queryByText("Other application")).toBeNull();
    expect(view.getByText("Time unknown")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: /Pending/ }));
    fireEvent.change(view.getByLabelText("Pending pod"), { target: { value: "pod-a" } });
    expect(view.getByText("Unscheduled")).toBeTruthy();
    expect(view.getByText("Reported Kubernetes event")).toBeTruthy();
    expect(view.getByText(/do not establish exact schedulability/)).toBeTruthy();
  });
  it("rejects a completed request after the active cluster changes", async () => {
    let complete: (value: ReturnType<typeof snapshot>) => void = () => {};
    state.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const view = render(<DiagnosticsPage />);
    state.cluster = "another-cluster";
    complete(snapshot());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.queryByText("sample / Deployment / app")).toBeNull();
  });
  it("groups namespace totals above expandable workload and pod resource rows", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("sample / Deployment / app")).toBeTruthy());
    fireEvent.change(view.getByLabelText("Group consumers"), { target: { value: "namespace" } });
    expect(view.queryByText("sample / Deployment / app")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: /sample$/ }));
    fireEvent.click(view.getByText("sample / Deployment / app"));
    expect(view.getByText(/0.050 cores, requests 0.100 cores, 50% of requests/)).toBeTruthy();
    expect(view.getByText("Memory requests")).toBeTruthy();
  });
  it("retains exact removed pod identities for a workload during the open view", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("sample / Deployment / app")).toBeTruthy());
    const next = snapshot();
    next.time += 30_000;
    next.pods = [];
    state.get.mockResolvedValue(next);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.getByText("No consumers available")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: /Timeline/ }));
    fireEvent.change(view.getByLabelText("Timeline application"), { target: { value: "sample/deployment-a" } });
    expect(view.getByText("Insufficient cpu")).toBeTruthy();
    expect(view.queryByText("Other application")).toBeNull();
    expect(view.queryByTitle("Open exact resource details")).toBeNull();
  });
  it("observes owner changes at diagnostics time when the base snapshot time is unchanged", async () => {
    const initial = {
      ...snapshot(),
      diagnosticsTime: Date.parse("2026-01-01T12:00:00Z"),
      owners: [
        {
          kind: "Deployment",
          metadata: { uid: "deployment-a", name: "app", namespace: "sample", generation: 1 },
          status: { readyReplicas: 0, updatedReplicas: 0 },
        },
      ],
    };
    state.get.mockResolvedValue(initial);
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("View history")).toBeTruthy());
    const diagnosticsTime = Date.parse("2026-01-01T12:00:30Z");
    state.get.mockResolvedValue({
      ...initial,
      diagnosticsTime,
      owners: [
        {
          ...initial.owners[0],
          metadata: { ...initial.owners[0].metadata, generation: 2 },
          status: { readyReplicas: 1, updatedReplicas: 1 },
        },
      ],
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2));
    fireEvent.click(view.getByRole("button", { name: /Timeline/ }));
    fireEvent.change(view.getByLabelText("Timeline application"), { target: { value: "sample/deployment-a" } });
    await waitFor(() => expect(view.getByText("RolloutObserved")).toBeTruthy());
    const row = view.getByText("RolloutObserved").closest("tr")!;
    expect(row.textContent).toContain(new Date(diagnosticsTime).toLocaleString([], { hourCycle: "h23" }));
    expect(row.textContent).toContain("generation: 1 → 2");
    expect(row.textContent).toContain("readyReplicas: 0 → 1");
  });
  it("does not reproject an identical shared cached snapshot", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("View history")).toBeTruthy());
    expect(state.usage).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2));
    expect(state.usage).toHaveBeenCalledTimes(1);
    fireEvent.change(view.getByLabelText("Filter consumers"), { target: { value: "sample" } });
    expect(state.usage).toHaveBeenCalledTimes(1);
  });
  it("queries application history by stable workload UID", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("View history")).toBeTruthy());
    fireEvent.click(view.getByText("View history"));
    await waitFor(() =>
      expect(state.query).toHaveBeenCalledWith(
        expect.objectContaining({ clusterId: "sample-cluster", scope: "workload", uid: "deployment-a" }),
      ),
    );
    expect(view.getByText("cpu history chart")).toBeTruthy();
    expect(view.getByText("memory history chart")).toBeTruthy();
    expect(view.getByText(/Complete current usage unavailable/)).toBeTruthy();
  });
  it("disables history tracking when local history is disabled", async () => {
    state.preferences.historyEnabled = false;
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("Track history")).toBeTruthy());
    expect((view.getByText("Track history").closest("button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByText("Track history"));
    expect(state.track).not.toHaveBeenCalled();
  });
});
