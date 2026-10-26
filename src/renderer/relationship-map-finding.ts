import type { buildResourceRelationships } from "../common/resource-relationships";
import type { DiagnosticFinding } from "./ai-diagnostic-handoff";

type RelationshipGraph = ReturnType<typeof buildResourceRelationships>;

export function relationshipMapFinding(
  clusterId: string,
  namespace: string,
  service: string,
  graph: RelationshipGraph,
  hideUpstreams: boolean,
): DiagnosticFinding {
  const text = (value: string) => value.slice(0, 300);
  const visible = graph.nodes.filter((node) => !hideUpstreams || node.role !== "upstream");
  const nodes = visible.slice(0, 60);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const snapshot = {
    namespace,
    service,
    summary: text(graph.diagnostics.summary),
    nodes: nodes.map(({ id, kind, name, role, detail, tone, inferred }) => ({
      id: text(id),
      kind,
      name: text(name),
      role,
      detail: text(detail),
      tone,
      ...(inferred ? { inferred } : {}),
    })),
    edges: edges.slice(0, 100).map(({ from, to, label }) => ({ from: text(from), to: text(to), label: text(label) })),
    gaps: graph.gaps.slice(0, 20).map(text),
    omitted: graph.omitted + visible.length - nodes.length + Math.max(0, edges.length - 100),
    upstreamsHidden: hideUpstreams,
    scope: "Visible map snapshot from Kubernetes API evidence; does not prove network reachability",
  };
  let summary = JSON.stringify(snapshot);
  while (summary.length > 8000 && (snapshot.edges.length || snapshot.nodes.length)) {
    if (snapshot.edges.length) snapshot.edges.pop();
    else snapshot.nodes.pop();
    snapshot.omitted++;
    summary = JSON.stringify(snapshot);
  }
  return {
    automatic: true,
    clusterId,
    source: "relationships",
    title: `Relationships · ${service}`,
    resource: { kind: "Service", name: service, namespace },
    summary,
  };
}
