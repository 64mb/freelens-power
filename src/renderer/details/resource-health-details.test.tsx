// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const showDetails = vi.hoisted(() => vi.fn());
const ai = vi.hoisted(() => ({ enabled: true, clusterId: "cluster", explain: vi.fn() }));
vi.mock("../../common/store/ai-preferences-store", () => ({ AiPreferencesStore: { getInstanceOrCreate: () => ai } }));
vi.mock("../ai-diagnostic-handoff", () => ({ explainDiagnosticFinding: ai.explain }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Component: {
      DrawerTitle: ({ children }: any) => <h2>{children}</h2>,
      DrawerItem: ({ name, children }: any) => (
        <div>
          {name}: {children}
        </div>
      ),
      Button: ({ children, ...props }: any) => (
        <button type="button" {...props}>
          {children}
        </button>
      ),
      Icon: () => null,
    },
    Catalog: { activeCluster: { get: () => (ai.clusterId ? { metadata: { uid: ai.clusterId } } : undefined) } },
    Navigation: { showDetails },
    K8sApi: {
      namespacesApi: { getUrl: ({ name }: any) => `/api/v1/namespaces/${name}` },
      nodesApi: { getUrl: ({ name }: any) => `/api/v1/nodes/${name}` },
    },
  },
}));

import { ResourceHealthDetails } from "./resource-health-details";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  ai.enabled = true;
  ai.clusterId = "cluster";
});
it("keeps phase and readiness visible and links only related resources", () => {
  const onOpenDiagnostics = vi.fn();
  render(
    <ResourceHealthDetails
      object={
        {
          kind: "Pod",
          metadata: { name: "worker", namespace: "team" },
          spec: { nodeName: "worker-node", containers: [{}] },
          status: { phase: "Running", conditions: [{ type: "Ready", status: "False" }] },
          getNs: () => "team",
        } as any
      }
      onOpenDiagnostics={onOpenDiagnostics}
    />,
  );
  expect(screen.getByText("Phase: Running")).toBeTruthy();
  expect(screen.getByText("Readiness: Not ready")).toBeTruthy();
  fireEvent.click(screen.getByText("team"));
  expect(showDetails).toHaveBeenCalledWith("/api/v1/namespaces/team");
  fireEvent.click(screen.getByText("worker-node"));
  expect(showDetails).toHaveBeenCalledWith("/api/v1/nodes/worker-node");
  fireEvent.click(screen.getByRole("button", { name: "Open Diagnostics" }));
  expect(onOpenDiagnostics).toHaveBeenCalledOnce();
  expect(onOpenDiagnostics).toHaveBeenCalledWith("team", { kind: "Pod", name: "worker", uid: undefined });
});

it("attaches bounded operational evidence and identity only after Ask AI is clicked", () => {
  render(
    <ResourceHealthDetails
      object={
        {
          kind: "Pod",
          metadata: { name: "worker", namespace: "team", annotations: { private: "hidden-value" } },
          spec: { containers: [{ env: [{ name: "PRIVATE", value: "hidden-value" }] }] },
          status: { phase: "Running", conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady" }] },
          getName: () => "worker",
          getNs: () => "team",
        } as any
      }
    />,
  );
  expect(ai.explain).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
  expect(ai.explain).toHaveBeenCalledOnce();
  const finding = ai.explain.mock.calls[0][0];
  expect(finding.clusterId).toBe("cluster");
  expect(finding.resource).toEqual({ kind: "Pod", name: "worker", namespace: "team" });
  expect(finding.summary).toContain("Phase: Running");
  expect(finding.summary).toContain("Key issue: ContainersNotReady");
  expect(JSON.stringify(finding)).not.toContain("hidden-value");
  expect(finding.summary.length).toBeLessThanOrEqual(6000);
});
it.each(["AI disabled", "missing cluster"])("blocks Ask AI for %s", (guard) => {
  ai.enabled = guard !== "AI disabled";
  ai.clusterId = guard === "missing cluster" ? "" : "cluster";
  render(
    <ResourceHealthDetails
      object={{ kind: "Pod", metadata: {}, getName: () => "worker", getNs: () => "team" } as any}
    />,
  );
  const button = screen.getByRole("button", { name: "Ask AI" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(ai.explain).not.toHaveBeenCalled();
});
