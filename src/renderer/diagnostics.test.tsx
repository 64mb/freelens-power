// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cluster: "sample-cluster",
  get: vi.fn(),
  release: vi.fn(),
  navigate: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.cluster } }) } },
    Navigation: { showDetails: state.navigate },
    Component: {
      Checkbox: ({
        value,
        onChange,
        label,
        disabled,
      }: {
        value: boolean;
        onChange: (value: boolean) => void;
        label: string;
        disabled?: boolean;
      }) => (
        <label>
          <input
            type="checkbox"
            disabled={disabled}
            checked={value}
            onChange={(event) => onChange(event.target.checked)}
          />
          {label}
        </label>
      ),
      Input: ({
        value,
        onChange,
        ...props
      }: {
        value: string;
        onChange: (value: string) => void;
        "aria-label"?: string;
        placeholder?: string;
      }) => <input {...props} value={value} onChange={(event) => onChange(event.target.value)} />,
      Select: ({
        value,
        options,
        onChange,
        "aria-label": label,
      }: {
        "aria-label"?: string;
        value: string;
        options: { value: string; label: string }[];
        onChange: (option: { value: string }) => void;
      }) => {
        return (
          <select
            aria-label={label ?? "Select"}
            value={value}
            onChange={(event) => onChange({ value: event.target.value })}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );
      },
    },
  },
}));
vi.mock("../common/store/ai-preferences-store", () => ({
  AiPreferencesStore: { getInstanceOrCreate: () => ({ enabled: true }) },
}));
vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
vi.mock("./ai-diagnostic-handoff", () => ({ explainDiagnosticFinding: vi.fn() }));
vi.mock("./monitoring-collector", () => ({
  getMonitoringSnapshot: state.get,
  retainMonitoringCollector: () => state.release,
  getCollectedPodUsage: state.usage,
}));

import { formatDateTime } from "../common/date-time";
import { consumerStatus, DiagnosticsPage } from "./diagnostics";
import {
  clearDiagnosticsStates,
  focusDiagnosticsNamespace,
  readDiagnosticsState,
  saveDiagnosticsState,
} from "./diagnostics-state";

import type { DiagnosticsEvent } from "../common/resource-diagnostics";

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
  ] as DiagnosticsEvent[],
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  clearDiagnosticsStates();
  state.cluster = "sample-cluster";
  state.get.mockReset().mockResolvedValue(snapshot());
  state.release.mockReset();
  state.navigate.mockReset();
  state.usage.mockReset().mockReturnValue([{ uid: "pod-a", cpu: 0.05 }]);
});
describe("consumer status semantics", () => {
  it("requires explicit readiness before showing a healthy status", () => {
    expect(consumerStatus([{ metadata: {}, status: { phase: "Running" } }]).tone).toBe("neutral");
    expect(consumerStatus([]).tone).toBe("neutral");
    expect(
      consumerStatus([{ metadata: {}, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }])
        .tone,
    ).toBe("healthy");
    expect(consumerStatus([{ metadata: {}, status: { phase: "Pending" } }]).tone).toBe("warning");
  });
  it("reserves error status for explicit failures", () => {
    expect(consumerStatus([{ metadata: {}, status: { phase: "Failed" } }]).tone).toBe("error");
    const pod = {
      metadata: {},
      status: {
        phase: "Running",
        containerStatuses: [{ name: "worker", restartCount: 1, state: { waiting: { reason: "CrashLoopBackOff" } } }],
      },
    };
    expect(consumerStatus([pod])).toEqual({ tone: "error", label: "CrashLoopBackOff", icon: "error_outline" });
  });
});
describe("resource diagnostics views", () => {
  it("shows accented summary cards only for consumers", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByLabelText("Snapshot summary")).toBeTruthy());
    expect(
      view.getByText("Workloads and standalone pods").closest(".summary-card")?.classList.contains("workloads"),
    ).toBe(true);
    expect(view.getByText("Pods in snapshot").closest(".summary-card")?.classList.contains("pods")).toBe(true);
    const pendingCard = view.getByText("Pending pods").closest(".summary-card")!;
    expect(pendingCard.classList.contains("attention")).toBe(true);
    expect(pendingCard.querySelector(".summary-icon .Icon")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: /Timeline/ }));
    expect(view.queryByLabelText("Snapshot summary")).toBeNull();
    expect(view.getByText("Search events")).toBeTruthy();
    expect((view.getByLabelText("Warnings only") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(view.getByLabelText("Warnings only"));
    expect((view.getByLabelText("Warnings only") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(view.getByRole("button", { name: /Pending/ }));
    expect(view.queryByLabelText("Snapshot summary")).toBeNull();
  });
  it("keeps zero pending pods in the healthy summary state", async () => {
    const current = snapshot();
    current.pods[0].status.phase = "Running";
    state.get.mockResolvedValue(current);
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("Pending pods")).toBeTruthy());
    const pendingCard = view.getByText("Pending pods").closest(".summary-card")!;
    expect(pendingCard.classList.contains("pending")).toBe(true);
    expect(pendingCard.classList.contains("attention")).toBe(false);
    expect(pendingCard.querySelector("strong")?.textContent).toBe("0");
  });
  it("does not report a healthy zero when the pod inventory is unavailable", async () => {
    state.get.mockResolvedValue({ ...snapshot(), pods: undefined, errors: ["Pod access denied"] });
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("Pod access denied")).toBeTruthy());
    const card = view.getByText("Pending pods").closest(".summary-card")!;
    expect(card.classList.contains("unavailable")).toBe(true);
    expect(card.querySelector("strong")?.textContent).toBe("Unavailable");
    expect(view.getByText("Pods in snapshot").closest(".summary-card")?.textContent).toContain("Unavailable");
    expect(view.getByText("Workloads and standalone pods").closest(".summary-card")?.textContent).toContain(
      "Unavailable",
    );
    fireEvent.click(view.getByRole("button", { name: /Pending/ }));
    expect(view.getByText(/Pod inventory unavailable. Check cluster access/)).toBeTruthy();
    expect(view.queryByText("No pending pods in this snapshot")).toBeNull();
  });
  it("labels usage above requests without marking it as a failure", async () => {
    state.usage.mockReturnValue([{ uid: "pod-a", cpu: 0.2 }]);
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("Above requests")).toBeTruthy());
    const badge = view.getByText("Above requests");
    expect(badge.getAttribute("title")).toContain("not limits");
    expect(badge.classList.contains("error")).toBe(false);
    expect(view.getByText("1 Pending").classList.contains("warning")).toBe(true);
  });
  it("opens the first pending pod directly from its summary card", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByRole("button", { name: "Inspect pending pods" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Inspect pending pods" }));
    expect((view.getByLabelText("Pending pod") as HTMLSelectElement).value).toBe("pod-a");
    expect(view.getByText("Scheduling evidence")).toBeTruthy();
  });
  it("filters attention consumers and warning applications using exact identities", async () => {
    const current = snapshot();
    current.pods.push({
      ...current.pods[0],
      metadata: {
        uid: "pod-b",
        name: "unknown",
        namespace: "sample",
        ownerReferences: [{ uid: "deployment-b", controller: true }],
      },
      status: { phase: "Running" },
    });
    current.owners.push({ kind: "Deployment", metadata: { uid: "deployment-b", name: "other", namespace: "sample" } });
    state.get.mockResolvedValue(current);
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Open Deployment sample / app")).toBeTruthy());
    expect((view.getByLabelText("Needs attention") as HTMLInputElement).checked).toBe(true);
    expect(view.queryByTitle("Open Deployment sample / other")).toBeNull();
    fireEvent.click(view.getByLabelText("Needs attention"));
    expect(view.getByTitle("Open Deployment sample / other")).toBeTruthy();
    fireEvent.click(view.getByLabelText("Needs attention"));
    expect(view.queryByTitle("Open Deployment sample / other")).toBeNull();
    expect(view.getByTitle("Open Deployment sample / app")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: /Timeline/ }));
    expect((view.getByLabelText("Warnings only") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(view.getByLabelText("Warnings only"));
    fireEvent.change(view.getByLabelText("Timeline application"), { target: { value: "sample/deployment-b" } });
    fireEvent.click(view.getByLabelText("Warnings only"));
    const selector = view.getByLabelText("Timeline application") as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe(""));
    expect([...selector.options].map((option) => option.value)).toEqual(["", "sample/deployment-a"]);
    fireEvent.change(selector, { target: { value: "sample/deployment-a" } });
    expect(view.getByText("Insufficient cpu")).toBeTruthy();
  });
  it("separates resource navigation from the dedicated expansion control", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Open Deployment sample / app")).toBeTruthy());
    fireEvent.click(view.getByTitle("Open Deployment sample / app"));
    expect(state.navigate).toHaveBeenCalledWith("/apis/apps/v1/namespaces/sample/deployments/app");
    expect(view.queryByText("worker")).toBeNull();
    const expand = view.getByTitle("Expand pods");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);
    expect(view.getByText("worker")).toBeTruthy();
    expect(view.getByText("worker").closest("tr")?.getAttribute("data-row-depth")).toBe("1");
    expect(view.getByTitle("Collapse pods").getAttribute("aria-expanded")).toBe("true");
  });
  it("defaults to known problems and offers a neutral way to show unknown consumers", async () => {
    const current = snapshot();
    current.pods[0].status.phase = "Running";
    state.get.mockResolvedValue(current);
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByText("No known issues")).toBeTruthy());
    expect((view.getByLabelText("Needs attention") as HTMLInputElement).checked).toBe(true);
    expect(view.container.querySelector(".attention-empty")?.classList.contains("all-ready")).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "Show all consumers" }));
    expect(view.getByTitle("Open Deployment sample / app")).toBeTruthy();
    expect((view.getByLabelText("Needs attention") as HTMLInputElement).checked).toBe(false);
  });

  it("sorts consumers by visible names rather than workload UIDs", async () => {
    const current = snapshot();
    current.owners[0].metadata = { uid: "aaa", name: "zebra", namespace: "sample" };
    current.pods[0].metadata.ownerReferences = [{ uid: "aaa", controller: true }];
    current.owners.push({ kind: "Deployment", metadata: { uid: "zzz", name: "alpha", namespace: "sample" } });
    current.pods.push({
      ...current.pods[0],
      metadata: { ...current.pods[0].metadata, uid: "pod-b", ownerReferences: [{ uid: "zzz", controller: true }] },
    });
    state.get.mockResolvedValue(current);
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Open Deployment sample / alpha")).toBeTruthy());
    fireEvent.change(view.getByLabelText("Sort consumers"), { target: { value: "name" } });
    const rows = [...view.container.querySelectorAll(".consumer-workload-row")];
    expect(rows[0].querySelector(".consumer-resource-link")?.textContent).toContain("alpha");
    expect(rows[1].querySelector(".consumer-resource-link")?.textContent).toContain("zebra");
  });
  it("keeps Diagnostics free of history and tracking actions", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Expand pods")).toBeTruthy());
    fireEvent.click(view.getByTitle("Expand pods"));
    expect(view.queryByRole("button", { name: /history|track/i })).toBeNull();
    expect(view.queryByRole("checkbox", { name: /history/i })).toBeNull();
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.getByText("worker")).toBeTruthy();
  });
  it("defaults Timeline to warnings and offers all events when retained warnings are absent", async () => {
    state.get.mockResolvedValue({ ...snapshot(), events: [] });
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Expand pods")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: /Timeline/ }));
    expect((view.getByLabelText("Warnings only") as HTMLInputElement).checked).toBe(true);
    expect(view.getByText("No retained warning events match these filters")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Show all events" }));
    expect((view.getByLabelText("Warnings only") as HTMLInputElement).checked).toBe(false);
    expect(view.getByRole("option", { name: "sample / Deployment / app" })).toBeTruthy();
  });
  it("shows all retained warnings by default and labels resources from event references", async () => {
    const current = snapshot();
    current.events.push({
      involvedObject: { uid: "removed-second", name: "missing-uid-worker", namespace: "sample" },
      type: "Warning",
      reason: "FailedMount",
      message: "Warning without event UID",
    });
    current.events.push({
      metadata: { uid: "event-removed" },
      involvedObject: { uid: "removed-pod", name: "removed-worker", namespace: "sample", kind: "Pod" },
      type: "Warning",
      reason: "FailedMount",
      message: "Storage is not ready",
    });
    state.get.mockResolvedValue(current);
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Expand pods")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: /Timeline/ }));
    expect((view.getByLabelText("Timeline application") as HTMLSelectElement).value).toBe("");
    expect(view.getByText("Insufficient cpu")).toBeTruthy();
    expect(view.getByText("Storage is not ready")).toBeTruthy();
    expect(view.getByText("Warning without event UID")).toBeTruthy();
    expect(view.getByText("sample / Pod / removed-worker")).toBeTruthy();
    expect(view.queryByText("Other application")).toBeNull();
    fireEvent.click(view.getByLabelText("Warnings only"));
    expect(view.getByText("Other application")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Timeline application"), { target: { value: "sample/deployment-a" } });
    expect(view.queryByText("Storage is not ready")).toBeNull();
    expect(view.getByText("Insufficient cpu")).toBeTruthy();
  });
  it("renders partial coverage, filters consumers and expands exact pod details", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Open Deployment sample / app")).toBeTruthy());
    expect(view.getByText("0/1 pods covered")).toBeTruthy();
    fireEvent.click(view.getByTitle("Expand pods"));
    fireEvent.click(view.getByText("worker"));
    expect(state.navigate).toHaveBeenCalledWith("/api/v1/namespaces/sample/pods/worker");
    fireEvent.change(view.getByLabelText("Filter consumers"), { target: { value: "absent" } });
    expect(view.getByText("No consumers match this filter")).toBeTruthy();
    view.unmount();
    expect(state.release).toHaveBeenCalledTimes(1);
  });
  it("filters timeline by exact application UIDs and shows unknown event times", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Open Deployment sample / app")).toBeTruthy());
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
  it("shows loading and access failures without claiming an empty cluster", async () => {
    let reject: (reason: Error) => void = () => {};
    state.get.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const view = render(<DiagnosticsPage />);
    expect(view.getByText("Loading resource diagnostics…")).toBeTruthy();
    expect(view.queryByText("No consumers available")).toBeNull();
    reject(new Error("Forbidden"));
    await waitFor(() => expect(view.getByText(/Diagnostics unavailable or access denied/)).toBeTruthy());
    expect(view.queryByText("Loading resource diagnostics…")).toBeNull();
    expect(view.queryByText("No consumers available")).toBeNull();
  });
  it("presents a warning as a typed timeline item with exact resource navigation", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Expand pods")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: /Timeline/ }));
    expect(view.getByRole("option", { name: "All applications" })).toBeTruthy();
    fireEvent.change(view.getByLabelText("Timeline application"), { target: { value: "sample/deployment-a" } });
    const event = view.getByText("FailedScheduling").closest("li")!;
    expect(event.classList.contains("warning")).toBe(true);
    expect(event.textContent).toContain("Warning");
    expect(event.textContent).toContain("Time unknown");
    const resourceAction = view.getByRole("button", { name: "Open resource" });
    expect(resourceAction.getAttribute("title")).toBe("Open Pod sample / worker");
    expect(resourceAction.textContent).not.toContain("Open resource");
    const outsideClick = vi.fn();
    document.addEventListener("click", outsideClick);
    fireEvent.click(resourceAction);
    document.removeEventListener("click", outsideClick);
    expect(outsideClick).not.toHaveBeenCalled();
    expect(state.navigate).toHaveBeenCalledWith("/api/v1/namespaces/sample/pods/worker");
    expect(view.getByLabelText("Event types")).toBeTruthy();
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
    expect(view.queryByTitle("Open Deployment sample / app")).toBeNull();
  });
  it("groups namespace totals above expandable workload and pod resource rows", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Open Deployment sample / app")).toBeTruthy());
    fireEvent.change(view.getByLabelText("Group consumers"), { target: { value: "namespace" } });
    expect(view.queryByTitle("Open Deployment sample / app")).toBeNull();
    expect(view.getByText("sample").closest("tr")?.getAttribute("data-row-depth")).toBe("0");
    const namespaceRow = view.getByText("sample").closest("tr")!;
    expect(namespaceRow.querySelector(".namespace-identity .Icon")).toBeTruthy();
    expect(namespaceRow.textContent).toContain("1 filtered consumers");
    expect(namespaceRow.classList.contains("consumer-tone-warning")).toBe(true);
    fireEvent.click(view.getByTitle("Expand namespace workloads"));
    expect(view.getByTitle("Open Deployment sample / app").closest("tr")?.getAttribute("data-row-depth")).toBe("1");
    fireEvent.click(view.getByTitle("Expand pods"));
    expect(view.getByText("worker").closest("tr")?.getAttribute("data-row-depth")).toBe("2");
    const podRow = view.getByText("worker").closest("tr")!;
    expect(podRow.querySelectorAll(".resource-cell").length).toBe(2);
    expect(podRow.textContent).toContain("0.050 cores");
    expect(podRow.textContent).toContain("50% of requests");
    expect(view.getByRole("option", { name: "Memory requests" })).toBeTruthy();
  });
  it("retains exact removed pod identities for a workload during the open view", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Open Deployment sample / app")).toBeTruthy());
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
    expect(view.queryByRole("button", { name: "Open resource" })).toBeNull();
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
    await waitFor(() => expect(view.getByTitle("Expand pods")).toBeTruthy());
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
    fireEvent.click(view.getByLabelText("Warnings only"));
    await waitFor(() => expect(view.getByText("RolloutObserved")).toBeTruthy());
    const row = view.getByText("RolloutObserved").closest("li")!;
    expect(row.textContent).toContain(formatDateTime(diagnosticsTime));
    expect(row.textContent).toContain("generation: 1 → 2");
    expect(row.textContent).toContain("readyReplicas: 0 → 1");
  });
  it("does not reproject an identical shared cached snapshot", async () => {
    const view = render(<DiagnosticsPage />);
    await waitFor(() => expect(view.getByTitle("Expand pods")).toBeTruthy());
    expect(state.usage).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2));
    expect(state.usage).toHaveBeenCalledTimes(1);
    fireEvent.change(view.getByLabelText("Filter consumers"), { target: { value: "sample" } });
    expect(state.usage).toHaveBeenCalledTimes(1);
  });
});

describe("diagnostics navigation state", () => {
  it("restores filters, grouping, expansion, tab and scroll on return", async () => {
    const first = render(<DiagnosticsPage />);
    await waitFor(() => expect(first.getByText("app")).toBeTruthy());
    fireEvent.change(first.getByLabelText("Filter consumers"), { target: { value: "app" } });
    fireEvent.click(first.getByLabelText("Expand pods for app"));
    fireEvent.click(first.getByRole("button", { name: "Timeline" }));
    fireEvent.change(first.getByLabelText("Filter timeline reason"), { target: { value: "cpu" } });
    fireEvent.click(first.getByLabelText("Group recurring warnings"));
    const container = first.container.querySelector(".power-diagnostics")!;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    fireEvent.scroll(container, { target: { scrollTop: 145 } });
    first.unmount();
    const second = render(<DiagnosticsPage />);
    await waitFor(() => expect(second.getByLabelText("Filter timeline reason")).toBeTruthy());
    expect((second.getByLabelText("Filter timeline reason") as HTMLInputElement).value).toBe("cpu");
    expect((second.getByLabelText("Group recurring warnings") as HTMLInputElement).checked).toBe(false);
    await waitFor(() => expect(second.container.querySelector(".power-diagnostics")!.scrollTop).toBe(145));
    fireEvent.click(second.getByRole("button", { name: "Consumers" }));
    expect((second.getByLabelText("Filter consumers") as HTMLInputElement).value).toBe("app");
    expect(second.getByLabelText("Collapse pods for app")).toBeTruthy();
  });
});

it("groups recurring warnings with original evidence and allows chronological entries", async () => {
  const current = snapshot();
  current.events.push({
    ...current.events[0],
    metadata: { uid: "event-b" },
    message: "Insufficient cpu",
    count: 4,
  });
  state.get.mockResolvedValue(current);
  const view = render(<DiagnosticsPage />);
  await waitFor(() => expect(view.getByText("app")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "Timeline" }));
  expect(view.container.querySelectorAll(".timeline-entry")).toHaveLength(1);
  expect(view.getByText("1 affected resources · 2 original entries")).toBeTruthy();
  expect(view.getByText(/Count 5/)).toBeTruthy();
  fireEvent.click(view.getByLabelText("Group recurring warnings"));
  expect(view.container.querySelectorAll(".timeline-entry")).toHaveLength(2);
});

it("restores deep scroll only after async rows and saved expansion have rendered", async () => {
  let resolve!: (value: ReturnType<typeof snapshot>) => void;
  state.get.mockReturnValue(
    new Promise((complete) => {
      resolve = complete;
    }),
  );
  saveDiagnosticsState("sample-cluster", {
    ...readDiagnosticsState("sample-cluster"),
    expanded: ["sample/deployment-a"],
    scrollTop: 420,
  });
  const view = render(<DiagnosticsPage />);
  const container = view.container.querySelector(".power-diagnostics")!;
  const writes: { top: number; rows: number }[] = [];
  let top = 0;
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      const rows = container.querySelectorAll(".consumer-pod-row").length;
      writes.push({ top: value, rows });
      top = rows ? value : 0;
    },
  });
  fireEvent.scroll(container);
  expect(writes).toEqual([]);
  resolve(snapshot());
  await waitFor(() => expect(top).toBe(420));
  expect(writes.every((write) => write.rows === 1 && write.top === 420)).toBe(true);
});

it("scopes namespace links exactly and lets users remove the scope independently of search", async () => {
  const current = snapshot();
  current.pods.push({
    ...current.pods[0],
    metadata: { uid: "pod-other", name: "other", namespace: "sample-extra", ownerReferences: [] },
  });
  state.get.mockResolvedValue(current);
  saveDiagnosticsState("sample-cluster", {
    ...readDiagnosticsState("sample-cluster"),
    namespaceScope: "sample",
    filter: "",
    needsAttention: false,
  });
  const view = render(<DiagnosticsPage />);
  await waitFor(() => expect(view.getByText("app")).toBeTruthy());
  expect(view.queryByText("other")).toBeNull();
  expect(view.getByText("Namespace: sample")).toBeTruthy();
  expect((view.getByLabelText("Filter consumers") as HTMLInputElement).value).toBe("");
  fireEvent.click(view.getByLabelText("Clear namespace scope"));
  expect(view.getByText("other")).toBeTruthy();
  expect(view.queryByText("Namespace: sample")).toBeNull();
});

it("applies namespace focus to a mounted page and retains it after leaving", async () => {
  const view = render(<DiagnosticsPage />);
  await waitFor(() => expect(view.getByText("app")).toBeTruthy());
  fireEvent.change(view.getByLabelText("Filter consumers"), { target: { value: "unrelated" } });
  fireEvent.click(view.getByRole("button", { name: "Timeline" }));
  act(() => focusDiagnosticsNamespace("other-cluster", "other"));
  expect(view.queryByText("Namespace: other")).toBeNull();
  act(() => focusDiagnosticsNamespace("sample-cluster", "sample"));
  expect(view.getByText("Namespace: sample")).toBeTruthy();
  expect((view.getByLabelText("Filter consumers") as HTMLInputElement).value).toBe("");
  expect((view.getByLabelText("Group consumers") as HTMLSelectElement).value).toBe("namespace");
  expect(view.getByText("app")).toBeTruthy();
  view.unmount();
  expect(readDiagnosticsState("sample-cluster").namespaceScope).toBe("sample");
  expect(readDiagnosticsState("sample-cluster").tab).toBe("Consumers");
});

it("copies only the selected pending pod finding and its evidence", async () => {
  const { clipboard } = await import("electron");
  const view = render(<DiagnosticsPage />);
  await waitFor(() => expect(view.getByRole("button", { name: "Inspect pending pods" })).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "Inspect pending pods" }));
  fireEvent.click(view.getByLabelText("Copy incident summary"));
  const text = vi.mocked(clipboard.writeText).mock.calls.at(-1)![0];
  expect(text).toContain("Problem: Pending pod");
  expect(text).toContain("Insufficient cpu");
  expect(text).toContain("/api/v1/namespaces/sample/pods/worker");
  expect(text).not.toContain("Other application");
  expect(view.getByText("Copied")).toBeTruthy();
});

it("distinguishes completed consumers from active readiness and unknown state", () => {
  const completed = { metadata: {}, status: { phase: "Succeeded", conditions: [{ type: "Ready", status: "False" }] } };
  const ready = { metadata: {}, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } };
  const unknown = { metadata: {}, status: { phase: "Running", conditions: [{ type: "Ready", status: "Unknown" }] } };
  expect(consumerStatus([completed])).toEqual({ tone: "healthy", label: "Completed", icon: "check_circle" });
  expect(consumerStatus([completed, ready])).toMatchObject({ tone: "healthy", label: "Ready / Completed" });
  expect(consumerStatus([completed, unknown])).toMatchObject({ tone: "neutral", label: "Readiness unknown" });
  expect(consumerStatus([completed, { metadata: {}, status: { phase: "Pending" } }])).toMatchObject({
    tone: "warning",
    label: "1 Pending",
  });
  expect(
    consumerStatus([
      completed,
      { metadata: {}, status: { phase: "Running", conditions: [{ type: "Ready", status: "False" }] } },
    ]),
  ).toMatchObject({ tone: "warning", label: "Not ready" });
  expect(consumerStatus([completed, { metadata: {}, status: { phase: "Failed" } }])).toMatchObject({
    tone: "error",
    label: "Failed",
  });
});

it("places Timeline resource, copy and AI actions together beside the heading", async () => {
  const view = render(<DiagnosticsPage />);
  await waitFor(() => expect(view.getByText("app")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "Timeline" }));
  const actions = view.getByRole("group", { name: "Event actions" });
  expect(actions.closest(".timeline-card-top")?.querySelector(".timeline-card-heading")?.textContent).toContain(
    "FailedScheduling",
  );
  expect(actions.querySelectorAll("button")).toHaveLength(3);
  expect(view.getByLabelText("Open resource").parentElement).toBe(actions);
  expect(view.getByLabelText("Copy incident summary").closest(".timeline-card-actions")).toBe(actions);
  expect(view.getByLabelText("Explain with AI").parentElement).toBe(actions);
  expect(view.getAllByLabelText("Copy incident summary")).toHaveLength(1);
  fireEvent.click(view.getByLabelText("Copy incident summary"));
  const { clipboard } = await import("electron");
  expect(vi.mocked(clipboard.writeText).mock.calls.at(-1)![0]).toContain("Insufficient cpu");
});
