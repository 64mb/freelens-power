import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
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
import { AiIcon } from "./ai-icon";
import { diagnosticsStyles } from "./diagnostics.css";
import {
  getCollectedPodUsage,
  getMonitoringSnapshot,
  type MonitoringSnapshot,
  retainMonitoringCollector,
} from "./monitoring-collector";

const viewDescriptions = {
  Consumers: [
    "What is using cluster resources?",
    "Compare workload usage and requests, then expand a workload to inspect its pods.",
  ],
  Timeline: [
    "What changed in this workload?",
    "Follow related Kubernetes events and changes observed while this view is open.",
  ],
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
      <small
        className="resource-coverage"
        title="Coverage is per resource. Missing metrics are unavailable, never zero."
      >
        {summary.coveredPods}/{summary.totalPods} pods covered
        {summary.unknownRequestPods ? ` · ${summary.unknownRequestPods} requests unknown` : ""}
        {ratio ? ` · ${ratio}` : ""}
      </small>
      {complete && summary.usage !== undefined && summary.requests > 0 && summary.usage > summary.requests && (
        <span
          className="request-burst"
          title="Usage exceeds configured requests. Requests are reservations, not limits; this alone does not indicate a failure."
        >
          <AiIcon material="info_outline" size={12} />
          Above requests
        </span>
      )}
    </div>
  );
}
function UnscheduledCell({ cpu, memory }: { cpu: ResourceSummary; memory: ResourceSummary }) {
  const partial = cpu.unknownRequestPods || memory.unknownRequestPods;
  if (!partial && !cpu.unscheduledRequests && !memory.unscheduledRequests)
    return (
      <span className="unscheduled-empty" title="No unscheduled requests">
        —
      </span>
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
    pods.some((pod) =>
      pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "False"),
    )
  )
    return { tone: "warning", label: "Not ready", icon: "warning_amber" };
  if (
    pods.length &&
    pods.every(
      (pod) =>
        pod.status?.phase === "Running" &&
        pod.status.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True"),
    )
  )
    return { tone: "healthy", label: "Ready", icon: "check_circle_outline" };
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
type Tab = "Consumers" | "Timeline" | "Pending";
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
  if (activeId() !== clusterId || !object.metadata.name || !object.metadata.namespace || !resources[kind]) return;
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
  const [tab, setTab] = useState<Tab>("Consumers");
  const [snapshot, setSnapshot] = useState<MonitoringSnapshot>();
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [needsAttention, setNeedsAttention] = useState(true);
  const [groupMode, setGroupMode] = useState("workload");
  const [namespacesOpen, setNamespacesOpen] = useState<string[]>([]);
  const known = useRef(new Map<string, { group: ConsumerGroup; uids: Set<string> }>());
  const [sort, setSort] = useState("cpu");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [pendingUid, setPendingUid] = useState("");
  const [reason, setReason] = useState("");
  const [warningOnly, setWarningOnly] = useState(true);
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
      setSelected("");
      setPendingUid("");
      setExpanded([]);
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
  const projected = useMemo(() => (data ? projection(data) : undefined), [data]);
  const groups = projected?.groups ?? [];
  const filtered = useMemo(
    () =>
      groups
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
    [groups, filter, sort, needsAttention],
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
  useEffect(() => {
    if (selected && !selectionAvailable) setSelected("");
  }, [selected, selectionAvailable]);
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
  const pending = (data?.pods ?? []).filter((pod) => pod.status?.phase === "Pending");
  const PendingCard = pending.length && data?.pods ? "button" : "div";
  const selectedPod = pending.find((pod) => pod.metadata.uid === pendingUid);
  const diagnosis = selectedPod
    ? diagnosePendingPod(selectedPod, data?.nodes ?? [], data?.events ?? [], data?.pvcs)
    : undefined;
  return (
    <div className="power-diagnostics" style={{ padding: 24, overflow: "auto", height: "100%", minWidth: 0 }}>
      <style>{diagnosticsStyles}</style>
      <header className="diagnostics-header">
        <h2>Resource diagnostics</h2>
        <span className="snapshot-meta">Read-only snapshot{data ? ` · ${formatDateTime(data.time)}` : ""}</span>
      </header>
      <nav aria-label="Diagnostics views">
        {(["Consumers", "Timeline", "Pending"] as Tab[]).map((name) => (
          <button
            key={name}
            type="button"
            title={`Show ${name.toLowerCase()}`}
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
          >
            <AiIcon
              material={name === "Consumers" ? "account_tree" : name === "Timeline" ? "timeline" : "hourglass_empty"}
            />
            {name}
            {name === "Pending" && data?.pods ? ` (${pending.length})` : ""}
          </button>
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
          <PendingCard
            className={`summary-card pending${!data.pods ? " unavailable" : pending.length ? " attention" : ""}`}
            {...(pending.length
              ? {
                  type: "button" as const,
                  title: "Inspect pending pods",
                  "aria-label": "Inspect pending pods",
                  onClick: () => {
                    setPendingUid(pending[0]?.metadata.uid ?? "");
                    setTab("Pending");
                  },
                }
              : {})}
          >
            <span className="summary-icon">
              <AiIcon material="hourglass_empty" size={22} />
            </span>
            <div>
              <strong>{data.pods ? pending.length : "Unavailable"}</strong>
              <span>Pending pods</span>
            </div>
          </PendingCard>
        </div>
      )}
      {!data && !error && (
        <p className="diagnostics-empty" role="status">
          Loading resource diagnostics…
        </p>
      )}
      {tab === "Consumers" && data && (
        <>
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
          <div className="timeline-legend" aria-label="Event types">
            {["Warning", "Rollout", "Restart", "Readiness", "Kubernetes event", "Observed change"].map((label) => (
              <span key={label} className={`timeline-type ${eventCategory(label)}`}>
                {label}
              </span>
            ))}
          </div>
          <ol className="diagnostics-timeline" aria-label="Workload event timeline">
            {timeline.map((entry) => {
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
                    {object && data && (
                      <button
                        type="button"
                        className="timeline-resource-action"
                        aria-label="Open resource"
                        title={`Open ${object.kind ?? "Pod"} ${object.metadata.namespace} / ${object.metadata.name}`}
                        onClick={(event) => openResource(object, data.clusterId, event)}
                      >
                        <AiIcon material="open_in_new" />
                      </button>
                    )}
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
                    <p>{entry.message}</p>
                    <small>
                      {entry.certainty === "reported"
                        ? "Reported"
                        : entry.certainty === "observed"
                          ? "Observed"
                          : "Unknown"}{" "}
                      · Count {entry.count}
                      {entry.firstTime ? ` · First ${formatDateTime(entry.firstTime)}` : ""}
                    </small>
                    {entry.gap && <small>{entry.gap}</small>}
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
      {tab === "Pending" && data && (
        <>
          <label>
            Pending pod{" "}
            <DiagnosticsSelect
              label="Pending pod"
              value={pendingUid}
              onChange={setPendingUid}
              options={[
                { value: "", label: "Select a pod" },
                ...pending.map((pod) => ({
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
                      <h3>{diagnosis.state === "assigned-waiting" ? "Assigned and waiting" : "Unscheduled"}</h3>
                      {consumerStatus([selectedPod]).tone === "error" && <ConsumerStatus pods={[selectedPod]} />}
                    </div>
                  </div>
                  <button
                    className="pending-open-action"
                    type="button"
                    title="Open pod details"
                    onClick={(event) => openResource(selectedPod, data!.clusterId, event)}
                  >
                    <AiIcon material="open_in_new" size={15} />
                    Open pod
                  </button>
                </div>
                <p>
                  {diagnosis.state === "assigned-waiting"
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
              <h3>Scheduling evidence</h3>
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
                ? "Pod inventory unavailable. Check cluster access before investigating pending pods."
                : pending.length
                  ? "Select a pending pod to see scheduling evidence and requests"
                  : "No pending pods in this snapshot"}
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
  expanded,
  toggle,
  usage,
  depth,
}: {
  group: ConsumerGroup;
  depth: number;
  clusterId: string;
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
                  <button
                    className="consumer-resource-link"
                    type="button"
                    title={`Open ${group.kind} ${group.namespace} / ${group.name}`}
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
                    {group.name}
                    <AiIcon material="open_in_new" size={13} />
                  </button>
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
              <span className="consumer-expand-slot">
                <button
                  className="consumer-expand"
                  type="button"
                  title={expanded ? "Collapse pods" : "Expand pods"}
                  aria-label={`${expanded ? "Collapse" : "Expand"} pods for ${group.name}`}
                  aria-expanded={expanded}
                  onClick={toggle}
                >
                  <AiIcon material={expanded ? "expand_less" : "expand_more"} />
                </button>
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
                    <button
                      className="consumer-resource-link"
                      type="button"
                      title="Open pod details"
                      onClick={(event) => openResource(pod, clusterId, event)}
                    >
                      <AiIcon material="view_in_ar" size={14} />
                      {pod.metadata.name}
                      <AiIcon material="open_in_new" size={12} />
                    </button>
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
              <span
                className="unscheduled-empty"
                title={
                  pod.spec?.nodeName
                    ? "No unscheduled requests"
                    : "Unscheduled requests are included in the workload total"
                }
              >
                {pod.spec?.nodeName ? "—" : "Included above"}
              </span>
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
  usage,
  open,
  toggleNamespace,
  expanded,
  toggleGroup,
}: {
  namespace: string;
  groups: ConsumerGroup[];
  clusterId: string;
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
                  <span className="namespace-identity">
                    <AiIcon material="folder_open" size={17} />
                    <span className="consumer-identity-label">{namespace}</span>
                  </span>
                  <ConsumerStatus pods={groups.flatMap((group) => group.pods)} />
                </div>
                <small
                  className="consumer-subtitle"
                  title="Resource totals include only consumers shown by the current filters"
                >
                  {groups.length} shown consumers<span>·</span>
                  {groups.reduce((total, group) => total + group.pods.length, 0)} pods
                </small>
              </div>
              <span className="consumer-expand-slot">
                <button
                  className="consumer-expand"
                  type="button"
                  title={open ? "Collapse namespace workloads" : "Expand namespace workloads"}
                  aria-label={`${open ? "Collapse" : "Expand"} workloads in ${namespace}`}
                  aria-expanded={open}
                  onClick={toggleNamespace}
                >
                  <AiIcon material={open ? "expand_less" : "expand_more"} />
                </button>
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
    [{ ...pod, kind: "Pod", metadata: { ...pod.metadata, ownerReferences: [] } }],
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
