import { expect, it } from "vitest";
import { buildResourceRelationships } from "../common/resource-relationships";
import { relationshipMapFinding } from "./relationship-map-finding";

it("attaches the visible relationship map while excluding resource payloads and hidden upstreams", () => {
  const graph = buildResourceRelationships(
    { metadata: { name: "example", namespace: "sample" }, spec: { selector: { app: "example" }, ports: [] } },
    {
      pods: [],
      slices: [],
      ingresses: [
        {
          metadata: { name: "entry", namespace: "sample" },
          spec: { defaultBackend: { service: { name: "example" } } },
        },
      ],
    },
  );
  graph.nodes[0].selfLink = "/must-not-be-attached";
  const full = relationshipMapFinding("cluster-a", "sample", "example", graph, false);
  const snapshot = JSON.parse(full.summary);
  expect(full.source).toBe("relationships");
  expect(snapshot.nodes.map((node: { id: string }) => node.id)).toEqual(graph.nodes.map((node) => node.id));
  expect(snapshot.edges).toHaveLength(graph.edges.length);
  expect(full.summary).not.toContain("must-not-be-attached");
  const hidden = JSON.parse(relationshipMapFinding("cluster-a", "sample", "example", graph, true).summary);
  expect(hidden.nodes.every((node: { role: string }) => node.role !== "upstream")).toBe(true);
  const ids = new Set(hidden.nodes.map((node: { id: string }) => node.id));
  expect(hidden.edges.every((edge: { from: string; to: string }) => ids.has(edge.from) && ids.has(edge.to))).toBe(true);
});
