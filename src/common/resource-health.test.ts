import { describe, expect, it } from "vitest";
import { summarizeObjectHealth } from "./resource-health";

describe("resource health summary", () => {
  it("keeps pod phase distinct from readiness and includes init restarts", () => {
    const result = summarizeObjectHealth({
      kind: "Pod",
      metadata: {},
      spec: { containers: [{}] },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady" }],
        containerStatuses: [{ name: "app", restartCount: 2, ready: false }],
        initContainerStatuses: [{ name: "init", restartCount: 1 }],
      },
    });
    expect(result.state).toBe("warning");
    expect(result.rows).toContainEqual({ name: "Phase", value: "Running" });
    expect(result.rows).toContainEqual({ name: "Readiness", value: "Not ready" });
    expect(result.rows).toContainEqual({ name: "Restarts", value: "3" });
    expect(result.issue).toBe("ContainersNotReady");
  });
  it("does not flag successfully completed pods as unhealthy", () => {
    expect(
      summarizeObjectHealth({
        kind: "Pod",
        metadata: {},
        status: { phase: "Succeeded", conditions: [{ type: "Ready", status: "False" }] },
      }).state,
    ).toBe("healthy");
  });
  it.each(["Pod", "Node"])("preserves tri-state readiness for %s", (kind) => {
    for (const [conditionStatus, state, label] of [
      ["True", "healthy", "Ready"],
      ["False", "warning", "Not ready"],
      ["Unknown", "unknown", "Readiness unknown"],
      [undefined, "unknown", "Readiness unknown"],
    ] as const) {
      const result = summarizeObjectHealth({
        kind,
        metadata: {},
        status: { conditions: conditionStatus ? [{ type: "Ready", status: conditionStatus }] : [] },
      });
      expect(result.state).toBe(state);
      expect(result.rows).toContainEqual({ name: "Readiness", value: label });
      if (state === "unknown") expect(result.issue).toBeUndefined();
    }
  });
  it("labels succeeded pods as completed regardless of readiness condition", () => {
    for (const conditionStatus of ["False", "Unknown", undefined]) {
      const result = summarizeObjectHealth({
        kind: "Pod",
        metadata: {},
        status: { phase: "Succeeded", conditions: conditionStatus ? [{ type: "Ready", status: conditionStatus }] : [] },
      });
      expect(result.state).toBe("healthy");
      expect(result.rows).toContainEqual({ name: "Readiness", value: "Completed" });
      expect(result.issue).toBeUndefined();
    }
  });
  it("requires the controller to observe the latest generation", () => {
    expect(
      summarizeObjectHealth({
        kind: "Deployment",
        metadata: { generation: 3 },
        spec: { replicas: 2 },
        status: { observedGeneration: 2, readyReplicas: 2 },
      }).issue,
    ).toContain("latest generation");
  });
  it("supports scaled to zero controllers and daemonset scheduling counts", () => {
    expect(summarizeObjectHealth({ kind: "StatefulSet", metadata: {}, spec: { replicas: 0 }, status: {} }).state).toBe(
      "healthy",
    );
    expect(
      summarizeObjectHealth({ kind: "DaemonSet", metadata: {}, status: { desiredNumberScheduled: 3, numberReady: 2 } })
        .rows,
    ).toContainEqual({ name: "Ready replicas", value: "2/3" });
  });
  it("reports node pressure even when the node is ready", () => {
    expect(
      summarizeObjectHealth({
        kind: "Node",
        metadata: {},
        status: {
          conditions: [
            { type: "Ready", status: "True" },
            { type: "DiskPressure", status: "True" },
          ],
        },
      }).issue,
    ).toBe("DiskPressure");
  });
  it("does not infer healthy state from unavailable status", () => {
    for (const kind of ["Pod", "Deployment", "StatefulSet", "DaemonSet", "Node", "Namespace"])
      expect(summarizeObjectHealth({ kind, metadata: {} }).state).toBe("unknown");
  });
});
