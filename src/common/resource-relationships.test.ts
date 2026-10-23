import { describe, expect, it } from "vitest";
import { buildResourceRelationships, relationshipReferencePath } from "./resource-relationships";

const service = { metadata: { name: "web", namespace: "sample" }, spec: { selector: { app: "web" } } };
const pod = {
  metadata: {
    uid: "pod-1",
    name: "web-1",
    namespace: "sample",
    labels: { app: "web" },
    ownerReferences: [{ uid: "rs-1", name: "web-replica", kind: "ReplicaSet", controller: true }],
  },
  spec: { nodeName: "worker" },
};
describe("resource relationship evidence", () => {
  it("deduplicates a shared controller edge while retaining each pod ownership edge", () => {
    const graph = buildResourceRelationships(service, {
      pods: [pod, { ...pod, metadata: { ...pod.metadata, uid: "pod-2", name: "web-2" } }],
      owners: [
        {
          metadata: {
            uid: "rs-1",
            namespace: "sample",
            ownerReferences: [{ uid: "deploy-1", name: "workload", kind: "Deployment" }],
          },
        },
      ],
    });
    expect(graph.edges.filter((edge) => edge.from === "owner/rs-1" && edge.to === "owner/deploy-1")).toHaveLength(1);
    expect(graph.edges.filter((edge) => edge.label === "owned by" && edge.to === "owner/rs-1")).toHaveLength(2);
  });
  it("links cluster-scoped owner references without inventing a namespace", () => {
    const graph = buildResourceRelationships(service, {
      pods: [
        {
          ...pod,
          metadata: { ...pod.metadata, ownerReferences: [{ uid: "node-owner", name: "worker", kind: "Node" }] },
        },
      ],
    });
    expect(graph.nodes.find((node) => node.id === "owner/node-owner")?.selfLink).toBe("/api/v1/nodes/worker");
  });
  it("distinguishes completed, failed, pending and unknown pod evidence", () => {
    for (const [phase, readiness, detail, tone] of [
      ["Succeeded", "False", "Completed", "healthy"],
      ["Failed", "False", "Failed", "warning"],
      ["Pending", "Unknown", "Pending", "warning"],
      ["Running", "Unknown", "Ready: Unknown", "neutral"],
    ]) {
      const graph = buildResourceRelationships(service, {
        pods: [{ ...pod, status: { phase, conditions: [{ type: "Ready", status: readiness }] } }],
      });
      const backend = graph.nodes.find((node) => node.kind === "Pod");
      expect(backend?.detail).toBe(detail);
      expect(backend?.tone).toBe(tone);
    }
  });
  it("does not draw pod, owner, node or EndpointSlice edges for ExternalName", () => {
    const graph = buildResourceRelationships(
      { ...service, spec: { ...service.spec, type: "ExternalName" } },
      {
        pods: [pod],
        slices: [
          {
            metadata: { name: "published", namespace: "sample", labels: { "kubernetes.io/service-name": "web" } },
            addressType: "IPv4",
            endpoints: [],
          },
        ],
      },
    );
    expect(graph.edges).toHaveLength(0);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.podOptions).toEqual([]);
    expect(graph.diagnostics.summary).toContain("DNS");
    expect(graph.nodes[0].tone).toBe("neutral");
  });
  it("links selectors, ingress, owner chains and assignment without inventing health", () => {
    const graph = buildResourceRelationships(service, {
      pods: [pod],
      slices: [],
      ingresses: [
        {
          metadata: { name: "route", namespace: "sample" },
          spec: { rules: [{ http: { paths: [{ backend: { service: { name: "web" } } }] } }] },
        },
      ],
      owners: [
        {
          metadata: {
            uid: "rs-1",
            namespace: "sample",
            ownerReferences: [{ uid: "deploy-1", name: "web", kind: "Deployment", controller: true }],
          },
        },
      ],
    });
    expect(graph.edges.map((edge) => edge.label)).toEqual([
      "references backend",
      "selector matches",
      "assigned to",
      "owned by",
      "owned by",
    ]);
    expect(graph.nodes.find((node) => node.kind === "Pod")?.tone).toBe("neutral");
    expect(graph.nodes.find((node) => node.kind === "Node")?.inferred).toBe(true);
    expect(graph.nodes.find((node) => node.kind === "Deployment")?.detail).toContain("reference only");
  });
  it("does not claim absent relationships when an inventory is unavailable", () => {
    const graph = buildResourceRelationships(service, {});
    expect(graph.edges).toHaveLength(0);
    expect(graph.gaps.join(" ")).toContain("relationships are unknown");
    expect(graph.diagnostics.summary).toContain("Partial evidence");
  });
  it("bounds backend nodes and lets focus reach an omitted pod", () => {
    const pods = Array.from({ length: 20 }, (_, index) => ({
      ...pod,
      metadata: { ...pod.metadata, uid: `pod-${index}`, name: `web-${index}` },
    }));
    const graph = buildResourceRelationships(service, { pods, slices: [], ingresses: [] });
    expect(graph.nodes.filter((node) => node.kind === "Pod")).toHaveLength(8);
    expect(graph.omitted).toBe(12);
    expect(buildResourceRelationships(service, { pods }, "web-19").nodes.some((node) => node.name === "web-19")).toBe(
      true,
    );
  });
  it("ignores cross-namespace selectors and ingress references", () => {
    const graph = buildResourceRelationships(service, {
      pods: [{ ...pod, metadata: { ...pod.metadata, namespace: "other" } }],
      ingresses: [{ metadata: { namespace: "other" }, spec: { defaultBackend: { service: { name: "web" } } } }],
    });
    expect(graph.edges).toHaveLength(0);
  });
  it("creates only supported reference paths", () => {
    expect(relationshipReferencePath("Unknown", "item", "sample")).toBeUndefined();
    expect(relationshipReferencePath("constructor", "item", "sample")).toBeUndefined();
    expect(relationshipReferencePath("toString", "item", "sample")).toBeUndefined();
    expect(relationshipReferencePath("Pod", "web")).toBeUndefined();
    expect(relationshipReferencePath("Pod", "invalid/name", "sample")).toBeUndefined();
    expect(relationshipReferencePath("Node", "worker", "sample")).toBeUndefined();
    expect(relationshipReferencePath("Node", "worker")).toBe("/api/v1/nodes/worker");
  });
});
