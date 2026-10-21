import type { AiLogQuery } from "./ai-logs";
export interface AiReadQuery {
  resource?: string;
  apiVersion: string;
  kind: string;
  namespace?: string;
  name?: string;
}

export interface AiClusterConnection {
  read: (query: AiReadQuery, signal?: AbortSignal) => Promise<unknown>;
  discover?: (signal?: AbortSignal) => Promise<AiDiscoveredResource[]>;
  readLogs?: (query: AiLogQuery, signal?: AbortSignal) => Promise<unknown>;
}

export interface AiDiscoveredResource {
  apiVersion: string;
  kind: string;
  resource: string;
  namespaced: boolean;
  verbs: ("get" | "list")[];
}

export class AiUnsupportedResourceError extends Error {
  constructor() {
    super("UNSUPPORTED_RESOURCE");
  }
}

export interface AiReadRequest {
  apiVersion?: string | null;
  kind?: string | null;
  method: "pods" | "nodes" | "resources" | "logs";
  resource?: string;
  ref?: string | null;
  namespace?: string;
  name?: string;
}

const resources: Record<string, { apiVersion: string; kind: string; namespaced: boolean }> = {
  pods: { apiVersion: "v1", kind: "Pod", namespaced: true },
  nodes: { apiVersion: "v1", kind: "Node", namespaced: false },
  deployments: { apiVersion: "apps/v1", kind: "Deployment", namespaced: true },
  statefulsets: { apiVersion: "apps/v1", kind: "StatefulSet", namespaced: true },
  daemonsets: { apiVersion: "apps/v1", kind: "DaemonSet", namespaced: true },
  replicasets: { apiVersion: "apps/v1", kind: "ReplicaSet", namespaced: true },
  services: { apiVersion: "v1", kind: "Service", namespaced: true },
  namespaces: { apiVersion: "v1", kind: "Namespace", namespaced: false },
  jobs: { apiVersion: "batch/v1", kind: "Job", namespaced: true },
  cronjobs: { apiVersion: "batch/v1", kind: "CronJob", namespaced: true },
  persistentvolumeclaims: { apiVersion: "v1", kind: "PersistentVolumeClaim", namespaced: true },
  persistentvolumes: { apiVersion: "v1", kind: "PersistentVolume", namespaced: false },
  ingresses: { apiVersion: "networking.k8s.io/v1", kind: "Ingress", namespaced: true },
  configmaps: { apiVersion: "v1", kind: "ConfigMap", namespaced: true },
  secrets: { apiVersion: "v1", kind: "Secret", namespaced: true },
  events: { apiVersion: "v1", kind: "Event", namespaced: true },
  "certificates.cert-manager.io": { apiVersion: "cert-manager.io/v1", kind: "Certificate", namespaced: true },
  "certificaterequests.cert-manager.io": {
    apiVersion: "cert-manager.io/v1",
    kind: "CertificateRequest",
    namespaced: true,
  },
  "issuers.cert-manager.io": { apiVersion: "cert-manager.io/v1", kind: "Issuer", namespaced: true },
  "clusterissuers.cert-manager.io": { apiVersion: "cert-manager.io/v1", kind: "ClusterIssuer", namespaced: false },
};

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(value)) {
    throw new Error("Invalid Kubernetes resource identifier");
  }
  return value;
}

export function aiReadQuery(request: AiReadRequest, catalog: AiDiscoveredResource[] = []): AiReadQuery {
  if (!request || !["pods", "nodes", "resources", "logs"].includes(request.method))
    throw new Error("Unsupported read method");
  if (request.method === "logs")
    throw new Error("Raw logs are withheld because runtime environment values cannot be reliably removed");
  const resource = request.method === "resources" ? request.resource : request.method;
  const known =
    resource && Object.hasOwn(resources, resource)
      ? resources[resource]
      : Object.values(resources).find((item) => request.apiVersion === item.apiVersion && request.kind === item.kind);
  const definition =
    catalog.find((item) =>
      request.apiVersion && request.kind
        ? item.apiVersion === request.apiVersion && item.kind === request.kind
        : resource === item.resource || resource === `${item.resource}.${item.apiVersion.split("/")[0]}`,
    ) || known;
  if (
    !definition ||
    (request.apiVersion && request.apiVersion !== definition.apiVersion) ||
    (request.kind && request.kind !== definition.kind)
  )
    throw new AiUnsupportedResourceError();
  if ("verbs" in definition && !(definition.verbs as string[]).includes(request.name ? "get" : "list"))
    throw new AiUnsupportedResourceError();
  const query: AiReadQuery = { apiVersion: definition.apiVersion, kind: definition.kind };
  if ("resource" in definition) query.resource = definition.resource as string;
  if (request.name) query.name = identifier(request.name);
  if (request.namespace) {
    if (!definition.namespaced) throw new Error("This resource does not have a namespace");
    query.namespace = identifier(request.namespace);
  }
  if (query.name && definition.namespaced && !query.namespace)
    throw new Error("A namespace is required to read a named resource");
  return query;
}

export function aiReadPath(query: AiReadQuery): string {
  if (!query.resource || !/^[a-z][a-z0-9-]{0,100}$/.test(query.resource)) throw new AiUnsupportedResourceError();
  const parts = query.apiVersion.split("/");
  let path: string;
  if (parts.length === 1 && /^v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/.test(parts[0])) path = `/api/${parts[0]}`;
  else if (
    parts.length === 2 &&
    /^[a-z0-9][a-z0-9.-]{0,200}$/.test(parts[0]) &&
    /^v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/.test(parts[1])
  )
    path = `/apis/${parts[0]}/${parts[1]}`;
  else throw new AiUnsupportedResourceError();
  if (query.namespace) path += `/namespaces/${identifier(query.namespace)}`;
  path += `/${query.resource}`;
  if (query.name) path += `/${identifier(query.name)}`;
  return path;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}

const kinds = new Set([
  "Pod",
  "Node",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Service",
  "Namespace",
  "Job",
  "CronJob",
  "PersistentVolumeClaim",
  "PersistentVolume",
  "Ingress",
  "ConfigMap",
  "Secret",
  "Event",
  "Certificate",
  "CertificateRequest",
  "Issuer",
  "ClusterIssuer",
]);
const phases = new Set([
  "Pending",
  "Running",
  "Succeeded",
  "Failed",
  "Unknown",
  "Active",
  "Terminating",
  "Bound",
  "Available",
  "Released",
  "Lost",
]);
const conditionTypes = new Set([
  "Ready",
  "Initialized",
  "ContainersReady",
  "PodScheduled",
  "PodReadyToStartContainers",
  "MemoryPressure",
  "DiskPressure",
  "PIDPressure",
  "NetworkUnavailable",
  "Available",
  "Progressing",
  "ReplicaFailure",
  "Complete",
  "Failed",
]);
const conditionStatuses = new Set(["True", "False", "Unknown"]);
const containerReasons = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "ContainerCreating",
  "PodInitializing",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
  "OOMKilled",
  "Completed",
  "Error",
]);

// only fixed health enums, numeric status, validated identities and environment names leave this boundary
// suppress identities containing literal environment values found anywhere in this response
export function summarizeAiResource(value: unknown, approved?: Pick<AiReadQuery, "kind" | "apiVersion">): unknown {
  const environmentValues = new Set<string>();
  function collect(current: unknown, owner: RecordValue = {}) {
    if (Array.isArray(current)) {
      current.forEach((entry) => collect(entry, owner));
      return;
    }
    const item = record(current);
    if (item.metadata && item.spec) owner = item;
    if (Array.isArray(item.env)) {
      for (const entry of item.env) {
        const literal = record(entry).value;
        if (typeof literal === "string" && literal) environmentValues.add(literal);
        const fieldPath = record(record(record(entry).valueFrom).fieldRef).fieldPath;
        if (
          typeof fieldPath === "string" &&
          [
            "metadata.name",
            "metadata.namespace",
            "spec.nodeName",
            "spec.serviceAccountName",
            "status.hostIP",
            "status.podIP",
          ].includes(fieldPath)
        ) {
          const [section, field] = fieldPath.split(".");
          const resolved = record(owner[section])[field];
          if (typeof resolved === "string" && resolved) environmentValues.add(resolved);
        }
      }
    }
    for (const [key, nested] of Object.entries(item)) {
      if (key !== "data" && key !== "stringData" && key !== "annotations" && key !== "env") collect(nested, owner);
    }
  }
  collect(value);
  function safeIdentity(input: unknown): string | undefined {
    if (typeof input !== "string" || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(input)) return undefined;
    if ([...environmentValues].some((literal) => input.includes(literal))) return undefined;
    return input;
  }
  let structuralBudget = 6000;
  const specEnums = new Set([
    "Always",
    "Never",
    "OnFailure",
    "IfNotPresent",
    "TCP",
    "UDP",
    "SCTP",
    "ClusterIP",
    "NodePort",
    "LoadBalancer",
    "ExternalName",
    "ReadWriteOnce",
    "ReadOnlyMany",
    "ReadWriteMany",
    "ReadWriteOncePod",
    "Filesystem",
    "Block",
    "RollingUpdate",
    "Recreate",
    "ClusterFirst",
    "Default",
    "None",
    "ClusterFirstWithHostNet",
  ]);
  function safeKey(key: string): boolean {
    return (
      /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key) && ![...environmentValues].some((literal) => key.includes(literal))
    );
  }
  function payloadKeys(value: unknown): string[] {
    return Object.keys(record(value)).filter(safeKey).slice(0, 100);
  }
  function specSummary(input: unknown, depth = 0): unknown {
    if (--structuralBudget < 0 || depth > 10) return "[withheld]";
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : "[withheld]";
    if (typeof input === "string") {
      if ([...environmentValues].some((literal) => input.includes(literal))) return "[withheld]";
      return specEnums.has(input) || /^\d+(?:\.\d+)?(?:m|Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/.test(input)
        ? input
        : "[withheld]";
    }
    if (Array.isArray(input)) return input.slice(0, 100).map((item) => specSummary(item, depth + 1));
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, nested] of Object.entries(record(input)).slice(0, 100)) {
      if (!safeKey(key) || ["annotations", "managedFields"].includes(key)) continue;
      if (["data", "stringData", "binaryData"].includes(key)) {
        output[`${key}Keys`] = payloadKeys(nested);
        continue;
      }
      if (
        /^(?:password|passwd|token|accessToken|refreshToken|idToken|clientSecret|privateKey|apiKey|credentials|authorization|connectionString|secretAccessKey|accessKey|secretKey|bearerToken|certificateData|clientKeyData)$/i.test(
          key.replace(/[_-]/g, ""),
        )
      ) {
        output[key] = "[withheld]";
        continue;
      }
      if (key === "env") {
        output.env = Array.isArray(nested)
          ? nested.slice(0, 100).flatMap((entry) => {
              const name = record(entry).name;
              return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && safeKey(name)
                ? [{ name }]
                : [];
            })
          : [];
        continue;
      }
      output[key] = specSummary(nested, depth + 1);
    }
    return output;
  }
  function summarize(current: unknown): unknown {
    const object = record(current);
    if (Array.isArray(object.items))
      return {
        items: object.items.slice(0, 200).map(summarize),
        truncated: object.items.length > 200,
      };
    const status = record(object.status);
    const metadata = record(object.metadata);
    const environmentNames = new Set<string>();
    function visit(currentSpec: unknown) {
      if (Array.isArray(currentSpec)) {
        currentSpec.forEach(visit);
        return;
      }
      const item = record(currentSpec);
      if (Array.isArray(item.env)) {
        for (const entry of item.env) {
          const name = record(entry).name;
          if (
            typeof name === "string" &&
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
            ![...environmentValues].some((literal) => name.includes(literal))
          )
            environmentNames.add(name);
        }
      }
      for (const [key, nested] of Object.entries(item)) {
        if (key !== "data" && key !== "stringData" && key !== "annotations" && key !== "env") visit(nested);
      }
    }
    visit(object.spec);
    const counts: Record<string, number> = {};
    for (const key of [
      "replicas",
      "readyReplicas",
      "availableReplicas",
      "updatedReplicas",
      "numberReady",
      "desiredNumberScheduled",
      "currentNumberScheduled",
      "active",
      "succeeded",
      "failed",
    ]) {
      if (typeof status[key] === "number" && Number.isFinite(status[key])) counts[key] = status[key];
    }
    const result: Record<string, unknown> = {
      counts,
      environmentNames: [...environmentNames].sort(),
      detailsWithheld: true,
    };
    if (object.spec !== undefined) result.spec = specSummary(object.spec);
    for (const field of ["data", "stringData", "binaryData"]) {
      if (object[field] !== undefined) result[`${field}Keys`] = payloadKeys(object[field]);
    }
    const kind = approved?.kind ?? object.kind;
    const apiVersion = approved?.apiVersion;
    const hiddenIdentity = (identity: string) => [...environmentValues].some((literal) => identity.includes(literal));
    if (
      typeof kind === "string" &&
      /^[A-Z][A-Za-z0-9]{0,100}$/.test(kind) &&
      (approved ? object.kind === undefined || object.kind === kind : kinds.has(kind)) &&
      !hiddenIdentity(kind)
    )
      result.kind = kind;
    if (
      typeof apiVersion === "string" &&
      /^(?:[a-z0-9][a-z0-9.-]{0,200}\/)?v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/.test(apiVersion) &&
      (object.apiVersion === undefined || object.apiVersion === apiVersion) &&
      !hiddenIdentity(apiVersion)
    )
      result.apiVersion = apiVersion;
    const name = safeIdentity(metadata.name);
    const namespace = safeIdentity(metadata.namespace);
    if (name) result.name = name;
    if (namespace) result.namespace = namespace;
    if (phases.has(status.phase as string)) result.phase = status.phase;
    if (Array.isArray(status.conditions))
      result.conditions = status.conditions.slice(0, 30).flatMap((value) => {
        const condition = record(value);
        return conditionTypes.has(condition.type as string) && conditionStatuses.has(condition.status as string)
          ? [{ type: condition.type, status: condition.status }]
          : [];
      });
    if (Array.isArray(status.containerStatuses))
      result.containers = status.containerStatuses.slice(0, 100).map((value) => {
        const container = record(value);
        const summary: Record<string, unknown> = {};
        const containerName = safeIdentity(container.name);
        if (containerName) summary.name = containerName;
        if (typeof container.ready === "boolean") summary.ready = container.ready;
        if (
          typeof container.restartCount === "number" &&
          Number.isSafeInteger(container.restartCount) &&
          container.restartCount >= 0
        )
          summary.restartCount = container.restartCount;
        const state = record(container.state);
        for (const key of ["running", "waiting", "terminated"]) {
          if (state[key] && typeof state[key] === "object") {
            summary.state = key;
            const detail = record(state[key]);
            if (containerReasons.has(detail.reason as string)) summary.reason = detail.reason;
            if (key === "terminated" && typeof detail.exitCode === "number" && Number.isSafeInteger(detail.exitCode))
              summary.exitCode = detail.exitCode;
            break;
          }
        }
        return summary;
      });
    return result;
  }
  return summarize(value);
}
