import { describe, expect, it } from "vitest";
import {
  buildConsumerGroups,
  type DiagnosticsObject,
  diagnosePendingPod,
  effectivePodResource,
  normalizeEvents,
  observeResourceChanges,
} from "./resource-diagnostics";

const pod = (uid: string, nodeName?: string): DiagnosticsObject => ({
  kind: "Pod",
  metadata: { uid, name: uid, namespace: "sample" },
  spec: { nodeName, containers: [{ resources: { requests: { cpu: "100m", memory: "1Mi" } } }] },
  status: { phase: "Pending" },
});
describe("resource diagnostics", () => {
  it("follows owner UIDs through replicasets and separates namespaces and unscheduled requests", () => {
    const first = pod("first", "node");
    const second = pod("second");
    first.metadata.ownerReferences = [{ uid: "rs", controller: true }];
    second.metadata.ownerReferences = [{ uid: "rs", controller: true }];
    const groups = buildConsumerGroups(
      [first, second, pod("alone")],
      [
        {
          kind: "ReplicaSet",
          metadata: { uid: "rs", namespace: "sample", ownerReferences: [{ uid: "deployment", controller: true }] },
        },
        { kind: "Deployment", metadata: { uid: "deployment", name: "app", namespace: "sample" } },
      ],
      [{ uid: "first", cpu: 0.04 }],
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      identity: "deployment",
      kind: "Deployment",
      cpu: { requests: 0.2, scheduledRequests: 0.1, unscheduledRequests: 0.1, usage: 0.04, coveredPods: 1 },
      memory: { coveredPods: 0 },
    });
    expect(groups[1].identity).toBe("alone");
  });
  it("does not associate by labels or reuse recreated owner names", () => {
    const first = pod("first");
    first.metadata.ownerReferences = [{ uid: "deleted", kind: "Deployment", name: "app" }];
    expect(
      buildConsumerGroups(
        [first],
        [{ kind: "Deployment", metadata: { uid: "new", name: "app", namespace: "sample" } }],
      )[0],
    ).toMatchObject({ identity: "deleted", ownerResolved: false });
  });
  it("accounts for restartable init containers, limits defaulting, overhead and pod requests", () => {
    const item = pod("example");
    item.spec!.containers = [{ resources: { limits: { cpu: "200m" } } }];
    item.spec!.initContainers = [
      { restartPolicy: "Always", resources: { requests: { cpu: "100m" } } },
      { resources: { requests: { cpu: "500m" } } },
    ];
    item.spec!.overhead = { cpu: "50m" };
    expect(effectivePodResource(item, "cpu")).toBeCloseTo(0.65);
    item.spec!.resources = { requests: { cpu: "1" } };
    expect(effectivePodResource(item, "cpu")).toBe(1.05);
  });
  it("distinguishes assigned waiting and associates event evidence only by UID", () => {
    const item = pod("example", "node");
    const result = diagnosePendingPod(
      item,
      [],
      [
        { involvedObject: { uid: "other", name: "example" }, reason: "FailedScheduling" },
        { regarding: { uid: "example" }, reason: "FailedMount" },
      ],
    );
    expect(result.state).toBe("assigned-waiting");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].message).toContain("FailedMount");
  });
  it("reports provable node exclusions and explicitly leaves complex placement unknown", () => {
    const item = pod("example");
    item.spec!.nodeSelector = { pool: "compute" };
    item.spec!.affinity = { podAntiAffinity: {} };
    const node: DiagnosticsObject = {
      metadata: { name: "node", labels: { pool: "other" } },
      spec: { taints: [{ key: "dedicated", effect: "NoSchedule" }] },
      status: { allocatable: { cpu: "50m" } },
    };
    const result = diagnosePendingPod(item, [node]);
    expect(result.evidence.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        "Node selector does not match",
        "Untolerated taint dedicated (NoSchedule)",
        "Pod cpu request exceeds node allocatable",
      ]),
    );
    expect(result.limitations.join(" ")).toContain("not establish exact schedulability");
    expect(result.limitations.join(" ")).toContain("not evaluated");
  });
  it("normalizes event series without fabricating timestamps", () => {
    expect(
      normalizeEvents([
        {
          reason: "Waiting",
          series: { count: 4, lastObservedTime: "2026-01-01T00:00:00Z" },
          firstTimestamp: "2025-12-31T23:00:00Z",
        },
        { reason: "Unknown" },
      ]),
    ).toMatchObject([
      { count: 4, time: "2026-01-01T00:00:00Z", firstTime: "2025-12-31T23:00:00Z", certainty: "reported" },
      { time: undefined, certainty: "unknown" },
    ]);
  });
  it("records observed restarts and rollout changes with snapshot gaps", () => {
    const before = pod("example");
    before.status!.containerStatuses = [{ name: "app", restartCount: 0, ready: false }];
    const after = structuredClone(before);
    after.status!.containerStatuses = [{ name: "app", restartCount: 2, ready: true }];
    const workload: DiagnosticsObject = {
      kind: "Deployment",
      metadata: { uid: "deployment", name: "app", generation: 1 },
      status: { readyReplicas: 0 },
    };
    const updated = structuredClone(workload);
    updated.metadata.generation = 2;
    updated.status!.readyReplicas = 1;
    const entries = observeResourceChanges([before, workload], [after, updated], "2026-01-01T00:00:00Z");
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.certainty === "observed" && !!entry.gap)).toBe(true);
    expect(entries.find((entry) => entry.reason === "RolloutObserved")?.message).toContain("generation: 1 → 2");
  });
});
