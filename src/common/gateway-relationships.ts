import type { RelationshipEdge, RelationshipNode } from "./resource-relationships";

const GROUP = "gateway.networking.k8s.io";
interface Condition {
  type: string;
  status: string;
  reason?: string;
  observedGeneration?: number;
}
interface Reference {
  name: string;
  namespace?: string;
  group?: string;
  kind?: string;
  sectionName?: string;
  port?: number;
  weight?: number;
}
interface Listener {
  name: string;
  port: number;
  protocol: string;
  allowedRoutes?: {
    kinds?: { group?: string; kind: string }[];
    namespaces?: {
      from?: string;
      selector?: {
        matchLabels?: Record<string, string>;
        matchExpressions?: { key: string; operator: string; values?: string[] }[];
      };
    };
  };
}
export interface GatewayObject {
  apiVersion?: string;
  kind: string;
  selfLink?: string;
  metadata: { name?: string; namespace?: string; uid?: string; generation?: number; labels?: Record<string, string> };
  spec?: {
    gatewayClassName?: string;
    listeners?: Listener[];
    parentRefs?: Reference[];
    hostnames?: string[];
    rules?: {
      backendRefs?: Reference[];
      matches?: { path?: { value?: string }; method?: { service?: string; method?: string } }[];
    }[];
    from?: { group: string; kind: string; namespace: string }[];
    to?: { group: string; kind: string; name?: string }[];
  };
  status?: {
    conditions?: Condition[];
    listeners?: { name: string; conditions?: Condition[] }[];
    parents?: { parentRef: Reference; controllerName?: string; conditions?: Condition[] }[];
  };
}
export interface GatewayInventory {
  objects: GatewayObject[];
  grants?: GatewayObject[];
  grantNamespaces?: string[];
  namespaces?: GatewayObject[];
  gaps: string[];
}
function conditions(items: Condition[] | undefined, generation?: number, types = ["Accepted", "ResolvedRefs"]) {
  return types
    .map((type) => {
      const condition = items?.find((item) => item.type === type);
      const stale = generation !== undefined && condition?.observedGeneration !== generation;
      return `${type}: ${condition ? `${condition.status}${condition.reason ? ` (${condition.reason})` : ""}${stale ? " · stale/unknown generation" : ""}` : "unknown"}`;
    })
    .join(" · ");
}
function grantEvidence(route: GatewayObject, backend: Reference, inventory: GatewayInventory) {
  const namespace = backend.namespace ?? route.metadata.namespace;
  if (namespace === route.metadata.namespace) return "same-namespace backend";
  if (!inventory.grants || (inventory.grantNamespaces && !inventory.grantNamespaces.includes(namespace ?? "")))
    return "cross-namespace ReferenceGrant unknown";
  const granted = inventory.grants.some(
    (grant) =>
      grant.metadata.namespace === namespace &&
      grant.spec?.from?.some(
        (from) => from.group === GROUP && from.kind === route.kind && from.namespace === route.metadata.namespace,
      ) &&
      grant.spec?.to?.some((to) => to.group === "" && to.kind === "Service" && (!to.name || to.name === backend.name)),
  );
  return granted
    ? "cross-namespace ReferenceGrant permits backend"
    : "cross-namespace backend not permitted by observed ReferenceGrants";
}
function attachment(route: GatewayObject, gateway: GatewayObject, listener: Listener, inventory: GatewayInventory) {
  const kinds = listener.allowedRoutes?.kinds;
  if (kinds && !kinds.some((kind) => (kind.group ?? GROUP) === GROUP && kind.kind === route.kind))
    return "listener rejects route kind";
  if (!kinds) {
    const supported: Record<string, string[]> = {
      HTTP: ["HTTPRoute", "GRPCRoute"],
      HTTPS: ["HTTPRoute", "GRPCRoute"],
      TCP: ["TCPRoute"],
      TLS: ["TLSRoute"],
      UDP: ["UDPRoute"],
    };
    if (!supported[listener.protocol]?.includes(route.kind))
      return "listener rejects route kind or protocol support unknown";
  }
  const ns = listener.allowedRoutes?.namespaces;
  if (!ns || !ns.from || ns.from === "Same")
    return route.metadata.namespace === gateway.metadata.namespace
      ? "allowedRoutes permits namespace"
      : "allowedRoutes rejects namespace";
  if (ns.from === "All") return "allowedRoutes permits all namespaces";
  if (ns.from !== "Selector") return "allowedRoutes namespace unknown";
  const namespace = inventory.namespaces?.find((item) => item.metadata.name === route.metadata.namespace);
  if (!namespace) return "allowedRoutes namespace selector unknown";
  const labels = namespace.metadata.labels ?? {};
  const selected =
    Object.entries(ns.selector?.matchLabels ?? {}).every(([key, value]) => labels[key] === value) &&
    (ns.selector?.matchExpressions ?? []).every(({ key, operator, values = [] }) => {
      if (operator === "In") return labels[key] !== undefined && values.includes(labels[key]);
      if (operator === "NotIn") return labels[key] === undefined || !values.includes(labels[key]);
      if (operator === "Exists") return labels[key] !== undefined;
      if (operator === "DoesNotExist") return labels[key] === undefined;
      return false;
    });
  return selected ? "allowedRoutes namespace selector matches" : "allowedRoutes namespace selector rejects";
}
export function gatewayRelationships(
  service: { metadata: { name?: string; namespace?: string } },
  inventory: GatewayInventory,
) {
  const nodes: RelationshipNode[] = [];
  const edges: RelationshipEdge[] = [];
  let omitted = 0;
  const add = (object: GatewayObject, suffix = "", detail = "", evidence?: string[]) => {
    const id = `gateway-api/${object.kind}/${object.metadata.namespace ?? ""}/${object.metadata.name}${suffix}`;
    if (!nodes.some((node) => node.id === id))
      nodes.push({
        id,
        kind: object.kind,
        name: `${object.metadata.name}${suffix}`,
        role: "upstream",
        tone: "neutral",
        detail,
        evidence,
        selfLink: object.selfLink,
      });
    return id;
  };
  const routes = inventory.objects.filter(
    (object) =>
      ["HTTPRoute", "GRPCRoute", "TCPRoute", "TLSRoute", "UDPRoute"].includes(object.kind) &&
      object.spec?.rules?.some((rule) =>
        rule.backendRefs?.some(
          (backend) =>
            (backend.group ?? "") === "" &&
            (backend.kind ?? "Service") === "Service" &&
            backend.name === service.metadata.name &&
            (backend.namespace ?? object.metadata.namespace) === service.metadata.namespace,
        ),
      ),
  );
  for (const route of routes.slice(0, 5)) {
    const backends =
      route.spec?.rules
        ?.flatMap((rule) => rule.backendRefs ?? [])
        .filter(
          (backend) =>
            (backend.group ?? "") === "" &&
            (backend.kind ?? "Service") === "Service" &&
            backend.name === service.metadata.name &&
            (backend.namespace ?? route.metadata.namespace) === service.metadata.namespace,
        ) ?? [];
    const summaries =
      route.spec?.rules?.flatMap(
        (rule) =>
          rule.matches?.map(
            (match) => match.path?.value ?? [match.method?.service, match.method?.method].filter(Boolean).join("/"),
          ) ?? [],
      ) ?? [];
    const routeId = add(
      route,
      "",
      [
        ...(route.spec?.hostnames ?? []),
        ...summaries,
        ...backends.map((backend) => `weight ${backend.weight ?? 1} · ${grantEvidence(route, backend, inventory)}`),
      ].join(" · "),
    );
    edges.push({ from: routeId, to: "service", label: "backend reference (not reachability)" });
    const parents = (route.spec?.parentRefs ?? []).filter(
      (parent) => (parent.group ?? GROUP) === GROUP && (parent.kind ?? "Gateway") === "Gateway",
    );
    omitted += Math.max(0, parents.length - 5);
    for (const parent of parents.slice(0, 5)) {
      const gateway = inventory.objects.find(
        (object) =>
          object.kind === "Gateway" &&
          object.metadata.name === parent.name &&
          object.metadata.namespace === (parent.namespace ?? route.metadata.namespace),
      );
      if (!gateway) continue;
      const status = route.status?.parents?.filter(
        (item) =>
          (item.parentRef.group ?? GROUP) === GROUP &&
          (item.parentRef.kind ?? "Gateway") === "Gateway" &&
          item.parentRef.name === parent.name &&
          (item.parentRef.namespace ?? route.metadata.namespace) === (parent.namespace ?? route.metadata.namespace) &&
          item.parentRef.sectionName === parent.sectionName &&
          item.parentRef.port === parent.port,
      );
      const listeners = (gateway.spec?.listeners ?? []).filter(
        (item) =>
          (!parent.sectionName || parent.sectionName === item.name) && (!parent.port || parent.port === item.port),
      );
      omitted += Math.max(0, listeners.length - 5);
      for (const listener of listeners.slice(0, 5)) {
        const listenerStatus = gateway.status?.listeners?.find((item) => item.name === listener.name);
        const id = add(gateway, `/${listener.name}`, `${listener.protocol}:${listener.port}`, [
          `Listener ${conditions(listenerStatus?.conditions, gateway.metadata.generation, ["Accepted", "ResolvedRefs", "Programmed"])}`,
          `Gateway ${conditions(gateway.status?.conditions, gateway.metadata.generation, ["Accepted", "Programmed"])}`,
        ]);
        edges.push({
          from: id,
          to: routeId,
          label: "parent reference",
          evidence: `${attachment(route, gateway, listener, inventory)} · ${status?.length ? status.map((item) => `${item.controllerName ?? "unknown controller"}: ${conditions(item.conditions, route.metadata.generation)}`).join(" · ") : "parent reference · acceptance unknown"}`,
        });
        const gatewayClass = inventory.objects.find(
          (object) => object.kind === "GatewayClass" && object.metadata.name === gateway.spec?.gatewayClassName,
        );
        if (gatewayClass)
          edges.push({
            from: add(
              gatewayClass,
              "",
              conditions(gatewayClass.status?.conditions, gatewayClass.metadata.generation, ["Accepted"]),
            ),
            to: id,
            label: "class reference",
          });
      }
    }
  }
  const order = (kind: string) => (kind === "GatewayClass" ? 0 : kind === "Gateway" ? 1 : 2);
  nodes.sort((a, b) => order(a.kind) - order(b.kind));
  return { nodes, edges, omitted: omitted + Math.max(0, routes.length - 5) };
}
