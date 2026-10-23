import { redactAiTerminalText } from "./ai-terminal-context";
import { formatDateTime } from "./date-time";
export interface IncidentResource {
  kind: string;
  namespace?: string;
  name: string;
}
export interface IncidentSummary {
  clusterName?: string;
  problem: string;
  facts: string[];
  time?: string | number;
  resources?: IncidentResource[];
}
const api: Record<string, [string, string, "cluster"?]> = {
  Pod: ["/api/v1", "pods"],
  Node: ["/api/v1", "nodes", "cluster"],
  Namespace: ["/api/v1", "namespaces", "cluster"],
  PersistentVolume: ["/api/v1", "persistentvolumes", "cluster"],
  PersistentVolumeClaim: ["/api/v1", "persistentvolumeclaims"],
  Service: ["/api/v1", "services"],
  HorizontalPodAutoscaler: ["/apis/autoscaling/v2", "horizontalpodautoscalers"],
  Ingress: ["/apis/networking.k8s.io/v1", "ingresses"],
  EndpointSlice: ["/apis/discovery.k8s.io/v1", "endpointslices"],
  Deployment: ["/apis/apps/v1", "deployments"],
  ReplicaSet: ["/apis/apps/v1", "replicasets"],
  StatefulSet: ["/apis/apps/v1", "statefulsets"],
  DaemonSet: ["/apis/apps/v1", "daemonsets"],
  Job: ["/apis/batch/v1", "jobs"],
  CronJob: ["/apis/batch/v1", "cronjobs"],
};
export function incidentResourcePath(resource: IncidentResource): string | undefined {
  if (!Object.hasOwn(api, resource.kind)) return;
  const route = api[resource.kind];
  const validName = (value: string | undefined) =>
    typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(value);
  if (!validName(resource.name)) return;
  if (route[2] === "cluster") {
    if (resource.namespace !== undefined) return;
    return `${route[0]}/${route[1]}/${encodeURIComponent(resource.name)}`;
  }
  if (!validName(resource.namespace)) return;
  return `${route[0]}/namespaces/${encodeURIComponent(resource.namespace!)}/${route[1]}/${encodeURIComponent(resource.name)}`;
}
const safe = (value: string, limit: number) => redactAiTerminalText(value).slice(0, limit);
export function formatIncidentSummary(incident: IncidentSummary): string {
  const date = incident.time === undefined ? undefined : new Date(incident.time);
  const offset = date && Number.isFinite(date.getTime()) ? -date.getTimezoneOffset() : undefined;
  const timezone =
    offset === undefined
      ? ""
      : ` UTC${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  const links = [
    ...new Set(
      (incident.resources ?? [])
        .slice(0, 12)
        .map(incidentResourcePath)
        .filter((value): value is string => !!value),
    ),
  ];
  const lines = [
    `Problem: ${safe(incident.problem, 240)}`,
    ...(incident.clusterName ? [`Cluster: ${safe(incident.clusterName, 160)}`] : []),
    `Snapshot time: ${date ? formatDateTime(date) : "Unavailable"}${timezone}`,
    "Facts:",
    ...incident.facts.slice(0, 12).map((fact) => `- ${safe(fact, 400)}`),
    ...(links.length
      ? ["Resource API links (Freelens resource detail paths):", ...links.map((link) => `- ${link}`)]
      : []),
  ];
  const footer = "Read-only snapshot; evidence may be partial or stale";
  const selected: string[] = [];
  let length = footer.length;
  for (const line of lines) {
    if (length + line.length + 1 > 8000) break;
    selected.push(line);
    length += line.length + 1;
  }
  return [...selected, footer].join("\n");
}
