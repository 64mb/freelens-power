import { expect, it } from "vitest";
import { formatIncidentSummary, incidentResourcePath } from "./incident-summary";

it("copies selected evidence, explicit timezone and validated resource detail paths", () => {
  const result = formatIncidentSummary({
    problem: "Pending pod",
    facts: ["Insufficient cpu"],
    time: "2026-01-01T12:00:00Z",
    resources: [{ kind: "Pod", namespace: "sample", name: "worker" }],
  });
  expect(result).toContain("Problem: Pending pod");
  expect(result).toContain("Insufficient cpu");
  expect(result).toMatch(/UTC[+-]\d{2}:\d{2}/);
  expect(result).toContain("/api/v1/namespaces/sample/pods/worker");
  expect(incidentResourcePath({ kind: "Secret", namespace: "sample", name: "credentials" })).toBeUndefined();
  expect(incidentResourcePath({ kind: "Pod", namespace: "sample", name: "../worker" })).toBeUndefined();
});
it("preserves ordinary facts while bounding selected facts and resources", () => {
  const result = formatIncidentSummary({
    problem: "x".repeat(500),
    facts: ["password: private-value", ...Array(20).fill("e".repeat(1000))],
    resources: Array.from({ length: 20 }, (_, index) => ({
      kind: "Pod",
      namespace: "sample",
      name: `worker-${index}`,
    })),
  });
  expect(result).toContain("password: private-value");
  expect(result.length).toBeLessThanOrEqual(8000);
  expect(result).not.toContain("worker-12");
  expect(result).toContain("Snapshot time: Unavailable");
});

it("bounds and preserves the optional cluster display name", () => {
  const redacted = formatIncidentSummary({ problem: "Pending", facts: [], clusterName: "token: confidential" });
  expect(redacted).toContain("Cluster: token: confidential");
  const bounded = formatIncidentSummary({ problem: "Pending", facts: [], clusterName: "c".repeat(300) });
  expect(bounded.split("\n").find((line) => line.startsWith("Cluster: "))).toHaveLength(169);
});

it("maps supported cluster-scoped resources and rejects namespace mismatches", () => {
  for (const [kind, plural] of [
    ["Node", "nodes"],
    ["Namespace", "namespaces"],
    ["PersistentVolume", "persistentvolumes"],
  ]) {
    expect(incidentResourcePath({ kind, name: "sample" })).toBe(`/api/v1/${plural}/sample`);
    expect(incidentResourcePath({ kind, name: "sample", namespace: "sample" })).toBeUndefined();
    expect(incidentResourcePath({ kind, name: "sample", namespace: "" })).toBeUndefined();
  }
});
it("maps supported namespaced API versions without inventing custom resource routes", () => {
  for (const [kind, prefix, plural] of [
    ["Service", "/api/v1", "services"],
    ["PersistentVolumeClaim", "/api/v1", "persistentvolumeclaims"],
    ["HorizontalPodAutoscaler", "/apis/autoscaling/v2", "horizontalpodautoscalers"],
    ["Ingress", "/apis/networking.k8s.io/v1", "ingresses"],
    ["EndpointSlice", "/apis/discovery.k8s.io/v1", "endpointslices"],
  ]) {
    expect(incidentResourcePath({ kind, name: "sample", namespace: "sample" })).toBe(
      `${prefix}/namespaces/sample/${plural}/sample`,
    );
    expect(incidentResourcePath({ kind, name: "sample" })).toBeUndefined();
  }
  for (const kind of ["CustomWorkload", "Secret", "ConfigMap", "constructor", "toString"])
    expect(incidentResourcePath({ kind, name: "sample", namespace: "sample" })).toBeUndefined();
});
