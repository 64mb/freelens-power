import { effectivePodResource as effectiveResource, parseQuantity } from "./monitoring-math";

export interface ResourceValues {
  requests?: Partial<Record<string, string>>;
  limits?: Partial<Record<string, string>>;
}
export interface DiagnosticsObject {
  kind?: string;
  metadata: {
    uid?: string;
    name?: string;
    namespace?: string;
    labels?: Partial<Record<string, string>>;
    generation?: number;
    annotations?: Partial<Record<string, string>>;
    ownerReferences?: { uid: string; name?: string; kind?: string; controller?: boolean }[];
  };
  spec?: {
    nodeName?: string;
    schedulerName?: string;
    containers?: { resources?: ResourceValues }[];
    initContainers?: { resources?: ResourceValues; restartPolicy?: string }[];
    resources?: ResourceValues;
    overhead?: Partial<Record<string, string>>;
    nodeSelector?: Partial<Record<string, string>>;
    tolerations?: { key?: string; operator?: string; value?: string; effect?: string; tolerationSeconds?: number }[];
    taints?: { key: string; value?: string; effect: string }[];
    unschedulable?: boolean;
    affinity?: {
      nodeAffinity?: {
        requiredDuringSchedulingIgnoredDuringExecution?: unknown;
      };
      podAffinity?: unknown;
      podAntiAffinity?: unknown;
    };
    topologySpreadConstraints?: unknown[];
    volumes?: { persistentVolumeClaim?: { claimName: string } }[];
  };
  status?: {
    phase?: string;
    readyReplicas?: number;
    updatedReplicas?: number;
    observedGeneration?: number;
    conditions?: { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[];
    containerStatuses?: { name: string; restartCount: number; ready?: boolean }[];
    allocatable?: Partial<Record<string, string>>;
  };
}
export interface PodUsage {
  uid: string;
  cpu?: number;
  memory?: number;
}
export interface ResourceSummary {
  requests: number;
  scheduledRequests: number;
  unscheduledRequests: number;
  usage?: number;
  coveredPods: number;
  totalPods: number;
  unknownRequestPods: number;
}
export interface ConsumerGroup {
  namespace: string;
  identity: string;
  kind: string;
  name: string;
  ownerResolved: boolean;
  pods: DiagnosticsObject[];
  cpu: ResourceSummary;
  memory: ResourceSummary;
}
export { parseQuantity } from "./monitoring-math";
export function effectivePodResource(
  pod: DiagnosticsObject,
  metric: "cpu" | "memory",
  kind: "requests" | "limits" = "requests",
): number {
  return effectiveResource(pod, metric, kind);
}
export function buildConsumerGroups(
  pods: DiagnosticsObject[],
  owners: DiagnosticsObject[],
  usage: PodUsage[] = [],
): ConsumerGroup[] {
  const objects = new Map(owners.filter((o) => o.metadata.uid).map((o) => [o.metadata.uid, o]));
  const metrics = new Map(usage.map((u) => [u.uid, u]));
  const groups = new Map<string, ConsumerGroup>();
  for (const [index, pod] of pods.entries()) {
    if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") continue;
    let owner = pod;
    let resolved = true;
    const visited = new Set<string>();
    let unresolved: { uid: string; name?: string; kind?: string } | undefined;
    while (true) {
      const references = owner.metadata.ownerReferences ?? [];
      const reference = references.find((r) => r.controller) ?? (references.length === 1 ? references[0] : undefined);
      if (!reference) break;
      if (visited.has(reference.uid)) {
        resolved = false;
        break;
      }
      visited.add(reference.uid);
      const next = objects.get(reference.uid);
      if (!next || next.metadata.namespace !== pod.metadata.namespace) {
        unresolved = reference;
        resolved = false;
        break;
      }
      owner = next;
    }
    const namespace = pod.metadata.namespace ?? "default";
    const identity = unresolved?.uid ?? owner.metadata.uid ?? `unidentified-pod-${index}`;
    const key = `${namespace}/${identity}`;
    let group = groups.get(key);
    if (!group) {
      const summary = (): ResourceSummary => ({
        requests: 0,
        scheduledRequests: 0,
        unscheduledRequests: 0,
        coveredPods: 0,
        totalPods: 0,
        unknownRequestPods: 0,
      });
      group = {
        namespace,
        identity,
        kind: unresolved?.kind ?? owner.kind ?? "Pod",
        name: unresolved?.name ?? owner.metadata.name ?? "Unknown",
        ownerResolved: resolved,
        pods: [],
        cpu: summary(),
        memory: summary(),
      };
      groups.set(key, group);
    }
    group.pods.push(pod);
    for (const metric of ["cpu", "memory"] as const) {
      const summary = group[metric];
      summary.totalPods++;
      try {
        const request = effectivePodResource(pod, metric);
        summary.requests += request;
        summary[pod.spec?.nodeName ? "scheduledRequests" : "unscheduledRequests"] += request;
      } catch {
        summary.unknownRequestPods++;
      }
      const value = pod.metadata.uid ? metrics.get(pod.metadata.uid)?.[metric] : undefined;
      if (value !== undefined && Number.isFinite(value) && value >= 0) {
        summary.coveredPods++;
        summary.usage = (summary.usage ?? 0) + value;
      }
    }
  }
  return [...groups.values()];
}
export interface DiagnosticsEvent {
  metadata?: { uid?: string; creationTimestamp?: string };
  involvedObject?: { uid?: string; name?: string; namespace?: string };
  regarding?: { uid?: string; name?: string; namespace?: string };
  reason?: string;
  message?: string;
  note?: string;
  type?: string;
  count?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTime?: string;
  series?: { count?: number; lastObservedTime?: string };
}
export interface TimelineEntry {
  id: string;
  reason: string;
  message: string;
  time?: string;
  firstTime?: string;
  count: number;
  certainty: "reported" | "observed" | "unknown";
  objectUid?: string;
  gap?: string;
}
const validTime = (value?: string) => (value && Number.isFinite(Date.parse(value)) ? value : undefined);
export function normalizeEvents(events: DiagnosticsEvent[]): TimelineEntry[] {
  return events
    .map((event, index) => ({
      id: event.metadata?.uid ?? `event-${index}`,
      reason: event.reason ?? "Event",
      message: event.message ?? event.note ?? "",
      time:
        validTime(event.series?.lastObservedTime) ??
        validTime(event.lastTimestamp) ??
        validTime(event.eventTime) ??
        validTime(event.metadata?.creationTimestamp),
      firstTime: validTime(event.firstTimestamp) ?? validTime(event.eventTime),
      count: event.series?.count ?? event.count ?? 1,
      certainty: "reported" as const,
      objectUid: event.involvedObject?.uid ?? event.regarding?.uid,
    }))
    .map((entry) => ({ ...entry, certainty: entry.time ? entry.certainty : ("unknown" as const) }));
}
export interface PendingEvidence {
  source: "event" | "constraint";
  message: string;
  node?: string;
}
export function diagnosePendingPod(
  pod: DiagnosticsObject,
  nodes: DiagnosticsObject[],
  events: DiagnosticsEvent[] = [],
  pvcs?: DiagnosticsObject[],
): { state: "assigned-waiting" | "unscheduled" | "not-pending"; evidence: PendingEvidence[]; limitations: string[] } {
  const state =
    pod.status?.phase !== "Pending" ? "not-pending" : pod.spec?.nodeName ? "assigned-waiting" : "unscheduled";
  const evidence: PendingEvidence[] = events
    .filter((event) => !!pod.metadata.uid && (event.involvedObject?.uid ?? event.regarding?.uid) === pod.metadata.uid)
    .map((event) => ({ source: "event", message: `${event.reason ?? "Event"}: ${event.message ?? event.note ?? ""}` }));
  const limitations = ["Local checks do not establish exact schedulability or available node capacity"];
  if (state !== "unscheduled") return { state, evidence, limitations };
  const spec = pod.spec;
  if (!nodes.length) limitations.push("Node data unavailable");
  if (spec?.schedulerName && spec.schedulerName !== "default-scheduler")
    limitations.push("Custom scheduler profile is unknown");
  if (spec?.affinity?.podAffinity || spec?.affinity?.podAntiAffinity || spec?.topologySpreadConstraints?.length)
    limitations.push("Pod affinity and topology constraints are not evaluated");
  for (const node of nodes) {
    const reject = (message: string) => evidence.push({ source: "constraint", node: node.metadata.name, message });
    if (node.spec?.unschedulable) reject("Node is cordoned");
    if (Object.entries(spec?.nodeSelector ?? {}).some(([key, value]) => node.metadata.labels?.[key] !== value))
      reject("Node selector does not match");
    for (const taint of node.spec?.taints ?? []) {
      if (!["NoSchedule", "NoExecute"].includes(taint.effect)) continue;
      if (
        !(spec?.tolerations ?? []).some(
          (t) =>
            (!t.effect || t.effect === taint.effect) &&
            (t.operator === "Exists"
              ? !t.key || t.key === taint.key
              : t.key === taint.key && (t.value ?? "") === (taint.value ?? "")),
        )
      )
        reject(`Untolerated taint ${taint.key} (${taint.effect})`);
    }
    const required = spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
    const terms =
      required &&
      typeof required === "object" &&
      "nodeSelectorTerms" in required &&
      Array.isArray(required.nodeSelectorTerms)
        ? (required.nodeSelectorTerms as {
            matchExpressions?: { key: string; operator: string; values?: string[] }[];
            matchFields?: unknown[];
          }[])
        : undefined;
    if (required && !terms) limitations.push("Required node affinity data is unsupported");
    if (terms) {
      const unsupported = terms.some(
        (term) =>
          term.matchFields?.length ||
          term.matchExpressions?.some(
            (e) => !["In", "NotIn", "Exists", "DoesNotExist", "Gt", "Lt"].includes(e.operator),
          ),
      );
      if (unsupported) {
        if (!limitations.includes("Required node affinity contains unsupported expressions"))
          limitations.push("Required node affinity contains unsupported expressions");
      } else if (
        !terms.some(
          (term) =>
            !!term.matchExpressions?.length &&
            term.matchExpressions.every((e) => {
              const value = node.metadata.labels?.[e.key];
              if (e.operator === "Exists") return value !== undefined;
              if (e.operator === "DoesNotExist") return value === undefined;
              if (e.operator === "In") return value !== undefined && !!e.values?.includes(value);
              if (e.operator === "NotIn") return value === undefined || !e.values?.includes(value);
              return (
                value !== undefined &&
                !!e.values?.length &&
                Number.isFinite(Number(value)) &&
                (e.operator === "Gt" ? Number(value) > Number(e.values[0]) : Number(value) < Number(e.values[0]))
              );
            }),
        )
      )
        reject("Required node affinity does not match");
    }
    for (const metric of ["cpu", "memory"] as const) {
      try {
        if (
          node.status?.allocatable?.[metric] !== undefined &&
          effectivePodResource(pod, metric) > parseQuantity(node.status.allocatable[metric], metric === "memory")
        )
          reject(`Pod ${metric} request exceeds node allocatable`);
      } catch {
        limitations.push(`Invalid or unavailable ${metric} resource data`);
      }
    }
  }
  for (const volume of spec?.volumes ?? []) {
    const claim = volume.persistentVolumeClaim?.claimName;
    if (!claim) continue;
    const pvc = pvcs?.find(
      (item) => item.metadata.name === claim && item.metadata.namespace === pod.metadata.namespace,
    );
    if (!pvc) limitations.push(`PVC ${claim} data unavailable`);
    else if (pvc.status?.phase !== "Bound")
      limitations.push(`PVC ${claim} is not bound; delayed binding and storage topology require scheduler evidence`);
  }
  return { state, evidence, limitations: [...new Set(limitations)] };
}
export function observePodChanges(
  previous: DiagnosticsObject[],
  current: DiagnosticsObject[],
  observedAt: string,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const prior = new Map(previous.filter((pod) => pod.metadata.uid).map((pod) => [pod.metadata.uid, pod]));
  for (const pod of current) {
    const old = pod.metadata.uid ? prior.get(pod.metadata.uid) : undefined;
    const add = (reason: string, message: string) =>
      entries.push({
        id: `${pod.metadata.uid ?? pod.metadata.name}/${reason}/${observedAt}`,
        reason,
        message,
        time: validTime(observedAt),
        count: 1,
        certainty: validTime(observedAt) ? "observed" : "unknown",
        objectUid: pod.metadata.uid,
        gap: "Change occurred between snapshots; exact transition time is unknown",
      });
    if (!old) {
      add("FirstObserved", `${pod.metadata.name ?? "Pod"} first observed; creation or rollout time is unknown`);
      continue;
    }
    if (old.status?.phase !== pod.status?.phase)
      add("PhaseChanged", `${old.status?.phase ?? "Unknown"} → ${pod.status?.phase ?? "Unknown"}`);
    for (const status of pod.status?.containerStatuses ?? []) {
      const before = old.status?.containerStatuses?.find((item) => item.name === status.name);
      if (before && status.restartCount !== before.restartCount)
        add(`Restarts/${status.name}`, `${status.name}: restart count ${before.restartCount} → ${status.restartCount}`);
      if (before && status.ready !== before.ready)
        add(`Readiness/${status.name}`, `${status.name}: ready ${String(before.ready)} → ${String(status.ready)}`);
    }
  }
  return entries;
}

export function observeResourceChanges(
  previous: DiagnosticsObject[],
  current: DiagnosticsObject[],
  observedAt: string,
): TimelineEntry[] {
  const entries = observePodChanges(
    previous,
    current.filter((object) => object.kind === "Pod" || !!object.spec?.containers),
    observedAt,
  );
  const prior = new Map(
    previous.filter((object) => object.metadata.uid).map((object) => [object.metadata.uid, object]),
  );
  for (const object of current) {
    if (object.kind === "Pod" || object.spec?.containers) continue;
    const old = object.metadata.uid ? prior.get(object.metadata.uid) : undefined;
    if (!old) continue;
    const changes = (["readyReplicas", "updatedReplicas", "observedGeneration"] as const)
      .filter((key) => old.status?.[key] !== object.status?.[key])
      .map((key) => `${key}: ${old.status?.[key] ?? "unknown"} → ${object.status?.[key] ?? "unknown"}`);
    if (old.metadata.generation !== object.metadata.generation)
      changes.push(`generation: ${old.metadata.generation ?? "unknown"} → ${object.metadata.generation ?? "unknown"}`);
    const revisionKey = "deployment.kubernetes.io/revision";
    if (old.metadata.annotations?.[revisionKey] !== object.metadata.annotations?.[revisionKey])
      changes.push(
        `revision: ${old.metadata.annotations?.[revisionKey] ?? "unknown"} → ${object.metadata.annotations?.[revisionKey] ?? "unknown"}`,
      );
    if (changes.length)
      entries.push({
        id: `${object.metadata.uid}/rollout/${observedAt}`,
        reason: "RolloutObserved",
        message: `${object.metadata.name ?? "Workload"}: ${changes.join(", ")}`,
        time: validTime(observedAt),
        count: 1,
        certainty: validTime(observedAt) ? "observed" : "unknown",
        objectUid: object.metadata.uid,
        gap: "Change occurred between snapshots; exact transition time is unknown",
      });
  }
  return entries;
}
