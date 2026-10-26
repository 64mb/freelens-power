import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  buildResourceRelationships,
  type RelationshipInventory,
  type RelationshipNode,
  type RelationshipObject,
} from "../common/resource-relationships";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";
import { explainDiagnosticFinding } from "./ai-diagnostic-handoff";
import { loadGatewayInventory } from "./gateway-relationships-client";
import { NativeTooltip } from "./native-tooltip";
import { relationshipMapFinding } from "./relationship-map-finding";
import { resourceRelationshipsStyles } from "./resource-relationships.css";
import { createResourceSearchTransport } from "./resource-search-client";
import { openSearchResource } from "./resource-search-routing";

const { Icon, Select } = Renderer.Component;
const LIMIT = 100;
type Service = Renderer.K8sApi.Service;
interface InventoryState {
  namespace: string;
  service: string;
  data: RelationshipInventory;
}
const roles = [
  { id: "upstream", name: "Upstream references", relation: "references backend" },
  { id: "service", name: "Focused Service", relation: "API configuration" },
  { id: "backend", name: "Selected & published backends", relation: "selector matches / published in" },
  { id: "placement", name: "Ownership & placement", relation: "owned by / assigned to" },
] as const;
const icons: Record<string, string> = {
  Ingress: "login",
  Service: "share",
  Pod: "view_in_ar",
  EndpointSlice: "hub",
  Node: "dns",
  ReplicaSet: "layers",
  Deployment: "layers",
  StatefulSet: "layers",
  DaemonSet: "layers",
  Job: "work",
  CronJob: "schedule",
};
export async function loadRelationshipInventory(
  namespace: string,
  service: Service,
  signal: AbortSignal,
): Promise<RelationshipInventory> {
  const gaps: string[] = [];
  const list = async <T,>(name: string, request: () => Promise<T[] | null>) => {
    try {
      const items = await request();
      if (!items) {
        gaps.push(`${name} inventory unavailable`);
        return undefined;
      }
      if (items.length > LIMIT)
        gaps.push(`${name} inventory capped at ${LIMIT} objects; additional relationships may be omitted`);
      return items.slice(0, LIMIT);
    } catch {
      if (!signal.aborted) gaps.push(`${name} inventory unavailable; access or API availability may be restricted`);
      return undefined;
    }
  };
  const options = { namespace, reqInit: { signal } };
  const query = { limit: LIMIT + 1 };
  const selector = Object.entries(service.spec.selector ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const external = service.spec.type === "ExternalName";
  const ownerApis = external
    ? []
    : [
        Renderer.K8sApi.replicaSetApi,
        Renderer.K8sApi.deploymentApi,
        Renderer.K8sApi.statefulSetApi,
        Renderer.K8sApi.daemonSetApi,
        Renderer.K8sApi.jobApi,
        Renderer.K8sApi.cronJobApi,
      ];
  const [pods, slices, ingresses, ...owners] = await Promise.all([
    selector && !external
      ? list("Pod", () => Renderer.K8sApi.podsApi.list(options, { ...query, labelSelector: selector }))
      : Promise.resolve([]),
    service.spec.type === "ExternalName"
      ? Promise.resolve([])
      : list("EndpointSlice", () =>
          Renderer.K8sApi.endpointSliceApi.list(options, {
            ...query,
            labelSelector: `kubernetes.io/service-name=${service.getName()}`,
          }),
        ),
    list("Ingress", () => Renderer.K8sApi.ingressApi.list(options, query)),
    ...ownerApis.map((api) => list<RelationshipObject>("Controller", () => api.list(options, query))),
  ]);
  const clusterId = Renderer.Catalog.activeCluster.get()?.metadata.uid;
  const gateway = clusterId
    ? await loadGatewayInventory(createResourceSearchTransport(clusterId, signal), signal, {
        focusedNamespace: namespace,
      })
    : undefined;
  return { pods, slices, ingresses, owners: owners.flatMap((items) => items ?? []), gaps, gateway };
}
function ResourceCard({
  node,
  incoming,
  incomingEvidence,
  onOpen,
  onHighlight,
}: {
  onHighlight: (id?: string) => void;
  node: RelationshipNode;
  incoming: string[];
  incomingEvidence?: string[];
  onOpen: (path: string) => void;
}) {
  return (
    <article
      className="card"
      data-node-id={node.id}
      onMouseEnter={() => onHighlight(node.id)}
      onMouseLeave={() => onHighlight()}
      onFocus={() => onHighlight(node.id)}
      onBlur={() => onHighlight()}
    >
      <div className="relation-label">{incoming.join(" · ") || "Focus"}</div>
      <div className="card-kind">
        <Icon material={icons[node.kind] ?? "account_tree"} size={16} />
        {node.kind}
        {node.inferred && " · reference"}
      </div>
      {node.selfLink ? (
        <NativeTooltip title={`Open ${node.kind} ${node.name}`}>
          <button
            type="button"
            className="resource-name"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpen(node.selfLink as string);
            }}
          >
            {node.name}
          </button>
        </NativeTooltip>
      ) : (
        <strong>{node.name}</strong>
      )}
      <p className={node.tone}>
        <Icon
          material={node.tone === "warning" ? "warning" : node.tone === "healthy" ? "check_circle" : "info"}
          size={14}
        />{" "}
        {node.detail}
      </p>
      {!!(node.evidence?.length || incomingEvidence?.length) && (
        <details className="gateway-evidence">
          <summary>API evidence</summary>
          {[...(node.evidence ?? []), ...(incomingEvidence ?? [])].map((evidence) => (
            <p key={evidence}>{evidence}</p>
          ))}
        </details>
      )}
    </article>
  );
}
function roundedConnector(points: [number, number][]) {
  let path = `M ${points[0][0]} ${points[0][1]}`;
  for (let index = 1; index < points.length - 1; index++) {
    const [x, y] = points[index];
    const [px, py] = points[index - 1];
    const [nx, ny] = points[index + 1];
    const before = Math.hypot(x - px, y - py);
    const after = Math.hypot(nx - x, ny - y);
    if (!before || !after) continue;
    const radius = Math.min(6, before / 2, after / 2);
    path += ` L ${x + ((px - x) * radius) / before} ${y + ((py - y) * radius) / before}`;
    path += ` Q ${x} ${y} ${x + ((nx - x) * radius) / after} ${y + ((ny - y) * radius) / after}`;
  }
  const last = points[points.length - 1];
  return `${path} L ${last[0]} ${last[1]}`;
}
export function RelationshipGraph({
  graph,
  onOpen,
  ingressAvailable,
  hideUpstreams = false,
}: {
  graph: ReturnType<typeof buildResourceRelationships>;
  onOpen: (path: string) => void;
  ingressAvailable: boolean;
  hideUpstreams?: boolean;
}) {
  const upstreamIds = new Set(graph.nodes.filter((node) => node.role === "upstream").map((node) => node.id));
  const upstreamGutter =
    !hideUpstreams && graph.edges.some((edge) => upstreamIds.has(edge.from) && upstreamIds.has(edge.to));
  const visibleRoles = roles.filter((role) => !hideUpstreams || role.id !== "upstream");
  const element = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{ from: string; to: string; label: string; path: string }[]>([]);
  const [highlight, setHighlight] = useState<string>();
  useLayoutEffect(() => {
    const container = element.current;
    if (!container) return;
    const measure = () => {
      const origin = container.getBoundingClientRect();
      const cards = new Map(
        Array.from(container.querySelectorAll<HTMLElement>("[data-node-id]")).map((card) => [
          card.dataset.nodeId,
          card.getBoundingClientRect(),
        ]),
      );
      setPaths(
        graph.edges.flatMap((edge, index) => {
          const from = cards.get(edge.from);
          const to = cards.get(edge.to);
          if (!from || !to) return [];
          const sy = from.top + from.height / 2 - origin.top;
          const ty = to.top + to.height / 2 - origin.top;
          const sameColumn = Math.abs(from.left - to.left) < 2;
          const sx = (sameColumn ? from.left : from.right) - origin.left;
          const tx = to.left - origin.left;
          const laneOffset = ((index % 3) - 1) * 8;
          const gutter = sameColumn ? sx - 28 + laneOffset : (sx + tx) / 2 + laneOffset;
          const crossesColumn = Array.from(cards.values()).some(
            (card) => card.left > from.left + 2 && card.right < to.left - 2,
          );
          let path =
            !sameColumn && sy === ty
              ? `M ${sx} ${sy} H ${tx}`
              : roundedConnector([
                  [sx, sy],
                  [gutter, sy],
                  [gutter, ty],
                  [tx, ty],
                ]);
          if (crossesColumn) {
            const bottom =
              Math.max(...Array.from(cards.values(), (card) => card.bottom)) - origin.top + 24 + (index % 3) * 8;
            const sourceGutter = sx + 32 + laneOffset;
            const targetGutter = tx - 32 + laneOffset;
            path = roundedConnector([
              [sx, sy],
              [sourceGutter, sy],
              [sourceGutter, bottom],
              [targetGutter, bottom],
              [targetGutter, ty],
              [tx, ty],
            ]);
          }
          return [{ ...edge, path }];
        }),
      );
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(container);
    for (const card of container.querySelectorAll("[data-node-id]")) observer?.observe(card);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [graph, hideUpstreams]);
  return (
    <div className="graph-scroll">
      <div
        ref={element}
        className={`graph${hideUpstreams ? " hide-upstreams" : ""}${upstreamGutter ? " upstream-gutter" : ""}`}
        style={{
          gridTemplateRows: `auto repeat(${Math.max(1, ...visibleRoles.map((role) => graph.nodes.filter((node) => node.role === role.id).length))}, auto)`,
        }}
        aria-label="Service resource relationship graph"
      >
        <svg className="resource-connections" width="100%" height="100%" aria-hidden="true">
          <defs>
            <marker id="relationship-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
              <path d="M0 0L5 2.5L0 5" fill="currentColor" />
            </marker>
          </defs>
          {paths.map((edge) => (
            <NativeTooltip
              key={`${edge.from}/${edge.to}/${edge.label}`}
              title={`${graph.nodes.find((node) => node.id === edge.from)?.name} → ${edge.label} → ${graph.nodes.find((node) => node.id === edge.to)?.name}`}
            >
              <path
                data-edge-from={edge.from}
                data-edge-to={edge.to}
                className={
                  highlight
                    ? edge.from === highlight || edge.to === highlight
                      ? "connection highlighted"
                      : "connection dimmed"
                    : "connection"
                }
                d={edge.path}
                markerEnd="url(#relationship-arrow)"
              />
            </NativeTooltip>
          ))}
        </svg>
        {visibleRoles.map((role) => (
          <section className="column" key={role.id} aria-label={role.name}>
            <h3>{role.name}</h3>
            {graph.nodes
              .filter((node) => node.role === role.id)
              .map((node) => (
                <ResourceCard
                  key={node.id}
                  node={node}
                  incoming={[...new Set(graph.edges.filter((edge) => edge.to === node.id).map((edge) => edge.label))]}
                  incomingEvidence={graph.edges
                    .filter((edge) => edge.to === node.id && edge.evidence)
                    .map((edge) => edge.evidence as string)}
                  onOpen={onOpen}
                  onHighlight={setHighlight}
                />
              ))}
            {!graph.nodes.some((node) => node.role === role.id) && (
              <div className="card neutral">
                {role.id === "upstream"
                  ? ingressAvailable
                    ? "No matching upstream references observed"
                    : "Ingress evidence unavailable"
                  : "No relationships observed in available evidence"}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
export const ResourceRelationshipsPage = observer(({ enabled = true }: { enabled?: boolean }) => {
  if (!enabled)
    return (
      <div className="power-relationships">
        <p>Resource relationships are disabled in Power settings</p>
      </div>
    );
  return <EnabledResourceRelationshipsPage key={Renderer.Catalog.activeCluster.get()?.metadata.uid ?? "cluster"} />;
});
function EnabledResourceRelationshipsPage() {
  const mounted = useRef(true);
  const clusterId = useRef(Renderer.Catalog.activeCluster.get()?.metadata.uid);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("");
  const [services, setServices] = useState<Service[]>([]);
  const [serviceName, setServiceName] = useState("");
  const [focusedPod, setFocusedPod] = useState("");
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [namespace, serviceName, focusedPod]);
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  const [hideUpstreams, setHideUpstreams] = useState(() =>
    preferences.hiddenUpstreamClusters.includes(clusterId.current ?? ""),
  );
  const toggleUpstreams = () => {
    const id = clusterId.current;
    if (!id || Renderer.Catalog.activeCluster.get()?.metadata.uid !== id) return;
    const hidden = !hideUpstreams;
    const otherClusters = preferences.hiddenUpstreamClusters.filter((cluster) => cluster !== id);
    preferences.hiddenUpstreamClusters = hidden ? [...otherClusters, id].slice(-100) : otherClusters;
    setHideUpstreams(hidden);
  };
  const [inventory, setInventory] = useState<InventoryState>();
  const [refresh, setRefresh] = useState(0);
  const [scopeRefresh, setScopeRefresh] = useState(0);
  const [namespaceMessage, setNamespaceMessage] = useState("");
  const [scopeLoading, setScopeLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [scopeMessage, setScopeMessage] = useState("");
  const [openError, setOpenError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setScopeLoading(true);
    setNamespaceMessage("");
    void Renderer.K8sApi.namespacesApi
      .list({ reqInit: { signal: controller.signal } }, { limit: LIMIT + 1 })
      .then((items) => {
        if (controller.signal.aborted) return;
        const names = (items ?? [])
          .slice(0, LIMIT)
          .map((item) => item.getName())
          .sort();
        setNamespaces(names);
        setNamespace((current) => (names.includes(current) ? current : (names[0] ?? "")));
        if ((items?.length ?? 0) > LIMIT) setNamespaceMessage(`Namespace selector is capped at ${LIMIT} entries`);
        else if (!names.length) setScopeMessage("No visible namespaces returned by the API");
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setScopeMessage("Namespace inventory unavailable; check access to namespace listing");
      })
      .finally(() => {
        if (!controller.signal.aborted) setScopeLoading(false);
      });
    return () => controller.abort();
  }, [scopeRefresh]);
  useEffect(() => {
    if (!namespace) return;
    const controller = new AbortController();
    setLoading(false);
    setServices([]);
    setServiceName("");
    setInventory(undefined);
    setScopeLoading(true);
    setScopeMessage("");
    void Renderer.K8sApi.serviceApi
      .list({ namespace, reqInit: { signal: controller.signal } }, { limit: LIMIT + 1 })
      .then((items) => {
        if (controller.signal.aborted) return;
        const visible = (items ?? []).slice(0, LIMIT).sort((a, b) => a.getName().localeCompare(b.getName()));
        setServices(visible);
        setServiceName(visible[0]?.getName() ?? "");
        if ((items?.length ?? 0) > LIMIT)
          setScopeMessage(`Service selector is capped at ${LIMIT} entries; additional Services are not shown`);
        else if (!visible.length) setScopeMessage("No visible Services in this namespace");
      })
      .catch(() => {
        if (!controller.signal.aborted) setScopeMessage("Service inventory unavailable; check namespace access");
      })
      .finally(() => {
        if (!controller.signal.aborted) setScopeLoading(false);
      });
    return () => controller.abort();
  }, [namespace, scopeRefresh]);
  const service = services.find((item) => item.getName() === serviceName);
  useEffect(() => {
    if (!service || !namespace || service.metadata.namespace !== namespace) return;
    const controller = new AbortController();
    setLoading(true);
    setInventory(undefined);
    setFocusedPod("");
    setOpenError("");
    void loadRelationshipInventory(namespace, service, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setInventory({ namespace, service: service.getName(), data });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [namespace, service, refresh]);
  const current = inventory?.namespace === namespace && inventory.service === serviceName ? inventory : undefined;
  const graph =
    current && service
      ? buildResourceRelationships(service, current.data, focusedPod || undefined, showAll)
      : undefined;
  useEffect(() => {
    if (!graph || loading || !clusterId.current) return;
    const id = clusterId.current;
    const attach = () =>
      explainDiagnosticFinding(relationshipMapFinding(id, namespace, serviceName, graph, hideUpstreams));
    window.addEventListener("power-ai-request-screen-context", attach);
    return () => window.removeEventListener("power-ai-request-screen-context", attach);
  }, [graph, loading, namespace, serviceName, hideUpstreams]);
  const openResource = (path: string) => {
    const currentCluster = () =>
      mounted.current && Renderer.Catalog.activeCluster.get()?.metadata.uid === clusterId.current;
    setOpenError("");
    void Promise.resolve()
      .then(() => {
        if (!currentCluster()) return;
        const gatewayPath = path.match(
          /^\/apis\/(gateway\.networking\.k8s\.io)\/([^/]+)\/(?:namespaces\/([^/]+)\/)?([^/]+)\/([^/]+)$/,
        );
        if (gatewayPath) {
          const [, group, version, namespace, resource, name] = gatewayPath;
          const kind = (
            {
              gateways: "Gateway",
              gatewayclasses: "GatewayClass",
              httproutes: "HTTPRoute",
              grpcroutes: "GRPCRoute",
              tcproutes: "TCPRoute",
              tlsroutes: "TLSRoute",
              udproutes: "UDPRoute",
            } as Record<string, string>
          )[resource];
          return openSearchResource({ path, group, version, namespace, resource, name, kind, labels: {} });
        }
        return Renderer.Navigation.showDetails(path);
      })
      .catch(() => {
        if (currentCluster()) setOpenError("Resource details could not be opened; the object may be unavailable");
      });
  };
  return (
    <div className="power-relationships">
      <style>{resourceRelationshipsStyles}</style>
      <div className="page-heading">
        <h2>Resource relationships</h2>
      </div>
      <p className="intro">
        Follow one Service from upstream Ingress and Gateway API references to selected pods, published EndpointSlices
        and controller ownership. Connections show Kubernetes API evidence; they do not prove network reachability.
      </p>
      <div className="controls">
        <label className="control">
          <span>Namespace</span>
          <Select
            aria-label="Relationship namespace"
            value={namespace}
            options={namespaces.map((name) => ({ value: name, label: name }))}
            onChange={(option) => setNamespace(option?.value ?? "")}
            isDisabled={!namespaces.length}
          />
        </label>
        <label className="control">
          <span>Service</span>
          <Select
            aria-label="Relationship Service"
            value={serviceName}
            options={services.map((item) => ({ value: item.getName(), label: item.getName() }))}
            onChange={(option) => setServiceName(option?.value ?? "")}
            isDisabled={!services.length || scopeLoading}
          />
        </label>
        <label className="control">
          <span>Pod focus</span>
          <Select
            aria-label="Relationship pod focus"
            value={focusedPod}
            options={[
              { value: "", label: showAll ? "All selected pods" : "All selected pods (up to 8)" },
              ...(graph?.podOptions ?? []).map((name) => ({ value: name, label: name })),
            ]}
            onChange={(option) => setFocusedPod(option?.value ?? "")}
            isDisabled={!graph?.podOptions.length}
          />
        </label>
        <NativeTooltip title={hideUpstreams ? "Show upstream references" : "Hide upstream references"}>
          <button
            type="button"
            className="graph-option"
            aria-pressed={hideUpstreams}
            onClick={toggleUpstreams}
            disabled={!clusterId.current}
          >
            <Icon material={hideUpstreams ? "visibility_off" : "visibility"} size={16} />
            Hide Upstream
          </button>
        </NativeTooltip>
        <NativeTooltip title="Refresh scoped API evidence">
          <button
            type="button"
            className="refresh"
            onClick={() => (service ? setRefresh((value) => value + 1) : setScopeRefresh((value) => value + 1))}
            disabled={loading || scopeLoading}
          >
            <Icon material="refresh" size={18} />
            Refresh
          </button>
        </NativeTooltip>
      </div>
      {namespaceMessage && (
        <div className="notice" role="status">
          {namespaceMessage}
        </div>
      )}
      {scopeMessage && (
        <div className="notice" role="status">
          {scopeMessage}
        </div>
      )}
      {openError && (
        <div className="notice warning" role="alert">
          {openError}
        </div>
      )}
      {(scopeLoading || loading) && (
        <div className="empty" role="status">
          Loading scoped relationship evidence…
        </div>
      )}
      {!scopeLoading && !loading && !service && (
        <div className="empty">Select a namespace with a visible Service to inspect relationships</div>
      )}
      {graph && !loading && (
        <>
          <div className="notice relationship-summary">
            <strong>{graph.diagnostics.summary}</strong>
            <div className="ports">
              {graph.diagnostics.ports.map((port) => (
                <span key={port.name}>
                  {port.name} · {port.protocol} → {port.target} · published:{" "}
                  {port.endpointPorts.join(", ") || "unknown"}
                  {port.unresolved ? ` · ${port.unresolved} unresolved named targets` : ""}
                </span>
              ))}
            </div>
          </div>
          {graph.gaps.length > 0 && (
            <details open className="notice">
              <summary>Partial coverage ({graph.gaps.length})</summary>
              <ul>
                {graph.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </details>
          )}
          <RelationshipGraph
            graph={graph}
            onOpen={openResource}
            ingressAvailable={current?.data.ingresses !== undefined}
            hideUpstreams={hideUpstreams}
          />
          {(graph.omitted > 0 || showAll) && (
            <div className="notice graph-omitted-notice">
              {!showAll && <Icon material="warning_amber" className="graph-omitted-warning" size={16} />}
              <span>
                {showAll ? (
                  "All available resources are shown."
                ) : (
                  <>
                    Hidden resources: <strong>{graph.omitted}</strong>. Show all to expand the map.
                  </>
                )}
              </span>
              {!showAll && (
                <NativeTooltip title="Show all available resources">
                  <button
                    type="button"
                    className="graph-show-all"
                    aria-label="Show all available resources"
                    onClick={() => setShowAll(true)}
                  >
                    <Icon material="visibility" size={16} />
                  </button>
                </NativeTooltip>
              )}
            </div>
          )}
          <details>
            <summary>Accessible connection list ({graph.edges.length})</summary>
            <ul className="edge-list">
              {graph.edges.map((edge) => (
                <li key={`${edge.from}/${edge.to}/${edge.label}`}>
                  {graph.nodes.find((node) => node.id === edge.from)?.name} → {edge.label} →{" "}
                  {graph.nodes.find((node) => node.id === edge.to)?.name}
                  {edge.evidence && <div>{edge.evidence}</div>}
                </li>
              ))}
            </ul>
          </details>
          <p className="scope">
            <span>
              Snapshot from read-only API requests; Gateway discovery and references include other namespaces.
            </span>
            <span>Owner and node references can point to objects that were not queried.</span>
            <span>Endpoint counts can include separate address families.</span>
            <span>No Secret or ConfigMap data is read.</span>
          </p>
        </>
      )}
    </div>
  );
}
