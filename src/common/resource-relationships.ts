import { type GatewayInventory, gatewayRelationships } from "./gateway-relationships";
import { incidentResourcePath } from "./incident-summary";
import {
  diagnoseService,
  type ServiceDiagnosticObject,
  type ServiceDiagnosticPod,
  type ServiceDiagnosticSlice,
} from "./service-diagnostics";

export interface RelationshipMetadata {
  uid?: string;
  name?: string;
  namespace?: string;
  ownerReferences?: { uid: string; name?: string; kind?: string; controller?: boolean }[];
}
export interface RelationshipObject {
  kind?: string;
  metadata: RelationshipMetadata;
  selfLink?: string;
}
export interface RelationshipPod extends ServiceDiagnosticPod {
  metadata: ServiceDiagnosticPod["metadata"] & RelationshipMetadata;
  spec?: ServiceDiagnosticPod["spec"] & { nodeName?: string };
  status?: ServiceDiagnosticPod["status"] & { phase?: string };
  selfLink?: string;
}
export interface RelationshipSlice extends ServiceDiagnosticSlice {
  selfLink?: string;
}
export interface RelationshipIngress extends RelationshipObject {
  spec?: {
    defaultBackend?: { service?: { name: string } };
    backend?: { serviceName?: string };
    rules?: { http?: { paths?: { backend?: { service?: { name: string }; serviceName?: string } }[] } }[];
  };
}
export interface RelationshipNode {
  id: string;
  kind: string;
  name: string;
  role: "upstream" | "service" | "backend" | "placement";
  detail: string;
  evidence?: string[];
  tone: "neutral" | "warning" | "healthy";
  selfLink?: string;
  inferred?: boolean;
}
export interface RelationshipEdge {
  from: string;
  to: string;
  label: string;
  evidence?: string;
}
export interface RelationshipInventory {
  pods?: RelationshipPod[];
  slices?: RelationshipSlice[];
  ingresses?: RelationshipIngress[];
  owners?: RelationshipObject[];
  gaps?: string[];
  gateway?: GatewayInventory;
}
export function relationshipReferencePath(kind: string, name: string, namespace?: string) {
  return incidentResourcePath({ kind, name, namespace });
}
export function buildResourceRelationships(
  service: ServiceDiagnosticObject & { selfLink?: string },
  inventory: RelationshipInventory,
  focusedPod?: string,
  showAll = false,
) {
  const external = service.spec?.type === "ExternalName";
  const diagnostics = diagnoseService(service, external ? [] : inventory.pods, external ? [] : inventory.slices);
  const nodes: RelationshipNode[] = [];
  const edges: RelationshipEdge[] = [];
  const gaps = [...(inventory.gaps ?? [])];
  let omitted = 0;
  const upstreamLimit = showAll ? Infinity : 5;
  const podLimit = showAll ? Infinity : 8;
  const namespace = service.metadata.namespace;
  const add = (node: RelationshipNode) => {
    if (!nodes.some((n) => n.id === node.id)) nodes.push(node);
    return node.id;
  };
  const svc = add({
    id: "service",
    kind: "Service",
    name: service.metadata.name ?? "Unnamed",
    role: "service",
    detail: diagnostics.summary,
    tone: "neutral",
    selfLink: service.selfLink,
  });
  const upstream =
    inventory.ingresses?.filter(
      (ingress) =>
        ingress.metadata.namespace === namespace &&
        [
          ingress.spec?.defaultBackend?.service?.name,
          ingress.spec?.backend?.serviceName,
          ...(ingress.spec?.rules ?? []).flatMap((rule) =>
            (rule.http?.paths ?? []).map((path) => path.backend?.service?.name ?? path.backend?.serviceName),
          ),
        ].includes(service.metadata.name),
    ) ?? [];
  omitted += Math.max(0, upstream.length - upstreamLimit);
  for (const ingress of upstream.slice(0, upstreamLimit)) {
    const id = add({
      id: `ingress/${ingress.metadata.uid ?? ingress.metadata.name}`,
      kind: "Ingress",
      name: ingress.metadata.name ?? "Unnamed",
      role: "upstream",
      detail: "Backend Service reference",
      tone: "neutral",
      selfLink: ingress.selfLink,
    });
    edges.push({ from: id, to: svc, label: "references backend" });
  }
  if (inventory.gateway) {
    const gateway = gatewayRelationships(service, inventory.gateway, showAll);
    nodes.push(...gateway.nodes);
    edges.push(...gateway.edges);
    omitted += gateway.omitted;
    gaps.push(...inventory.gateway.gaps);
  }
  const pods = diagnostics.matchingPods?.filter((pod) => !focusedPod || pod.metadata.name === focusedPod) ?? [];
  omitted += Math.max(0, pods.length - podLimit);
  for (const pod of pods.slice(0, podLimit)) {
    const ready = pod.status?.conditions?.find((c) => c.type === "Ready");
    const id = add({
      id: `pod/${pod.metadata.uid ?? pod.metadata.name}`,
      kind: "Pod",
      name: pod.metadata.name ?? "Unnamed",
      role: "backend",
      detail:
        pod.status?.phase === "Succeeded"
          ? "Completed"
          : pod.status?.phase === "Failed"
            ? "Failed"
            : pod.metadata.deletionTimestamp
              ? "Terminating"
              : pod.status?.phase === "Pending"
                ? "Pending"
                : ready
                  ? `Ready: ${ready.status}`
                  : "Readiness unknown",
      tone:
        pod.status?.phase === "Succeeded"
          ? "healthy"
          : pod.status?.phase === "Failed" ||
              pod.status?.phase === "Pending" ||
              pod.metadata.deletionTimestamp ||
              ready?.status === "False"
            ? "warning"
            : ready?.status === "True"
              ? "healthy"
              : "neutral",
      selfLink: pod.selfLink,
    });
    edges.push({ from: svc, to: id, label: "selector matches" });
    if (pod.spec?.nodeName) {
      const node = add({
        id: `node/${pod.spec.nodeName}`,
        kind: "Node",
        name: pod.spec.nodeName,
        role: "placement",
        detail: "Assignment reference; node health not queried",
        tone: "neutral",
        selfLink: relationshipReferencePath("Node", pod.spec.nodeName),
        inferred: true,
      });
      edges.push({ from: id, to: node, label: "assigned to" });
    }
    let child = id;
    let refs = pod.metadata.ownerReferences;
    const visited = new Set<string>();
    for (let depth = 0; depth < 4; depth++) {
      const ref = refs?.find((r) => r.controller) ?? (refs?.length === 1 ? refs[0] : undefined);
      if (!ref || visited.has(ref.uid)) break;
      visited.add(ref.uid);
      const owner = inventory.owners?.find((o) => o.metadata.uid === ref.uid && o.metadata.namespace === namespace);
      const ownerId = add({
        id: `owner/${ref.uid}`,
        kind: ref.kind ?? "Owner",
        name: ref.name ?? "Unnamed",
        role: "placement",
        detail: owner ? "Controller object observed" : "Owner reference only; object not observed",
        tone: "neutral",
        selfLink:
          owner?.selfLink ??
          relationshipReferencePath(ref.kind ?? "", ref.name ?? "", namespace) ??
          relationshipReferencePath(ref.kind ?? "", ref.name ?? ""),
        inferred: !owner,
      });
      edges.push({ from: child, to: ownerId, label: "owned by" });
      child = ownerId;
      refs = owner?.metadata.ownerReferences;
    }
  }
  const slices = diagnostics.matchingSlices ?? [];
  omitted += Math.max(0, slices.length - upstreamLimit);
  for (const slice of slices.slice(0, upstreamLimit)) {
    const ready = slice.endpoints?.filter((e) => e.conditions?.ready !== false && !e.conditions?.terminating).length;
    const id = add({
      id: `slice/${slice.metadata.name}`,
      kind: "EndpointSlice",
      name: slice.metadata.name ?? "Unnamed",
      role: "backend",
      detail: `${slice.addressType} · ${ready ?? "unknown"} ready endpoint entries`,
      tone: ready === 0 ? "warning" : "neutral",
      selfLink: slice.selfLink,
    });
    edges.push({ from: svc, to: id, label: "published in" });
  }
  if (!external && !inventory.pods) gaps.push("Pod inventory unavailable; selector relationships are unknown");
  if (!inventory.slices && !diagnostics.external)
    gaps.push("EndpointSlice inventory unavailable; published backends are unknown");
  if (!inventory.ingresses) gaps.push("Ingress inventory unavailable; upstream references are unknown");
  return {
    nodes,
    edges: [...new Map(edges.map((edge) => [JSON.stringify([edge.from, edge.to, edge.label]), edge])).values()],
    omitted,
    gaps: [...new Set(gaps)],
    diagnostics,
    podOptions: diagnostics.matchingPods?.map((p) => p.metadata.name).filter((name): name is string => !!name) ?? [],
  };
}
