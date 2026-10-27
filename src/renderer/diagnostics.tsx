import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "../common/date-time";
import {
  buildConsumerGroups,
  type ConsumerGroup,
  type DiagnosticsObject,
  diagnosePendingPod,
  effectivePodResource,
  normalizeEvents,
  observeResourceChanges,
  type PodUsage,
  type ResourceSummary,
  type TimelineEntry,
} from "../common/resource-diagnostics";
import { groupTimelineEntries } from "../common/timeline-groups";
import { explainDiagnosticFinding } from "./ai-diagnostic-handoff";
import { AiIcon } from "./ai-icon";
import { DiagnosticExplainButton } from "./diagnostic-explain-button";
import { diagnosticsStyles } from "./diagnostics.css";
import { diagnosticsScreenFinding } from "./diagnostics-screen-finding";
import { DIAGNOSTICS_NAMESPACE_EVENT, readDiagnosticsState, saveDiagnosticsState } from "./diagnostics-state";
import { IncidentCopyButton } from "./incident-copy-button";
import {
  getCollectedPodUsage,
  getMonitoringSnapshot,
  type MonitoringSnapshot,
  retainMonitoringCollector,
} from "./monitoring-collector";
import { NativeTooltip } from "./native-tooltip";

const viewDescriptions = {
  Consumers: [
    "What is using cluster resources?",
    "Compare workload usage and requests, then expand a workload to inspect its pods.",
  ],
  Timeline: [
    "What changed in this workload?",
    "Follow related Kubernetes events and changes observed while this view is open.",
  ],
  "Not ready": ["Why is this pod not ready?", "Inspect running pod readiness, conditions and retained events."],
  Pending: [
    "Why is this pod waiting?",
    "Inspect scheduling evidence and resource requests before opening the pod for investigation.",
  ],
};
function DiagnosticsSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <span className="diagnostics-select">
      <Renderer.Component.Select
        aria-label={label}
        value={value}
        options={options}
        onChange={(option) => {
          if (option) onChange(option.value);
        }}
        isClearable={false}
      />
    </span>
  );
}
function ResourceCell({ summary, metric }: { summary: ResourceSummary; metric: "cpu" | "memory" }) {
  const complete = summary.coveredPods === summary.totalPods && !summary.unknownRequestPods;
  const ratio =
    complete && summary.usage !== undefined && summary.requests > 0
      ? `${((summary.usage / summary.requests) * 100).toFixed(0)}% of requests`
      : undefined;
  return (
    <div className="resource-cell">
      <div className="resource-value">
        <small>Usage</small>
        <strong>{resourceText(summary.usage, metric)}</strong>
      </div>
      <div className="resource-request">
        <small>{summary.unknownRequestPods ? "Known requests" : "Requests"}</small>
        <span>{resourceText(summary.requests, metric)}</span>
      </div>
      <NativeTooltip title="Coverage is per resource. Missing metrics are unavailable, never zero.">
        <small className="resource-coverage">
          {summary.coveredPods}/{summary.totalPods} pods covered
          {summary.unknownRequestPods ? ` · ${summary.unknownRequestPods} requests unknown` : ""}
          {ratio ? ` · ${ratio}` : ""}
        </small>
      </NativeTooltip>
      {complete && summary.usage !== undefined && summary.requests > 0 && summary.usage > summary.requests && (
        <NativeTooltip title="Usage exceeds configured requests. Requests are reservations, not limits; this alone does not indicate a failure.">
          <span className="request-burst">
            <AiIcon material="info_outline" size={12} />
            Above requests
          </span>
        </NativeTooltip>
      )}
    </div>
  );
}
function UnscheduledCell({ cpu, memory }: { cpu: ResourceSummary; memory: ResourceSummary }) {
  const partial = cpu.unknownRequestPods || memory.unknownRequestPods;
  if (!partial && !cpu.unscheduledRequests && !memory.unscheduledRequests)
    return (
      <NativeTooltip title="No unscheduled requests">
        <span className="unscheduled-empty">—</span>
      </NativeTooltip>
    );
  return (
    <div className={`unscheduled-cell${cpu.unscheduledRequests || memory.unscheduledRequests ? " has-requests" : ""}`}>
      <div>
        <small>CPU</small>
        <span>{unscheduledText(cpu, "cpu")}</span>
      </div>
      <div>
        <small>Memory</small>
        <span>{unscheduledText(memory, "memory")}</span>
      </div>
    </div>
  );
}
export function consumerStatus(pods: DiagnosticsObject[]): { tone: string; label: string; icon: string } {
  const failureReasons = new Set([
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "CreateContainerConfigError",
    "CreateContainerError",
    "RunContainerError",
    "InvalidImageName",
  ]);
  for (const pod of pods) {
    if (pod.status?.phase === "Succeeded") continue;
    type WaitingStatus = { state?: { waiting?: { reason?: string } } };
    const status = pod.status as
      | { containerStatuses?: WaitingStatus[]; initContainerStatuses?: WaitingStatus[] }
      | undefined;
    const statuses = [...(status?.containerStatuses ?? []), ...(status?.initContainerStatuses ?? [])];
    const reason = statuses
      ?.map((status) => status.state?.waiting?.reason)
      .find((value) => value && failureReasons.has(value));
    if (pod.status?.phase === "Failed" || reason)
      return { tone: "error", label: reason ?? "Failed", icon: "error_outline" };
  }
  const pendingCount = pods.filter((pod) => pod.status?.phase === "Pending").length;
  if (pendingCount) return { tone: "warning", label: `${pendingCount} Pending`, icon: "hourglass_empty" };
  if (
    pods.some(
      (pod) =>
        pod.status?.phase !== "Succeeded" &&
        pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "False"),
    )
  )
    return { tone: "warning", label: "Not ready", icon: "warning_amber" };
  if (
    pods.length &&
    pods.every(
      (pod) =>
        pod.status?.phase === "Succeeded" ||
        (pod.status?.phase === "Running" &&
          pod.status.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True")),
    )
  )
    return pods.every((pod) => pod.status?.phase === "Succeeded")
      ? { tone: "healthy", label: "Completed", icon: "check_circle" }
      : {
          tone: "healthy",
          label: pods.some((pod) => pod.status?.phase === "Succeeded") ? "Ready / Completed" : "Ready",
          icon: "check_circle_outline",
        };
  return { tone: "neutral", label: "Readiness unknown", icon: "help_outline" };
}
function ConsumerStatus({ pods }: { pods: DiagnosticsObject[] }) {
  const status = consumerStatus(pods);
  return (
    <span className={`consumer-status ${status.tone}`}>
      <AiIcon material={status.icon} size={13} />
      {status.label}
    </span>
  );
}
type Tab = "Consumers" | "Timeline" | "Pending" | "Not ready";
const hidden = () => document.visibilityState === "hidden";
const activeId = () => Renderer.Catalog.activeCluster.get()?.metadata.uid;
const groupKey = (group: ConsumerGroup) => `${group.namespace}/${group.identity}`;
function resourceText(value: number | undefined, metric: "cpu" | "memory"): string {
  if (value === undefined) return "Unavailable";
  return metric === "cpu" ? `${value.toFixed(3)} cores` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
function unscheduledText(summary: ResourceSummary, metric: "cpu" | "memory"): string {
  return `${summary.unknownRequestPods ? "Partial known: " : ""}${resourceText(summary.unscheduledRequests, metric)}`;
}
const resources: Record<string, string> = {
  Pod: "/api/v1",
  Deployment: "/apis/apps/v1",
  ReplicaSet: "/apis/apps/v1",
  StatefulSet: "/apis/apps/v1",
  DaemonSet: "/apis/apps/v1",
  Job: "/apis/batch/v1",
  CronJob: "/apis/batch/v1",
};
const plurals: Record<string, string> = {
  Pod: "pods",
  Deployment: "deployments",
  ReplicaSet: "replicasets",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
  Job: "jobs",
  CronJob: "cronjobs",
};
function openResource(object: DiagnosticsObject, clusterId: string, event: MouseEvent): void {
  event.stopPropagation();
  const kind = object.kind ?? "Pod";
  if (activeId() !== clusterId || !object.metadata.name) return;
  if (kind === "Namespace") {
    void Promise.resolve(
      Renderer.Navigation.showDetails(`/api/v1/namespaces/${encodeURIComponent(object.metadata.name)}`),
    ).catch(() => {});
    return;
  }
  if (!object.metadata.namespace || !resources[kind]) return;
  const path = `${resources[kind]}/namespaces/${encodeURIComponent(object.metadata.namespace)}/${plurals[kind]}/${encodeURIComponent(object.metadata.name)}`;
  void Promise.resolve(Renderer.Navigation.showDetails(path)).catch(() => {});
}
const projections = new WeakMap<MonitoringSnapshot, ReturnType<typeof projectSnapshot>>();
function projectSnapshot(data: MonitoringSnapshot) {
  const usage = getCollectedPodUsage(data);
  const groups = buildConsumerGroups(data.pods ?? [], data.owners ?? [], usage);
  const objects = new Map<string, DiagnosticsObject>();
  const children = new Map<string, string[]>();
  for (const object of [...(data.owners ?? []), ...(data.pods ?? [])]) {
    const uid = object.metadata.uid;
    if (!uid) continue;
    objects.set(uid, object);
    const refs = object.metadata.ownerReferences ?? [];
    const parent = refs.find((item) => item.controller) ?? (refs.length === 1 ? refs[0] : undefined);
    if (parent) {
      const siblings = children.get(parent.uid) ?? [];
      siblings.push(uid);
      children.set(parent.uid, siblings);
    }
  }
  const related = new Map<string, Set<string>>();
  for (const group of groups) {
    const seen = new Set<string>();
    const stack = [group.identity];
    while (stack.length) {
      const uid = stack.pop()!;
      if (seen.has(uid)) continue;
      const object = objects.get(uid);
      if (object && object.metadata.namespace !== group.namespace) continue;
      seen.add(uid);
      stack.push(...(children.get(uid) ?? []));
    }
    related.set(groupKey(group), seen);
  }
  return { usage, groups, objects, related };
}
function projection(data: MonitoringSnapshot) {
  let value = projections.get(data);
  if (!value) {
    value = projectSnapshot(data);
    projections.set(data, value);
  }
  return value;
}
export function DiagnosticsPage() {
  const initial = useRef(readDiagnosticsState(activeId() ?? "")).current;
  const scrollContainer = useRef<HTMLDivElement>(null);
  const stateCluster = useRef(activeId() ?? "");
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot>();
  const [error, setError] = useState("");
  const [filter, setFilter] = useState(initial.filter);
  const [namespaceScope, setNamespaceScope] = useState(initial.namespaceScope);
  const [resourceScope, setResourceScope] = useState(initial.resourceScope);
  const pendingScroll = useRef<{ clusterId: string; top: number } | undefined>({
    clusterId: stateCluster.current,
    top: initial.scrollTop,
  });
  const [needsAttention, setNeedsAttention] = useState(initial.needsAttention);
  const [groupMode, setGroupMode] = useState(initial.groupMode);
  const [namespacesOpen, setNamespacesOpen] = useState<string[]>(initial.namespacesOpen);
  const known = useRef(new Map<string, { group: ConsumerGroup; uids: Set<string> }>());
  const [sort, setSort] = useState(initial.sort);
  const [expanded, setExpanded] = useState<string[]>(initial.expanded);
  const [selected, setSelected] = useState(initial.selected);
  const [pendingUid, setPendingUid] = useState(initial.pendingUid);
  const [notReadyUid, setNotReadyUid] = useState(initial.notReadyUid ?? "");
  const [reason, setReason] = useState(initial.reason);
  const [warningOnly, setWarningOnly] = useState(initial.warningOnly);
  const [groupedTimeline, setGroupedTimeline] = useState(initial.groupedTimeline);
  const [openTimeline, setOpenTimeline] = useState<string[]>(initial.openTimeline);
  const viewState = useRef(initial);
  viewState.current = {
    tab,
    filter,
    namespaceScope,
    resourceScope,
    needsAttention,
    groupMode,
    namespacesOpen,
    sort,
    expanded,
    selected,
    pendingUid,
    notReadyUid,
    reason,
    warningOnly,
    groupedTimeline,
    openTimeline,
    scrollTop: viewState.current.scrollTop,
  };
  useEffect(() => {
    return () => saveDiagnosticsState(stateCluster.current, viewState.current);
  }, [initial]);
  useEffect(() => {
    const focusNamespace = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          clusterId: string;
          namespace?: string;
          resourceScope?: { kind: string; name: string; uid?: string };
        }>
      ).detail;
      if (
        !detail ||
        detail.clusterId !== stateCluster.current ||
        detail.clusterId !== activeId() ||
        (!detail.namespace && !detail.resourceScope)
      )
        return;
      setTab("Consumers");
      setNamespaceScope(detail.namespace);
      setResourceScope(detail.resourceScope);
      setFilter("");
      setNeedsAttention(false);
      setGroupMode(detail.namespace ? "namespace" : "workload");
      setNamespacesOpen(detail.namespace ? [detail.namespace] : []);
      viewState.current.scrollTop = 0;
      pendingScroll.current = undefined;
      if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    };
    window.addEventListener(DIAGNOSTICS_NAMESPACE_EVENT, focusNamespace);
    return () => window.removeEventListener(DIAGNOSTICS_NAMESPACE_EVENT, focusNamespace);
  }, []);
  const [observed, setObserved] = useState<TimelineEntry[]>([]);
  const previous = useRef<MonitoringSnapshot>();
  useEffect(() => {
    const release = retainMonitoringCollector();
    let disposed = false;
    let generation = 0;
    let loading = false;
    const clear = () => {
      generation++;
      previous.current = undefined;
      known.current.clear();
      setSnapshot(undefined);
      setObserved([]);
      saveDiagnosticsState(stateCluster.current, viewState.current);
      stateCluster.current = activeId() ?? "";
      const restored = readDiagnosticsState(stateCluster.current);
      setTab(restored.tab);
      setFilter(restored.filter);
      setNamespaceScope(restored.namespaceScope);
      setResourceScope(restored.resourceScope);
      setNeedsAttention(restored.needsAttention);
      setGroupMode(restored.groupMode);
      setNamespacesOpen(restored.namespacesOpen);
      setSort(restored.sort);
      setExpanded(restored.expanded);
      setSelected(restored.selected);
      setPendingUid(restored.pendingUid);
      setNotReadyUid(restored.notReadyUid ?? "");
      setReason(restored.reason);
      setWarningOnly(restored.warningOnly);
      setGroupedTimeline(restored.groupedTimeline);
      setOpenTimeline(restored.openTimeline);
      viewState.current = restored;
      pendingScroll.current = { clusterId: stateCluster.current, top: restored.scrollTop };
      setError("");
    };
    const load = async () => {
      if (loading || disposed || hidden()) return;
      const cluster = activeId();
      if (!cluster) {
        setError("Select a connected cluster");
        return;
      }
      const current = generation;
      loading = true;
      try {
        const next = await getMonitoringSnapshot(true);
        if (disposed || current !== generation || next.clusterId !== activeId() || hidden()) return;
        const prior = previous.current;
        if (prior === next) return;
        if (prior && prior.clusterId === next.clusterId) {
          const entries: TimelineEntry[] = [];
          if (prior.time !== next.time)
            entries.push(
              ...observeResourceChanges(prior.pods ?? [], next.pods ?? [], new Date(next.time).toISOString()),
            );
          if (prior.owners !== next.owners && next.diagnosticsTime)
            entries.push(
              ...observeResourceChanges(
                prior.owners ?? [],
                next.owners ?? [],
                new Date(next.diagnosticsTime).toISOString(),
              ),
            );
          if (entries.length) setObserved((items) => [...entries, ...items].slice(0, 300));
        }
        const projected = projection(next);
        for (const group of projected.groups) {
          const key = groupKey(group);
          const remembered = known.current.get(key)?.uids ?? new Set<string>();
          for (const uid of projected.related.get(key) ?? []) remembered.add(uid);
          while (remembered.size > 500) remembered.delete(remembered.values().next().value!);
          known.current.set(key, { group, uids: remembered });
        }
        while (known.current.size > 100) known.current.delete(known.current.keys().next().value!);
        previous.current = next;
        setSnapshot(next);
        setError("");
      } catch {
        if (!disposed && current === generation) setError("Diagnostics unavailable or access denied");
      } finally {
        loading = false;
      }
    };
    const stop = reaction(activeId, () => {
      clear();
      void load();
    });
    const visibility = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    const timer = window.setInterval(() => void load(), 1000);
    document.addEventListener("visibilitychange", visibility);
    void load();
    return () => {
      disposed = true;
      generation++;
      stop();
      release();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const data = snapshot?.clusterId === activeId() ? snapshot : undefined;
  useLayoutEffect(() => {
    const pending = pendingScroll.current;
    if (!data || !pending || pending.clusterId !== data.clusterId || !scrollContainer.current) return;
    // restore after the snapshot and expanded rows have committed, then guard initial layout scroll events
    scrollContainer.current.scrollTop = pending.top;
    const frame = requestAnimationFrame(() => {
      if (pendingScroll.current !== pending || !scrollContainer.current) return;
      scrollContainer.current.scrollTop = pending.top;
      viewState.current.scrollTop = scrollContainer.current.scrollTop;
      pendingScroll.current = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [data]);
  const projected = useMemo(() => (data ? projection(data) : undefined), [data]);
  const groups = useMemo(() => {
    if (!data || !projected) return [];
    if (!resourceScope) return projected.groups;
    if (resourceScope.kind === "Pod" || resourceScope.kind === "Node") {
      const pods = (data.pods ?? []).filter((pod) =>
        resourceScope.kind === "Pod"
          ? (resourceScope.uid ? pod.metadata.uid === resourceScope.uid : pod.metadata.name === resourceScope.name) &&
            (!namespaceScope || pod.metadata.namespace === namespaceScope)
          : pod.spec?.nodeName === resourceScope.name,
      );
      if (resourceScope.kind === "Pod") {
        // explicit pod navigation includes terminal pods while normal consumer totals exclude them
        const originalPods = new Map<DiagnosticsObject, DiagnosticsObject>();
        const focusedPods = pods.map((pod) => {
          const focused = { ...pod, status: { ...pod.status, phase: undefined } };
          originalPods.set(focused, pod);
          return focused;
        });
        return buildConsumerGroups(focusedPods, data.owners ?? [], projected.usage).map((group) => ({
          ...group,
          pods: group.pods.map((pod) => originalPods.get(pod)!),
        }));
      }
      return buildConsumerGroups(pods, data.owners ?? [], projected.usage);
    }
    return projected.groups.filter((group) =>
      resourceScope.uid
        ? group.identity === resourceScope.uid
        : group.kind === resourceScope.kind && group.name === resourceScope.name,
    );
  }, [data, projected, resourceScope, namespaceScope]);
  const filtered = useMemo(
    () =>
      groups
        .filter((group) => !namespaceScope || group.namespace === namespaceScope)
        .filter((group) =>
          `${group.namespace} ${group.name} ${group.kind}`.toLowerCase().includes(filter.toLowerCase()),
        )
        .filter((group) => !needsAttention || ["error", "warning"].includes(consumerStatus(group.pods).tone))
        .sort((a, b) =>
          sort === "name"
            ? a.namespace.localeCompare(b.namespace) ||
              a.name.localeCompare(b.name) ||
              a.kind.localeCompare(b.kind) ||
              a.identity.localeCompare(b.identity)
            : sort === "requests" || sort === "memoryRequests"
              ? b[sort === "requests" ? "cpu" : "memory"].requests - a[sort === "requests" ? "cpu" : "memory"].requests
              : (b[sort === "memory" ? "memory" : "cpu"].usage ?? -1) -
                (a[sort === "memory" ? "memory" : "cpu"].usage ?? -1),
        ),
    [groups, filter, namespaceScope, sort, needsAttention],
  );
  const warningUids = new Set(
    (data?.events ?? [])
      .filter((event) => event.type === "Warning")
      .map((event) => event.involvedObject?.uid ?? event.regarding?.uid)
      .filter((uid): uid is string => !!uid),
  );
  const applications = [...known.current.values()]
    .filter((item) => !warningOnly || [...item.uids].some((uid) => warningUids.has(uid)))
    .map((item) => item.group);
  const selectionAvailable = applications.some((group) => groupKey(group) === selected);
  const application = applications.find((group) => groupKey(group) === selected);
  const uids = new Set(known.current.get(selected)?.uids ?? []);
  const normalizedEvents = normalizeEvents(data?.events ?? []);
  const warningIds = new Set(
    normalizedEvents.filter((_entry, index) => data?.events?.[index]?.type === "Warning").map((entry) => entry.id),
  );
  const eventReferences = new Map(
    normalizedEvents.map((entry, index) => {
      const event = data?.events?.[index];
      return [entry.id, event?.involvedObject ?? event?.regarding] as const;
    }),
  );
  const timeline = [...normalizedEvents, ...observed]
    .filter(
      (entry) =>
        (!application || (!!entry.objectUid && uids.has(entry.objectUid))) &&
        (!reason || `${entry.reason} ${entry.message}`.toLowerCase().includes(reason.toLowerCase())) &&
        (!warningOnly || warningIds.has(entry.id)),
    )
    .sort((a, b) => (Date.parse(b.time ?? "") || 0) - (Date.parse(a.time ?? "") || 0));
  const timelineResource = (entry: TimelineEntry) => {
    const object = entry.objectUid ? projected?.objects.get(entry.objectUid) : undefined;
    const ref = eventReferences.get(entry.id);
    return `${object?.metadata.namespace ?? ref?.namespace ?? "Unknown namespace"} / ${object?.kind ?? ref?.kind ?? "Resource"} / ${object?.metadata.name ?? ref?.name ?? entry.objectUid ?? entry.id}`;
  };
  const timelineGroups = groupTimelineEntries(
    timeline,
    (entry) => {
      if (!warningIds.has(entry.id)) return entry.id;
      const owner = [...known.current.entries()].find(
        ([, item]) => !!entry.objectUid && item.uids.has(entry.objectUid),
      );
      return owner
        ? `${owner[1].group.namespace}/${owner[1].group.kind}/${owner[1].group.name}`
        : timelineResource(entry);
    },
    timelineResource,
  );
  const displayedTimeline = groupedTimeline ? timelineGroups.map((group) => group.latest) : timeline;
  useEffect(() => {
    if (!data || (tab !== "Consumers" && tab !== "Timeline")) return;
    const attach = () =>
      explainDiagnosticFinding(
        diagnosticsScreenFinding(data.clusterId, tab, filtered, displayedTimeline, timelineResource),
      );
    window.addEventListener("power-ai-request-screen-context", attach);
    return () => window.removeEventListener("power-ai-request-screen-context", attach);
  }, [data, tab, filtered, displayedTimeline]);
  const pending = (data?.pods ?? []).filter((pod) => pod.status?.phase === "Pending");
  const attentionPods = new Set(
    groups
      .filter((group) => !namespaceScope || group.namespace === namespaceScope)
      .flatMap((group) => group.pods)
      .filter((pod) => ["warning", "error"].includes(consumerStatus([pod]).tone))
      .map((pod) => pod.metadata.uid ?? pod),
  ).size;
  const AttentionCard = data?.pods ? "button" : "div";
  const notReady = (data?.pods ?? []).filter(
    (pod) => pod.status?.phase === "Running" && ["warning", "error"].includes(consumerStatus([pod]).tone),
  );
  const readinessView = tab === "Not ready";
  const triagePods = readinessView ? notReady : pending;
  const triageUid = readinessView ? notReadyUid : pendingUid;
  const triageLabel = readinessView ? "Not ready pod" : "Pending pod";
  const selectedPod = triagePods.find((pod) => pod.metadata.uid === triageUid);
  const diagnosis = selectedPod
    ? diagnosePendingPod(selectedPod, data?.nodes ?? [], data?.events ?? [], data?.pvcs)
    : undefined;
  return (
    <div
      ref={scrollContainer}
      onScroll={(event) => {
        if (!pendingScroll.current) viewState.current.scrollTop = event.currentTarget.scrollTop;
      }}
      className="power-diagnostics"
      style={{ padding: 24, overflow: "auto", height: "100%", minWidth: 0 }}
    >
      <style>{diagnosticsStyles}</style>
      <header className="diagnostics-header">
        <h2>Resource diagnostics</h2>
        <span className="snapshot-meta">Read-only snapshot{data ? ` · ${formatDateTime(data.time)}` : ""}</span>
      </header>
      <nav aria-label="Diagnostics views">
        {(["Consumers", "Timeline", "Pending", "Not ready"] as Tab[]).map((name) => (
          <NativeTooltip key={name} title={`Show ${name.toLowerCase()}`}>
            <button type="button" aria-pressed={tab === name} onClick={() => setTab(name)}>
              <AiIcon
                material={name === "Consumers" ? "account_tree" : name === "Timeline" ? "timeline" : "hourglass_empty"}
              />
              {name}
              {name === "Pending" && data?.pods
                ? ` (${pending.length})`
                : name === "Not ready" && data?.pods
                  ? ` (${notReady.length})`
                  : ""}
            </button>
          </NativeTooltip>
        ))}
      </nav>
      {error && (
        <p className="diagnostics-notice" role="status">
          {error}. Check the cluster connection and your access permissions.
        </p>
      )}
      {data?.errors.map((message) => (
        <p className="diagnostics-notice" role="status" key={message}>
          {message}
        </p>
      ))}
      <section className="view-intro">
        <h3>{viewDescriptions[tab][0]}</h3>
        <p>{viewDescriptions[tab][1]}</p>
      </section>
      {data && tab === "Consumers" && (
        <div className="diagnostics-summary" aria-label="Snapshot summary">
          <div className="summary-card workloads">
            <span className="summary-icon">
              <AiIcon material="account_tree" size={22} />
            </span>
            <div>
              <strong>{data.pods ? groups.length : "Unavailable"}</strong>
              <span>Workloads and standalone pods</span>
            </div>
          </div>
          <div className="summary-card pods">
            <span className="summary-icon">
              <AiIcon material="view_in_ar" size={22} />
            </span>
            <div>
              <strong>{data.pods?.length ?? "Unavailable"}</strong>
              <span>Pods in snapshot</span>
            </div>
          </div>
          <AttentionCard
            className={`summary-card pending${!data.pods ? " unavailable" : attentionPods ? " attention" : ""}`}
            {...(data.pods
              ? {
                  type: "button" as const,
                  title: "Show consumers needing attention",
                  "aria-label": "Show consumers needing attention",
                  onClick: () => {
                    setNeedsAttention(true);
                    setFilter("");
                  },
                }
              : {})}
          >
            <span className="summary-icon">
              <AiIcon material="warning_amber" size={22} />
            </span>
            <div>
              <strong>{data.pods ? attentionPods : "Unavailable"}</strong>
              <span>Needs attention</span>
            </div>
          </AttentionCard>
        </div>
      )}
      {!data && !error && (
        <p className="diagnostics-empty diagnostics-loading" role="status">
          <span className="diagnostics-loading-icon" aria-hidden="true">
            <AiIcon material="autorenew" size={16} />
          </span>
          Loading resource diagnostics…
        </p>
      )}
      {tab === "Consumers" && data && (
        <>
          {(resourceScope || namespaceScope) && (
            <div className="diagnostics-active-filters" aria-label="Active consumer filters">
              {resourceScope && (
                <div className="namespace-scope" role="status">
                  <AiIcon material="filter_alt" size={16} />
                  <span className="namespace-scope-label">
                    {resourceScope.kind}: {resourceScope.name}
                  </span>
                  <button type="button" aria-label="Clear resource scope" onClick={() => setResourceScope(undefined)}>
                    <AiIcon material="close" size={13} />
                    Show all resources
                  </button>
                </div>
              )}
              {namespaceScope && (
                <div className="namespace-scope" role="status">
                  <AiIcon material="filter_alt" size={16} />
                  <span className="namespace-scope-label">Namespace: {namespaceScope}</span>
                  <button type="button" aria-label="Clear namespace scope" onClick={() => setNamespaceScope(undefined)}>
                    <AiIcon material="close" size={13} />
                    Show all namespaces
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="toolbar consumers-toolbar">
            <label>
              Group by{" "}
              <DiagnosticsSelect
                label="Group consumers"
                value={groupMode}
                onChange={setGroupMode}
                options={[
                  { value: "workload", label: "Workload" },
                  { value: "namespace", label: "Namespace" },
                ]}
              />
            </label>
            <label className="search-field">
              Search consumers
              <span className="diagnostics-input">
                <Renderer.Component.Input
                  aria-label="Filter consumers"
                  placeholder="Namespace or workload"
                  value={filter}
                  onChange={setFilter}
                />
              </span>
            </label>
            <label>
              Sort{" "}
              <DiagnosticsSelect
                label="Sort consumers"
                value={sort}
                onChange={setSort}
                options={[
                  { value: "cpu", label: "CPU usage" },
                  { value: "memory", label: "Memory usage" },
                  { value: "requests", label: "CPU requests" },
                  { value: "memoryRequests", label: "Memory requests" },
                  { value: "name", label: "Namespace / name" },
                ]}
              />
            </label>
            <div className="warning-filter">
              <Renderer.Component.Checkbox
                label="Needs attention"
                value={needsAttention}
                onChange={setNeedsAttention}
              />
            </div>
          </div>
          <details className="diagnostics-explainer">
            <summary>How to read usage and requests</summary>
            <p>
              Usage is measured consumption. Requests are configured resource reservations. Coverage is reported
              separately for CPU and memory; missing metrics are unavailable, never zero. Requests from unscheduled pods
              appear separately.
            </p>
          </details>
          <div className="diagnostics-table">
            <table className="consumers-table">
              <colgroup>
                <col className="consumer-column" />
                <col className="metric-column" />
                <col className="metric-column" />
                <col className="unscheduled-column" />
              </colgroup>
              <thead>
                <tr>
                  <th>Namespace / consumer</th>
                  <th className="numeric">CPU usage / requests</th>
                  <th className="numeric">Memory usage / requests</th>
                  <th>Unscheduled requests</th>
                </tr>
              </thead>
              <tbody>
                {(groupMode === "namespace" ? [...new Set(filtered.map((group) => group.namespace))] : [""]).map(
                  (namespace) => (
                    <NamespaceRows
                      key={namespace}
                      namespace={namespace}
                      groups={namespace ? filtered.filter((group) => group.namespace === namespace) : filtered}
                      snapshotTime={data.time}
                      clusterId={data?.clusterId ?? ""}
                      usage={projected?.usage ?? []}
                      open={!namespace || namespacesOpen.includes(namespace)}
                      toggleNamespace={() =>
                        setNamespacesOpen((items) =>
                          items.includes(namespace)
                            ? items.filter((item) => item !== namespace)
                            : [...items, namespace],
                        )
                      }
                      expanded={expanded}
                      toggleGroup={(key) =>
                        setExpanded((items) =>
                          items.includes(key) ? items.filter((item) => item !== key) : [...items, key],
                        )
                      }
                    />
                  ),
                )}
              </tbody>
            </table>
          </div>
          {!filtered.length &&
            (!data.pods ? (
              <p className="diagnostics-empty">Pod inventory unavailable</p>
            ) : filter ? (
              <p className="diagnostics-empty">No consumers match this filter</p>
            ) : needsAttention && groups.length ? (
              <div
                className={`diagnostics-empty attention-empty ${groups.every((group) => consumerStatus(group.pods).tone === "healthy") ? "all-ready" : "readiness-unconfirmed"}`}
              >
                <AiIcon
                  material={
                    groups.every((group) => consumerStatus(group.pods).tone === "healthy")
                      ? "check_circle_outline"
                      : "info_outline"
                  }
                  size={22}
                />
                <strong>
                  {groups.every((group) => consumerStatus(group.pods).tone === "healthy")
                    ? "All consumers are ready"
                    : "No known issues"}
                </strong>
                <small>
                  {groups.every((group) => consumerStatus(group.pods).tone === "healthy")
                    ? "No pending pods or known failures in this snapshot."
                    : "Unconfirmed readiness is not treated as a failure. Show all consumers to inspect them."}
                </small>
                <button type="button" onClick={() => setNeedsAttention(false)}>
                  Show all consumers
                </button>
              </div>
            ) : (
              <p className="diagnostics-empty">No consumers available</p>
            ))}
        </>
      )}
      {tab === "Timeline" && data && (
        <>
          <div className="toolbar timeline-toolbar">
            <label>
              Application{" "}
              <DiagnosticsSelect
                label="Timeline application"
                value={selectionAvailable ? selected : ""}
                onChange={setSelected}
                options={[
                  { value: "", label: "All applications" },
                  ...applications.map((group) => ({
                    value: groupKey(group),
                    label: `${group.namespace} / ${group.kind} / ${group.name}`,
                  })),
                ]}
              />
            </label>
            <label className="search-field">
              Search events
              <span className="diagnostics-input">
                <Renderer.Component.Input
                  aria-label="Filter timeline reason"
                  placeholder="Reason or message"
                  value={reason}
                  onChange={setReason}
                />
              </span>
            </label>
            <div className="warning-filter">
              <Renderer.Component.Checkbox label="Warnings only" value={warningOnly} onChange={setWarningOnly} />
            </div>
          </div>
          <details className="diagnostics-explainer">
            <summary>Timeline coverage and timing</summary>
            <p>
              Kubernetes events have limited retention. Observed changes begin with this open view, retain at most 300
              entries, and have unknown transition times between snapshots. Related identities observed in this view are
              retained for at most 100 applications and 500 identities per application; older identity coverage can be
              incomplete.
            </p>
          </details>
          <div className="warning-filter">
            <Renderer.Component.Checkbox
              label="Group recurring warnings"
              value={groupedTimeline}
              onChange={setGroupedTimeline}
            />
          </div>
          <div className="timeline-legend" aria-label="Event types">
            {["Warning", "Rollout", "Restart", "Readiness", "Kubernetes event", "Observed change"].map((label) => (
              <span key={label} className={`timeline-type ${eventCategory(label)}`}>
                {label}
              </span>
            ))}
          </div>
          <ol className="diagnostics-timeline" aria-label="Workload event timeline">
            {displayedTimeline.map((entry) => {
              const recurrence = groupedTimeline ? timelineGroups.find((group) => group.latest === entry) : undefined;
              const kind = eventCategory(entry.reason);
              const category = warningIds.has(entry.id)
                ? "warning"
                : kind === "event" && entry.certainty === "observed"
                  ? "observed"
                  : kind;
              const label =
                category === "warning"
                  ? "Warning"
                  : category === "rollout"
                    ? "Rollout"
                    : category === "restart"
                      ? "Restart"
                      : category === "readiness"
                        ? "Readiness"
                        : entry.certainty === "observed"
                          ? "Observed change"
                          : "Kubernetes event";
              const object = entry.objectUid ? projected?.objects.get(entry.objectUid) : undefined;
              const reference = eventReferences.get(entry.id);
              const referenceKind = object?.kind ?? reference?.kind;
              const metadata = object?.metadata ?? reference;
              return (
                <li key={entry.id} className={`timeline-entry ${category}`}>
                  <div className="timeline-time">
                    {entry.time ? <time dateTime={entry.time}>{formatDateTime(entry.time)}</time> : "Time unknown"}
                    <small>{entry.certainty === "observed" ? "Observed at snapshot" : "Kubernetes event time"}</small>
                  </div>
                  <div className="timeline-content">
                    <div className="timeline-card-top">
                      <div className="timeline-card-heading">
                        {" "}
                        <span className={`timeline-type ${category}`}>{label}</span>
                        <h4>{entry.reason}</h4>
                        <small className="timeline-resource-identity">
                          <AiIcon material={referenceKind === "Pod" ? "view_in_ar" : "account_tree"} size={12} />
                          {metadata?.name
                            ? `${metadata.namespace ?? "Namespace unknown"} / ${referenceKind ?? "Resource"} / ${metadata.name}`
                            : "Resource identity unavailable"}
                        </small>
                      </div>
                      <div className="timeline-card-actions" role="group" aria-label="Event actions">
                        {object && data && (
                          <NativeTooltip
                            title={`Open ${object.kind ?? "Pod"} ${object.metadata.namespace} / ${object.metadata.name}`}
                          >
                            <button
                              type="button"
                              className="timeline-resource-action"
                              aria-label="Open resource"
                              onClick={(event) => openResource(object, data.clusterId, event)}
                            >
                              <AiIcon material="open_in_new" />
                            </button>
                          </NativeTooltip>
                        )}
                        <IncidentCopyButton
                          clusterId={data.clusterId}
                          incident={{
                            problem: entry.reason,
                            facts: [
                              entry.message,
                              `Reported count ${recurrence?.count ?? entry.count}`,
                              ...((recurrence?.affected ?? []).length > 1
                                ? [`Affected resources: ${recurrence?.affected.join("; ")}`]
                                : []),
                            ],
                            time: entry.time ?? data.time,
                            resources: (recurrence?.entries ?? [entry]).slice(0, 12).flatMap((original) => {
                              const originalObject = original.objectUid
                                ? projected?.objects.get(original.objectUid)
                                : undefined;
                              const originalReference = eventReferences.get(original.id);
                              const originalMetadata = originalObject?.metadata ?? originalReference;
                              const originalKind = originalObject?.kind ?? originalReference?.kind;
                              return originalMetadata?.name && originalKind
                                ? [
                                    {
                                      kind: originalKind,
                                      namespace: originalMetadata.namespace,
                                      name: originalMetadata.name,
                                    },
                                  ]
                                : [];
                            }),
                          }}
                        />
                        <DiagnosticExplainButton
                          type="button"
                          className="explain-finding"
                          aria-label="Explain with AI"
                          title="Explain with AI"
                          onClick={() =>
                            explainDiagnosticFinding({
                              clusterId: data.clusterId,
                              title: entry.reason,
                              summary: `${timelineResource(entry)}: ${entry.message}. Reported count ${recurrence?.count ?? entry.count}`,
                              resource:
                                metadata?.name && referenceKind
                                  ? { kind: referenceKind, namespace: metadata.namespace, name: metadata.name }
                                  : undefined,
                            })
                          }
                        >
                          <AiIcon material="auto_awesome" size={13} />
                          <span className="timeline-action-label">Explain with AI</span>
                        </DiagnosticExplainButton>
                      </div>
                    </div>
                    <p>{entry.message}</p>
                    <small>
                      {entry.certainty === "reported"
                        ? "Reported"
                        : entry.certainty === "observed"
                          ? "Observed"
                          : "Unknown"}{" "}
                      · Count {recurrence?.count ?? entry.count}
                      {entry.firstTime ? ` · First ${formatDateTime(entry.firstTime)}` : ""}
                    </small>
                    {entry.gap && <small>{entry.gap}</small>}
                    {recurrence && recurrence.entries.length > 1 && (
                      <details
                        open={openTimeline.includes(recurrence.key)}
                        onToggle={(event) => {
                          const open = event.currentTarget.open;
                          setOpenTimeline((items) =>
                            open
                              ? [...new Set([...items, recurrence.key])]
                              : items.filter((item) => item !== recurrence.key),
                          );
                        }}
                      >
                        <summary>
                          {recurrence.affected.length} affected resources · {recurrence.entries.length} original entries
                        </summary>
                        <small>{recurrence.affected.join(" · ")}</small>
                        <ul>
                          {recurrence.entries.map((original, index) => (
                            <li key={`${original.id}/${index}`}>
                              <small>
                                {original.time ? formatDateTime(original.time) : "Time unknown"} ·{" "}
                                {timelineResource(original)} · Count {original.count}
                              </small>
                              {original.message}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {!timeline.length && (
            <div className="diagnostics-empty">
              <p>
                {warningOnly
                  ? "No retained warning events match these filters"
                  : "No retained events or observed changes match these filters"}
              </p>
              {warningOnly && (
                <button type="button" onClick={() => setWarningOnly(false)}>
                  Show all events
                </button>
              )}
            </div>
          )}
        </>
      )}
      {(tab === "Pending" || readinessView) && data && (
        <>
          <label>
            {triageLabel}{" "}
            <DiagnosticsSelect
              label={triageLabel}
              value={triageUid}
              onChange={readinessView ? setNotReadyUid : setPendingUid}
              options={[
                { value: "", label: "Select a pod" },
                ...triagePods.map((pod) => ({
                  value: pod.metadata.uid ?? "",
                  label: `${pod.metadata.namespace} / ${pod.metadata.name}`,
                })),
              ]}
            />
          </label>
          {selectedPod && diagnosis ? (
            <>
              <div className={`pending-heading ${consumerStatus([selectedPod]).tone}`}>
                <div className="pending-title-row">
                  <div>
                    <strong>
                      {selectedPod.metadata.namespace} / {selectedPod.metadata.name}
                    </strong>
                    <div className="pending-state-row">
                      <h3>
                        {readinessView
                          ? "Not ready"
                          : diagnosis.state === "assigned-waiting"
                            ? "Assigned and waiting"
                            : "Unscheduled"}
                      </h3>
                      {consumerStatus([selectedPod]).tone === "error" && <ConsumerStatus pods={[selectedPod]} />}
                    </div>
                  </div>
                  <NativeTooltip title="Open pod details">
                    <button
                      className="pending-open-action"
                      type="button"
                      onClick={(event) => openResource(selectedPod, data!.clusterId, event)}
                    >
                      <AiIcon material="open_in_new" size={15} />
                      Open pod
                    </button>
                  </NativeTooltip>
                </div>
                <p>
                  {readinessView
                    ? "The pod is running but needs attention. Check readiness conditions, container status and events."
                    : diagnosis.state === "assigned-waiting"
                      ? "A node is assigned. Check pod conditions and events for startup or storage issues."
                      : "No node is assigned. Start with scheduler events, then inspect constraints."}
                </p>
                <div className="pending-request-badges">
                  <span>
                    <AiIcon material="memory" size={14} />
                    CPU request <strong>{podRequest(selectedPod, "cpu")}</strong>
                  </span>
                  <span>
                    <AiIcon material="storage" size={14} />
                    Memory request <strong>{podRequest(selectedPod, "memory")}</strong>
                  </span>
                </div>
              </div>
              <details className="diagnostics-explainer">
                <summary>Scheduling constraints and pod conditions</summary>
                <p>
                  Node selector:{" "}
                  {Object.entries(selectedPod.spec?.nodeSelector ?? {})
                    .map(([key, value]) => `${key}=${value}`)
                    .join(", ") || "None"}
                </p>
                <p>
                  Tolerations:{" "}
                  {(selectedPod.spec?.tolerations ?? [])
                    .map(
                      (item) =>
                        `${item.key || "all keys"} ${item.operator ?? "Equal"}${item.value ? ` ${item.value}` : ""} (${item.effect || "all effects"})`,
                    )
                    .join(", ") || "None"}
                </p>
                <p>
                  Required node affinity:{" "}
                  {selectedPod.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution
                    ? JSON.stringify(
                        selectedPod.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution,
                      ).slice(0, 2000)
                    : "None"}
                </p>

                <p>
                  {selectedPod.status?.conditions
                    ?.map(
                      (condition) =>
                        `${condition.type}: ${condition.status}${condition.message ? ` (${condition.message})` : ""}`,
                    )
                    .join(" · ")}
                </p>
              </details>
              <IncidentCopyButton
                clusterId={data.clusterId}
                incident={{
                  problem: triageLabel,
                  facts: [
                    readinessView ? consumerStatus([selectedPod]).label : diagnosis.state,
                    `CPU request ${podRequest(selectedPod, "cpu")}; memory request ${podRequest(selectedPod, "memory")}`,
                    ...diagnosis.evidence.slice(0, 8).map((entry) => entry.message),
                  ],
                  time: data.time,
                  resources: [
                    { kind: "Pod", namespace: selectedPod.metadata.namespace, name: selectedPod.metadata.name! },
                  ],
                }}
              />
              <DiagnosticExplainButton
                type="button"
                className="explain-finding"
                onClick={() =>
                  explainDiagnosticFinding({
                    clusterId: data.clusterId,
                    title: triageLabel,
                    summary: `${readinessView ? consumerStatus([selectedPod]).label : diagnosis.state}. CPU request ${podRequest(selectedPod, "cpu")}, memory request ${podRequest(selectedPod, "memory")}. ${diagnosis.evidence
                      .slice(0, 8)
                      .map((entry) => entry.message)
                      .join("; ")}`,
                    resource: {
                      kind: "Pod",
                      namespace: selectedPod.metadata.namespace,
                      name: selectedPod.metadata.name!,
                    },
                  })
                }
              >
                <AiIcon material="auto_awesome" size={13} />
                Explain with AI
              </DiagnosticExplainButton>
              <h3>{readinessView ? "Readiness and retained evidence" : "Scheduling evidence"}</h3>
              <div className="diagnostics-table">
                <table className="evidence-table">
                  <colgroup>
                    <col className="evidence-source" />
                    <col className="evidence-node" />
                    <col className="evidence-finding" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Evidence source</th>
                      <th>Node</th>
                      <th>Finding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diagnosis.evidence.map((entry, index) => (
                      <tr key={`${entry.node}/${index}`}>
                        <td>
                          <span className={`evidence-badge ${entry.source === "event" ? "reported" : "inferred"}`}>
                            <AiIcon material={entry.source === "event" ? "receipt_long" : "rule"} size={13} />
                            {entry.source === "event" ? "Reported" : "Inferred"}
                          </span>
                          <small>
                            {entry.source === "event" ? "Reported Kubernetes event" : "Local hard constraint"}
                          </small>
                        </td>
                        <td>{entry.node ?? "—"}</td>
                        <td>{entry.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!diagnosis.evidence.length && <p>No retained evidence is available for this pod</p>}
              <details className="diagnostics-explainer">
                <summary>What this diagnosis can establish</summary>
                {diagnosis.limitations.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </details>
            </>
          ) : (
            <p className="diagnostics-empty">
              {!data.pods
                ? `Pod inventory unavailable. Check cluster access before investigating ${readinessView ? "readiness" : "pending pods"}.`
                : triagePods.length
                  ? `Select a ${readinessView ? "not ready" : "pending"} pod to see evidence and requests`
                  : `No ${readinessView ? "not ready" : "pending"} pods in this snapshot`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
function ConsumerRows({
  group,
  clusterId,
  snapshotTime,
  expanded,
  toggle,
  usage,
  depth,
}: {
  group: ConsumerGroup;
  depth: number;
  clusterId: string;
  snapshotTime: number;
  expanded: boolean;
  toggle: () => void;
  usage: PodUsage[];
}) {
  return (
    <>
      <tr
        className={`consumer-workload-row consumer-depth-${depth} consumer-tone-${consumerStatus(group.pods).tone}`}
        data-row-depth={depth}
      >
        <td>
          <div className="consumer-identity-row">
            <div className="consumer-identity-main">
              <div className="consumer-title-line">
                {group.ownerResolved && resources[group.kind] && group.name !== "Unknown" ? (
                  <NativeTooltip title={`Open ${group.kind} ${group.namespace} / ${group.name}`}>
                    <button
                      className="consumer-resource-link"
                      type="button"
                      onClick={(event) =>
                        openResource(
                          {
                            kind: group.kind,
                            metadata: { uid: group.identity, namespace: group.namespace, name: group.name },
                          },
                          clusterId,
                          event,
                        )
                      }
                    >
                      <span className="consumer-link-name">{group.name}</span>
                    </button>
                  </NativeTooltip>
                ) : (
                  <span className="consumer-identity-label">{group.name}</span>
                )}
                <ConsumerStatus pods={group.pods} />
              </div>
              <small className="consumer-subtitle">
                <AiIcon material="folder_open" size={12} />
                {group.namespace}
                <span>·</span>
                <AiIcon material={group.kind === "Pod" ? "view_in_ar" : "account_tree"} size={12} />
                {group.kind}
                <span>·</span>
                {group.pods.length} pods{group.ownerResolved ? "" : " · Owner chain incomplete"}
              </small>
            </div>
            <div className="consumer-row-actions">
              {["warning", "error"].includes(consumerStatus(group.pods).tone) && (
                <IncidentCopyButton
                  clusterId={clusterId}
                  incident={{
                    problem: `${group.kind} ${group.name}: ${consumerStatus(group.pods).label}`,
                    facts: [
                      `${group.pods.length} pods`,
                      `CPU ${resourceText(group.cpu.usage, "cpu")} used / ${resourceText(group.cpu.requests, "cpu")} requested`,
                      `Memory ${resourceText(group.memory.usage, "memory")} used / ${resourceText(group.memory.requests, "memory")} requested`,
                    ],
                    time: snapshotTime,
                    resources: [{ kind: group.kind, namespace: group.namespace, name: group.name }],
                  }}
                />
              )}

              {["warning", "error"].includes(consumerStatus(group.pods).tone) && (
                <DiagnosticExplainButton
                  type="button"
                  className="explain-finding"
                  title="Explain with AI"
                  aria-label={`Explain finding for ${group.name}`}
                  onClick={() =>
                    explainDiagnosticFinding({
                      clusterId,
                      title: `${group.kind} ${group.name}`,
                      summary: `${consumerStatus(group.pods).label}; ${group.pods.length} pods. CPU ${resourceText(group.cpu.usage, "cpu")} used / ${resourceText(group.cpu.requests, "cpu")} requested; memory ${resourceText(group.memory.usage, "memory")} used / ${resourceText(group.memory.requests, "memory")} requested`,
                      resource: { kind: group.kind, namespace: group.namespace, name: group.name },
                    })
                  }
                >
                  <AiIcon material="auto_awesome" size={13} />
                </DiagnosticExplainButton>
              )}

              <span className="consumer-expand-slot">
                <NativeTooltip title={expanded ? "Collapse pods" : "Expand pods"}>
                  <button
                    className="consumer-expand"
                    type="button"
                    aria-label={`${expanded ? "Collapse" : "Expand"} pods for ${group.name}`}
                    aria-expanded={expanded}
                    onClick={toggle}
                  >
                    <AiIcon material={expanded ? "expand_less" : "expand_more"} />
                  </button>
                </NativeTooltip>
              </span>
            </div>
          </div>
        </td>
        <td className="numeric">
          <ResourceCell summary={group.cpu} metric="cpu" />
        </td>
        <td className="numeric">
          <ResourceCell summary={group.memory} metric="memory" />
        </td>
        <td className="numeric">
          <UnscheduledCell cpu={group.cpu} memory={group.memory} />
        </td>
      </tr>
      {expanded &&
        group.pods.map((pod) => (
          <tr
            key={pod.metadata.uid}
            className={`consumer-pod-row consumer-depth-${depth + 1} consumer-tone-${consumerStatus([pod]).tone}`}
            data-row-depth={depth + 1}
          >
            <td>
              <div className="consumer-identity-row">
                <div className="consumer-identity-main">
                  <div className="consumer-title-line">
                    <NativeTooltip title="Open pod details">
                      <button
                        className="consumer-resource-link"
                        type="button"
                        onClick={(event) => openResource(pod, clusterId, event)}
                      >
                        <AiIcon material="view_in_ar" size={14} />
                        <span className="consumer-link-name">{pod.metadata.name}</span>
                      </button>
                    </NativeTooltip>
                    <ConsumerStatus pods={[pod]} />
                  </div>
                  <small className="consumer-subtitle">
                    {pod.status?.phase ?? "Unknown"}
                    <span>·</span>
                    {pod.spec?.nodeName ? `Node ${pod.spec.nodeName}` : "No node assigned"}
                  </small>
                </div>
              </div>
            </td>
            <td className="numeric">
              <ResourceCell summary={podResourceGroup(pod, usage).cpu} metric="cpu" />
            </td>
            <td className="numeric">
              <ResourceCell summary={podResourceGroup(pod, usage).memory} metric="memory" />
            </td>
            <td className="numeric">
              <NativeTooltip
                title={
                  pod.spec?.nodeName
                    ? "No unscheduled requests"
                    : "Unscheduled requests are included in the workload total"
                }
              >
                <span className="unscheduled-empty">{pod.spec?.nodeName ? "—" : "Included above"}</span>
              </NativeTooltip>
            </td>
          </tr>
        ))}
    </>
  );
}

function podRequest(pod: DiagnosticsObject, metric: "cpu" | "memory"): string {
  try {
    return resourceText(effectivePodResource(pod, metric), metric);
  } catch {
    return "Unavailable";
  }
}
function NamespaceRows({
  namespace,
  groups,
  clusterId,
  snapshotTime,
  usage,
  open,
  toggleNamespace,
  expanded,
  toggleGroup,
}: {
  namespace: string;
  groups: ConsumerGroup[];
  clusterId: string;
  snapshotTime: number;
  usage: PodUsage[];
  open: boolean;
  toggleNamespace: () => void;
  expanded: string[];
  toggleGroup: (key: string) => void;
}) {
  const sum = (metric: "cpu" | "memory"): ResourceSummary =>
    groups.reduce(
      (total, group) => {
        const next = group[metric];
        return {
          requests: total.requests + next.requests,
          scheduledRequests: total.scheduledRequests + next.scheduledRequests,
          unscheduledRequests: total.unscheduledRequests + next.unscheduledRequests,
          usage:
            total.usage === undefined && next.usage === undefined ? undefined : (total.usage ?? 0) + (next.usage ?? 0),
          coveredPods: total.coveredPods + next.coveredPods,
          totalPods: total.totalPods + next.totalPods,
          unknownRequestPods: total.unknownRequestPods + next.unknownRequestPods,
        };
      },
      {
        requests: 0,
        scheduledRequests: 0,
        unscheduledRequests: 0,
        coveredPods: 0,
        totalPods: 0,
        unknownRequestPods: 0,
      } as ResourceSummary,
    );
  return (
    <>
      {namespace && (
        <tr
          className={`consumer-namespace-row consumer-depth-0 consumer-tone-${consumerStatus(groups.flatMap((group) => group.pods)).tone}`}
          data-row-depth={0}
        >
          <td>
            <div className="consumer-identity-row">
              <div className="consumer-identity-main">
                <div className="consumer-title-line">
                  <NativeTooltip title="Open namespace">
                    <button
                      type="button"
                      className="consumer-resource-link namespace-identity"
                      onClick={(event) =>
                        openResource({ kind: "Namespace", metadata: { name: namespace } }, clusterId, event)
                      }
                    >
                      <AiIcon material="folder_open" size={17} />
                      <span className="consumer-link-name">{namespace}</span>
                    </button>
                  </NativeTooltip>
                  <ConsumerStatus pods={groups.flatMap((group) => group.pods)} />
                  <small>
                    {groups.filter((group) => consumerStatus(group.pods).tone === "healthy").length} ready ·{" "}
                    {groups.filter((group) => ["warning", "error"].includes(consumerStatus(group.pods).tone)).length}{" "}
                    need attention · {groups.filter((group) => consumerStatus(group.pods).tone === "neutral").length}{" "}
                    unknown
                  </small>
                </div>
                <NativeTooltip title="Resource totals include only consumers shown by the current filters">
                  <small className="consumer-subtitle">
                    {groups.length} filtered consumers<span>·</span>
                    {groups.reduce((total, group) => total + group.pods.length, 0)} pods
                  </small>
                </NativeTooltip>
              </div>
              <span className="consumer-expand-slot">
                <NativeTooltip title={open ? "Collapse namespace workloads" : "Expand namespace workloads"}>
                  <button
                    className="consumer-expand"
                    type="button"
                    aria-label={`${open ? "Collapse" : "Expand"} workloads in ${namespace}`}
                    aria-expanded={open}
                    onClick={toggleNamespace}
                  >
                    <AiIcon material={open ? "expand_less" : "expand_more"} />
                  </button>
                </NativeTooltip>
              </span>
            </div>
          </td>
          <td className="numeric">
            <ResourceCell summary={sum("cpu")} metric="cpu" />
          </td>
          <td className="numeric">
            <ResourceCell summary={sum("memory")} metric="memory" />
          </td>
          <td className="numeric">
            <UnscheduledCell cpu={sum("cpu")} memory={sum("memory")} />
          </td>
        </tr>
      )}
      {open &&
        groups.map((group) => (
          <ConsumerRows
            key={groupKey(group)}
            group={group}
            depth={namespace ? 1 : 0}
            snapshotTime={snapshotTime}
            clusterId={clusterId}
            expanded={expanded.includes(groupKey(group))}
            toggle={() => toggleGroup(groupKey(group))}
            usage={usage}
          />
        ))}
    </>
  );
}

function podResourceGroup(pod: DiagnosticsObject, usage: PodUsage[]): ConsumerGroup {
  return buildConsumerGroups(
    [
      {
        ...pod,
        kind: "Pod",
        metadata: { ...pod.metadata, ownerReferences: [] },
        status: { ...pod.status, phase: undefined },
      },
    ],
    [],
    usage,
  )[0]!;
}
function eventCategory(reason: string): string {
  if (reason === "Observed change") return "observed";
  if (reason === "Warning") return "warning";
  if (["Rollout", "RolloutObserved"].includes(reason)) return "rollout";
  if (reason === "Restart" || reason.startsWith("Restarts/")) return "restart";
  if (reason === "Readiness" || reason.startsWith("Readiness/")) return "readiness";
  return "event";
}
