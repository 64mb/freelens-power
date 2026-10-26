import { redactKubernetesPayload } from "../common/ai-resource-payload";

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
  query.resource =
    "resource" in definition
      ? (definition.resource as string)
      : Object.entries(resources)
          .find(([, item]) => item === definition)?.[0]
          .split(".")[0];
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

// payload redaction follows Kubernetes resource origins, independently of ordinary resource values
export function summarizeAiResource(
  value: unknown,
  approved?: Pick<AiReadQuery, "kind" | "apiVersion">,
  detailBudget = 100000,
  payloadKind?: string,
): unknown {
  const source = record(value);
  if (Array.isArray(source.items)) {
    const listPayloadKind =
      source.kind === "SecretList" ? "Secret" : source.kind === "ConfigMapList" ? "ConfigMap" : payloadKind;
    const childApproved = listPayloadKind && approved && listPayloadKind !== approved.kind ? undefined : approved;
    const items = source.items
      .slice(0, 200)
      .map((item) =>
        summarizeAiResource(
          item,
          childApproved,
          Math.min(
            detailBudget,
            Math.floor(60000 / Math.max(1, source.items instanceof Array ? source.items.length : 1)),
          ),
          listPayloadKind,
        ),
      );
    return { items, truncated: source.items.length > 200 || items.some((item) => record(item).truncated === true) };
  }
  function identify(current: unknown): unknown {
    const object = record(current);
    if (Array.isArray(object.items)) return { ...object, items: object.items.map(identify) };
    return approved
      ? { ...object, kind: object.kind ?? approved.kind, apiVersion: object.apiVersion ?? approved.apiVersion }
      : current;
  }
  let remainingNodes = 12000;
  let remainingCharacters = detailBudget;
  let limited = false;
  function bound(input: unknown, depth = 0): unknown {
    if (--remainingNodes < 0 || depth > 20) {
      limited = true;
      return "[content omitted]";
    }
    if (typeof input === "string") {
      const count = Math.max(0, Math.min(8000, remainingCharacters));
      const result = input.slice(0, count);
      remainingCharacters -= result.length;
      if (result.length < input.length) limited = true;
      return result;
    }
    if (Array.isArray(input)) {
      if (input.length > 200) limited = true;
      return input.slice(0, 200).map((item) => bound(item, depth + 1));
    }
    if (input && typeof input === "object") {
      const output: Record<string, unknown> = Object.create(null);
      const entries = Object.entries(input);
      if (entries.length > 200) limited = true;
      for (const [key, nested] of entries.slice(0, 200)) {
        if (remainingNodes <= 0 || remainingCharacters <= 0) {
          limited = true;
          break;
        }
        const safeKey = key.slice(0, Math.min(512, remainingCharacters));
        remainingCharacters -= safeKey.length;
        if (safeKey.length < key.length) limited = true;
        output[safeKey] = bound(nested, depth + 1);
      }
      return output;
    }
    return input;
  }
  const raw = record(identify(value));
  const rawMetadata = record(raw.metadata);
  const rawStatus = record(raw.status);
  const healthStatus: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(rawStatus)) {
    if (typeof field === "number" || key === "phase") healthStatus[key] = field;
  }
  if (Array.isArray(rawStatus.conditions))
    healthStatus.conditions = rawStatus.conditions.slice(0, 30).map((entry) => {
      const condition = record(entry);
      return { type: condition.type, status: condition.status };
    });
  if (Array.isArray(rawStatus.containerStatuses))
    healthStatus.containerStatuses = rawStatus.containerStatuses.slice(0, 100).map((entry) => {
      const container = record(entry);
      const state = record(container.state);
      const compactState: Record<string, unknown> = {};
      for (const key of ["running", "waiting", "terminated"])
        if (state[key]) {
          const detail = record(state[key]);
          compactState[key] = { reason: detail.reason, exitCode: detail.exitCode };
        }
      return {
        name: container.name,
        ready: container.ready,
        restartCount: container.restartCount,
        state: compactState,
      };
    });
  const healthInput = {
    kind: raw.kind,
    apiVersion: raw.apiVersion,
    metadata: { name: rawMetadata.name, namespace: rawMetadata.namespace },
    status: healthStatus,
  };
  const safe = bound(redactKubernetesPayload(raw, payloadKind ?? approved?.kind));
  const detailLimited = limited;

  function summarize(current: unknown): Record<string, unknown> {
    const object = record(current);
    if (Array.isArray(object.items))
      return {
        ...object,
        items: object.items.map(summarize),
        truncated: limited || (record(value).items instanceof Array && (record(value).items as unknown[]).length > 200),
      };
    const metadata = record(object.metadata);
    const status = record(object.status);
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
    const environmentNames = new Set<string>();
    function visit(input: unknown) {
      if (Array.isArray(input)) return input.forEach(visit);
      const item = record(input);
      if (Array.isArray(item.env))
        for (const entry of item.env) {
          const name = record(entry).name;
          if (typeof name === "string") environmentNames.add(name);
        }
      Object.values(item).forEach((nested) => {
        if (nested && typeof nested === "object") visit(nested);
      });
    }
    visit(object.spec);
    const result: Record<string, unknown> = {
      ...object,
      counts,
      environmentNames: [...environmentNames].sort(),
      detailsWithheld: false,
    };
    if (limited) result.truncated = true;
    for (const key of ["name", "namespace"]) if (typeof metadata[key] === "string") result[key] = metadata[key];
    if (status.phase !== undefined) result.phase = status.phase;
    if (status.conditions !== undefined) result.conditions = status.conditions;
    if (Array.isArray(status.containerStatuses))
      result.containers = status.containerStatuses.map((input) => {
        const container = record(input);
        const summary: Record<string, unknown> = { ...container };
        for (const key of ["running", "waiting", "terminated"]) {
          const detail = record(record(container.state)[key]);
          if (record(container.state)[key] && typeof record(container.state)[key] === "object") {
            summary.state = key;
            if (detail.reason !== undefined) summary.reason = detail.reason;
            if (detail.exitCode !== undefined) summary.exitCode = detail.exitCode;
            break;
          }
        }
        return summary;
      });
    for (const field of ["data", "stringData", "binaryData"]) {
      if (object[field] !== undefined && ["Secret", "ConfigMap"].includes(String(object.kind))) {
        result[`${field}Keys`] = Object.keys(record(object[field]));
      }
    }
    return result;
  }
  const details = summarize(safe);
  remainingNodes = 2000;
  remainingCharacters = 8000;
  limited = false;
  const health = summarize(bound(redactKubernetesPayload(healthInput)));
  const result: Record<string, unknown> = { ...details, ...health, environmentNames: details.environmentNames };
  if (detailLimited || limited) result.truncated = true;
  // compact fields remain available even when a verbose detail branch consumes its allocation
  for (const key of ["metadata", "status"]) if (record(safe)[key] !== undefined) result[key] = record(safe)[key];
  const ceiling = Math.max(900, detailBudget * 3);
  if (JSON.stringify(result).length > ceiling) {
    const compact: Record<string, unknown> = { ...health, truncated: true };
    delete compact.metadata;
    delete compact.status;
    for (const key of ["conditions", "containers"]) {
      const entries = compact[key];
      if (Array.isArray(entries)) while (entries.length && JSON.stringify(compact).length > ceiling) entries.pop();
    }
    return compact;
  }
  return result;
}
