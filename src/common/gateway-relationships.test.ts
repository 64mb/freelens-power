import { expect, it } from "vitest";
import { type GatewayInventory, type GatewayObject, gatewayRelationships } from "./gateway-relationships";

const route: GatewayObject = {
  kind: "HTTPRoute",
  metadata: { name: "web", namespace: "edge", generation: 3 },
  spec: {
    parentRefs: [{ name: "entry", namespace: "infra", sectionName: "https" }],
    rules: [{ backendRefs: [{ name: "web", namespace: "app", weight: 25 }] }],
  },
  status: {
    parents: [
      {
        parentRef: { name: "entry", namespace: "infra", sectionName: "https" },
        controllerName: "example.test/controller",
        conditions: [{ type: "Accepted", status: "True", observedGeneration: 2 }],
      },
    ],
  },
};
const gateway: GatewayObject = {
  kind: "Gateway",
  metadata: { name: "entry", namespace: "infra" },
  spec: {
    listeners: [{ name: "https", port: 443, protocol: "HTTPS", allowedRoutes: { namespaces: { from: "All" } } }],
  },
};
const service = { metadata: { name: "web", namespace: "app" } };
it("keeps spec references separate from stale parent acceptance and backend grants", () => {
  const graph = gatewayRelationships(service, { objects: [route, gateway], gaps: [] });
  expect(graph.nodes.find((node) => node.kind === "HTTPRoute")?.detail).toContain("weight 25");
  expect(graph.nodes.find((node) => node.kind === "HTTPRoute")?.detail).toContain("ReferenceGrant unknown");
  expect(graph.edges.find((edge) => edge.to.includes("HTTPRoute"))?.evidence).toContain("stale/unknown generation");
  expect(graph.edges.find((edge) => edge.to.includes("HTTPRoute"))?.evidence).toContain("permits all namespaces");
});
it("validates cross-namespace backend grants in the target namespace", () => {
  const inventory: GatewayInventory = {
    objects: [route, gateway],
    gaps: [],
    grants: [
      {
        kind: "ReferenceGrant",
        metadata: { name: "backend", namespace: "app" },
        spec: {
          from: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute", namespace: "edge" }],
          to: [{ group: "", kind: "Service", name: "web" }],
        },
      },
    ],
  };
  expect(gatewayRelationships(service, inventory).nodes.find((node) => node.kind === "HTTPRoute")?.detail).toContain(
    "ReferenceGrant permits backend",
  );
  inventory.grants![0].metadata.namespace = "edge";
  expect(gatewayRelationships(service, inventory).nodes.find((node) => node.kind === "HTTPRoute")?.detail).toContain(
    "not permitted",
  );
});
it("uses allowedRoutes rather than grants for parent attachment and honors namespace expressions", () => {
  const entry: GatewayObject = {
    ...gateway,
    spec: {
      listeners: [
        {
          name: "https",
          port: 443,
          protocol: "HTTPS",
          allowedRoutes: {
            namespaces: {
              from: "Selector",
              selector: { matchExpressions: [{ key: "team", operator: "In", values: ["web"] }] },
            },
          },
        },
      ],
    },
  };
  const inventory: GatewayInventory = {
    objects: [route, entry],
    gaps: [],
    namespaces: [{ kind: "Namespace", metadata: { name: "edge", labels: { team: "web" } } }],
  };
  expect(
    gatewayRelationships(service, inventory).edges.find((edge) => edge.to.includes("HTTPRoute"))?.evidence,
  ).toContain("selector matches");
  inventory.namespaces = undefined;
  expect(
    gatewayRelationships(service, inventory).edges.find((edge) => edge.to.includes("HTTPRoute"))?.evidence,
  ).toContain("selector unknown");
});
it.each([
  ["TCPRoute", "TCP"],
  ["TLSRoute", "TLS"],
  ["UDPRoute", "UDP"],
])("connects installed %s backend references and protocol listeners", (kind, protocol) => {
  const stream: GatewayObject = { ...route, kind };
  const entry: GatewayObject = {
    ...gateway,
    spec: { listeners: [{ name: "https", port: 443, protocol, allowedRoutes: { namespaces: { from: "All" } } }] },
  };
  const graph = gatewayRelationships(service, { objects: [stream, entry], gaps: [] });
  expect(graph.nodes.some((node) => node.kind === kind)).toBe(true);
  expect(graph.edges.some((edge) => edge.to === "service")).toBe(true);
  expect(graph.edges.find((edge) => edge.to.includes(kind))?.evidence).toContain("permits all namespaces");
});
it("keeps unseen backend grant namespaces unknown after namespace fallback", () => {
  const graph = gatewayRelationships(service, { objects: [route], grants: [], grantNamespaces: ["other"], gaps: [] });
  expect(graph.nodes[0].detail).toContain("ReferenceGrant unknown");
});
it("does not borrow conditions from a same-named parent in another group or kind", () => {
  const object: GatewayObject = {
    ...route,
    status: {
      parents: [
        {
          parentRef: { ...route.status!.parents![0].parentRef, group: "other.test", kind: "Gateway" },
          conditions: [{ type: "Accepted", status: "True", reason: "UnrelatedGroup" }],
        },
        {
          parentRef: { ...route.status!.parents![0].parentRef, kind: "Service" },
          conditions: [{ type: "Accepted", status: "True", reason: "UnrelatedKind" }],
        },
      ],
    },
  };
  const edge = gatewayRelationships(service, { objects: [object, gateway], gaps: [] }).edges.find((edge) =>
    edge.to.includes("HTTPRoute"),
  );
  expect(edge?.evidence).toContain("acceptance unknown");
  expect(edge?.evidence).not.toContain("Unrelated");
});
it("reports truncated parent and listener fanout", () => {
  const object: GatewayObject = {
    ...route,
    spec: { ...route.spec, parentRefs: [{ name: "entry", namespace: "infra" }] },
  };
  const entry: GatewayObject = {
    ...gateway,
    spec: {
      listeners: Array.from({ length: 7 }, (_, index) => ({ name: `listener-${index}`, port: 443, protocol: "HTTPS" })),
    },
  };
  expect(gatewayRelationships(service, { objects: [object, entry], gaps: [] }).omitted).toBe(2);
  object.spec!.parentRefs = Array.from({ length: 8 }, (_, index) => ({ name: `parent-${index}` }));
  expect(gatewayRelationships(service, { objects: [object, entry], gaps: [] }).omitted).toBe(3);
});
it("orders classes, listeners and routes and limits condition types to meaningful evidence", () => {
  const entry: GatewayObject = { ...gateway, spec: { ...gateway.spec, gatewayClassName: "example" } };
  const graph = gatewayRelationships(service, {
    objects: [route, entry, { kind: "GatewayClass", metadata: { name: "example" } }],
    gaps: [],
  });
  expect(graph.nodes.map((node) => node.kind)).toEqual(["GatewayClass", "Gateway", "HTTPRoute"]);
  expect(graph.nodes[0].detail).toBe("Accepted: unknown");
  expect(graph.nodes[1].detail).toBe("HTTPS:443");
  expect(graph.nodes[1].evidence?.[1]).not.toContain("ResolvedRefs");
  expect(graph.edges.find((edge) => edge.to.includes("HTTPRoute"))?.evidence).not.toContain("Programmed");
});
