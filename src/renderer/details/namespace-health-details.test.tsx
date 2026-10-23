// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ release: vi.fn(), get: vi.fn() }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: "cluster" } }) } },
    Component: {
      DrawerItem: ({ name, children }: any) => (
        <div>
          {name}: {children}
        </div>
      ),
    },
  },
}));
vi.mock("./resource-health-details", () => ({
  ResourceHealthDetails: ({ onOpenDiagnostics }: any) => <button onClick={onOpenDiagnostics}>Diagnostics</button>,
}));
vi.mock("../monitoring-collector", () => ({
  getMonitoringSnapshot: state.get,
  retainMonitoringCollector: () => state.release,
}));

import { NamespaceHealthDetails } from "./namespace-health-details";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("limits totals to non-terminal namespace pods and releases collector on close", async () => {
  const pod = (namespace: string, phase: string) => ({
    getNs: () => namespace,
    spec: { containers: [{ resources: { requests: { cpu: "100m", memory: "16Mi" } } }] },
    status: { phase, conditions: [{ type: "Ready", status: "True" }] },
  });
  state.get.mockResolvedValue({
    clusterId: "cluster",
    time: Date.now(),
    errors: [],
    pods: [pod("team", "Running"), pod("team", "Succeeded"), pod("other", "Running")],
  });
  const open = vi.fn();
  const view = render(<NamespaceHealthDetails object={{ getName: () => "team" } as any} onOpenDiagnostics={open} />);
  await waitFor(() => expect(screen.getByText("Pod requests: 0.10 CPU cores · 16 MiB memory")).toBeTruthy());
  expect(screen.getByText("Pod coverage: 2 visible pods · 1 non-terminal")).toBeTruthy();
  fireEvent.click(screen.getByText("Diagnostics"));
  expect(open).toHaveBeenCalledWith("team");
  expect(open).toHaveBeenCalledOnce();
  view.unmount();
  expect(state.release).toHaveBeenCalledOnce();
});
it("keeps missing pod inventory distinct from an empty namespace", async () => {
  state.get.mockResolvedValue({ clusterId: "cluster", time: Date.now(), errors: ["Pods unavailable"] });
  render(<NamespaceHealthDetails object={{ getName: () => "team" } as any} />);
  await waitFor(() => expect(screen.getByText("Pod coverage: Unavailable or access denied")).toBeTruthy());
  expect(screen.queryByText(/Pod requests:/)).toBeNull();
});
