import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";
import { AiIcon } from "./ai-icon";
import { MetricChart } from "./monitoring";
import {
  getCollectedPodUsage,
  getMonitoringSnapshot,
  type MonitoringSnapshot,
  retainMonitoringCollector,
} from "./monitoring-collector";
import { isHistoryTracked, setHistoryTracked } from "./monitoring-history-collection";
import { MonitoringHistoryRange, useMonitoringHistory } from "./monitoring-history-view";

import type { HistoryIdentity } from "../common/monitoring-history";
import type { MonitoringSample } from "../common/monitoring-math";

type Tab = "Consumers" | "Timeline" | "Pending";
const hidden = () => document.visibilityState === "hidden";
const activeId = () => Renderer.Catalog.activeCluster.get()?.metadata.uid;
const groupKey = (group: ConsumerGroup) => `${group.namespace}/${group.identity}`;
function resourceText(value: number | undefined, metric: "cpu" | "memory"): string {
  if (value === undefined) return "Unavailable";
  return metric === "cpu" ? `${value.toFixed(3)} cores` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
function summaryText(summary: ResourceSummary, metric: "cpu" | "memory"): string {
  const request = summary.unknownRequestPods
    ? `partial ${resourceText(summary.requests, metric)} known (${summary.unknownRequestPods} pods unknown)`
    : resourceText(summary.requests, metric);
  const ratio =
    summary.usage !== undefined &&
    summary.requests > 0 &&
    !summary.unknownRequestPods &&
    summary.coveredPods === summary.totalPods
      ? `${((summary.usage / summary.requests) * 100).toFixed(0)}% of requests`
      : "ratio unavailable";
  return `${resourceText(summary.usage, metric)} (${summary.coveredPods}/${summary.totalPods} pods covered), requests ${request}, ${ratio}`;
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
function openResource(object: DiagnosticsObject, clusterId: string): void {
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
  const [historyTarget, setHistoryTarget] = useState("");
  const [groupMode, setGroupMode] = useState("workload");
  const [namespacesOpen, setNamespacesOpen] = useState<string[]>([]);
  const known = useRef(new Map<string, { group: ConsumerGroup; uids: Set<string> }>());
  const [sort, setSort] = useState("cpu");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [pendingUid, setPendingUid] = useState("");
  const [reason, setReason] = useState("");
  const [warningOnly, setWarningOnly] = useState(false);
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
        .sort((a, b) =>
          sort === "name"
            ? groupKey(a).localeCompare(groupKey(b))
            : sort === "requests" || sort === "memoryRequests"
              ? b[sort === "requests" ? "cpu" : "memory"].requests - a[sort === "requests" ? "cpu" : "memory"].requests
              : (b[sort === "memory" ? "memory" : "cpu"].usage ?? -1) -
                (a[sort === "memory" ? "memory" : "cpu"].usage ?? -1),
        ),
    [groups, filter, sort],
  );
  const applications = [...known.current.values()].map((item) => item.group);
  const application = applications.find((group) => groupKey(group) === selected);
  const uids = new Set(known.current.get(selected)?.uids ?? []);
  const warningIds = new Set(
    (data?.events ?? []).filter((event) => event.type === "Warning").map((event) => event.metadata?.uid),
  );
  const timeline = [...normalizeEvents(data?.events ?? []), ...observed]
    .filter(
      (entry) =>
        !!application &&
        !!entry.objectUid &&
        uids.has(entry.objectUid) &&
        (!reason || `${entry.reason} ${entry.message}`.toLowerCase().includes(reason.toLowerCase())) &&
        (!warningOnly || warningIds.has(entry.id)),
    )
    .sort((a, b) => (Date.parse(b.time ?? "") || 0) - (Date.parse(a.time ?? "") || 0));
  const pending = (data?.pods ?? []).filter((pod) => pod.status?.phase === "Pending");
  const selectedPod = pending.find((pod) => pod.metadata.uid === pendingUid);
  const diagnosis = selectedPod
    ? diagnosePendingPod(selectedPod, data?.nodes ?? [], data?.events ?? [], data?.pvcs)
    : undefined;
  return (
    <div className="power-diagnostics" style={{ padding: 20, overflow: "auto", height: "100%" }}>
      <style>{`.power-diagnostics table{width:100%;border-collapse:collapse}.power-diagnostics th,.power-diagnostics td{text-align:left;padding:9px;border-bottom:1px solid var(--borderColor);vertical-align:top}.power-diagnostics button,.power-diagnostics select,.power-diagnostics input{margin:4px;padding:6px}.power-diagnostics .toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.power-diagnostics small{display:block;opacity:.75}.power-diagnostics button{cursor:pointer;display:inline-flex;align-items:center;gap:6px;border-radius:4px;border:1px solid var(--borderColor);background:var(--contentColor);color:var(--textColorPrimary);font:inherit}.power-diagnostics button:hover{border-color:var(--primary)}.power-diagnostics button[aria-pressed=true]{color:var(--primary);border-color:var(--primary)}.power-diagnostics button:disabled{opacity:.5;cursor:default}.power-diagnostics select,.power-diagnostics input{border-radius:4px;border:1px solid var(--borderColor);background:var(--contentColor);color:var(--textColorPrimary);font:inherit}.power-diagnostics :is(button,select,input):focus-visible{outline:2px solid var(--primary);outline-offset:2px}.power-diagnostics input[type=checkbox]{accent-color:var(--primary)}.power-diagnostics th{color:var(--textColorSecondary);font-weight:500}.power-diagnostics nav{display:flex;gap:8px;flex-wrap:wrap}`}</style>
      <h2>Resource diagnostics</h2>
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
          </button>
        ))}
      </nav>
      <p>
        Read-only cluster snapshot
        {data ? ` · ${new Date(data.time).toLocaleTimeString([], { hourCycle: "h23" })}` : " · Loading"}
      </p>
      {error && <p role="status">{error}</p>}
      {data?.errors.map((message) => (
        <p role="status" key={message}>
          {message}
        </p>
      ))}
      {tab === "Consumers" && (
        <>
          <div className="toolbar">
            <label>
              Group by{" "}
              <select
                aria-label="Group consumers"
                value={groupMode}
                onChange={(event) => setGroupMode(event.target.value)}
              >
                <option value="workload">Workload</option>
                <option value="namespace">Namespace</option>
              </select>
            </label>
            <input
              aria-label="Filter consumers"
              placeholder="Namespace or workload"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <label>
              Sort{" "}
              <select aria-label="Sort consumers" value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="cpu">CPU usage</option>
                <option value="memory">Memory usage</option>
                <option value="requests">CPU requests</option>
                <option value="memoryRequests">Memory requests</option>
                <option value="name">Namespace / name</option>
              </select>
            </label>
          </div>
          <p>
            Usage coverage is per resource. Missing metrics are unavailable. Unscheduled requests are listed separately.
          </p>
          <table>
            <thead>
              <tr>
                <th>Namespace / consumer</th>
                <th>CPU</th>
                <th>Memory</th>
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
                    viewHistory={setHistoryTarget}
                    open={!namespace || namespacesOpen.includes(namespace)}
                    toggleNamespace={() =>
                      setNamespacesOpen((items) =>
                        items.includes(namespace) ? items.filter((item) => item !== namespace) : [...items, namespace],
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
          {!filtered.length && <p>No consumers available</p>}
          {data && historyTarget && (
            <ApplicationHistory
              key={`${data.clusterId}/${historyTarget}`}
              data={data}
              group={groups.find((group) => groupKey(group) === historyTarget)}
            />
          )}
        </>
      )}
      {tab === "Timeline" && (
        <>
          <div className="toolbar">
            <label>
              Application{" "}
              <select
                aria-label="Timeline application"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="">Select a workload or standalone pod</option>
                {applications.map((group) => (
                  <option key={groupKey(group)} value={groupKey(group)}>
                    {group.namespace} / {group.kind} / {group.name}
                  </option>
                ))}
              </select>
            </label>
            <input
              aria-label="Filter timeline reason"
              placeholder="Reason or message"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <label>
              <input type="checkbox" checked={warningOnly} onChange={(event) => setWarningOnly(event.target.checked)} />
              Warnings only
            </label>
          </div>
          <p>
            Kubernetes events have limited retention. Observed changes begin with this open view, retain at most 300
            entries, and have unknown transition times between snapshots. Related identities observed in this view are
            retained for at most 100 applications and 500 identities per application; older identity coverage can be
            incomplete.
          </p>
          <table>
            <thead>
              <tr>
                <th>Time / certainty</th>
                <th>Reason</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    {entry.time ? new Date(entry.time).toLocaleString([], { hourCycle: "h23" }) : "Time unknown"}
                    <small>
                      {entry.certainty}, count {entry.count}
                      {entry.firstTime
                        ? `, first ${new Date(entry.firstTime).toLocaleString([], { hourCycle: "h23" })}`
                        : ""}
                    </small>
                  </td>
                  <td>{entry.reason}</td>
                  <td>
                    {entry.message}
                    {(() => {
                      const object = entry.objectUid ? projected?.objects.get(entry.objectUid) : undefined;
                      return object && data ? (
                        <button
                          type="button"
                          title="Open exact resource details"
                          onClick={() => openResource(object, data.clusterId)}
                        >
                          <AiIcon material="open_in_new" />
                          Open resource
                        </button>
                      ) : null;
                    })()}
                    <small>{entry.gap}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!timeline.length && (
            <p>
              {application
                ? "No matching retained events or observed changes"
                : "Select an application to inspect its exact resource identities"}
            </p>
          )}
        </>
      )}
      {tab === "Pending" && (
        <>
          <label>
            Pending pod{" "}
            <select aria-label="Pending pod" value={pendingUid} onChange={(event) => setPendingUid(event.target.value)}>
              <option value="">Select a pod</option>
              {pending.map((pod) => (
                <option key={pod.metadata.uid} value={pod.metadata.uid}>
                  {pod.metadata.namespace} / {pod.metadata.name}
                </option>
              ))}
            </select>
          </label>
          {selectedPod && diagnosis ? (
            <>
              <h3>{diagnosis.state === "assigned-waiting" ? "Assigned and waiting" : "Unscheduled"}</h3>
              <p>
                Requested CPU: {podRequest(selectedPod, "cpu")} · Requested memory: {podRequest(selectedPod, "memory")}
              </p>
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

              <button type="button" title="Open pod details" onClick={() => openResource(selectedPod, data!.clusterId)}>
                <AiIcon material="open_in_new" />
                Open pod
              </button>
              <p>
                {selectedPod.status?.conditions
                  ?.map(
                    (condition) =>
                      `${condition.type}: ${condition.status}${condition.message ? ` (${condition.message})` : ""}`,
                  )
                  .join(" · ")}
              </p>
              <table>
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
                      <td>{entry.source === "event" ? "Reported Kubernetes event" : "Local hard constraint"}</td>
                      <td>{entry.node ?? "—"}</td>
                      <td>{entry.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!diagnosis.evidence.length && <p>No retained evidence is available for this pod</p>}
              {diagnosis.limitations.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </>
          ) : (
            <p>{pending.length ? "Select a pending pod" : "No pending pods available"}</p>
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
  viewHistory,
}: {
  group: ConsumerGroup;
  clusterId: string;
  expanded: boolean;
  toggle: () => void;
  usage: PodUsage[];
  viewHistory: (key: string) => void;
}) {
  return (
    <>
      <tr>
        <td>
          <button
            type="button"
            title={expanded ? "Collapse pods" : "Expand pods"}
            aria-expanded={expanded}
            onClick={toggle}
          >
            <AiIcon material={expanded ? "expand_less" : "expand_more"} />
            {group.namespace} / {group.kind} / {group.name}
          </button>
          <small>
            {group.pods.length} pods{group.ownerResolved ? "" : " · Owner chain incomplete"}
          </small>
          <TrackButton
            identity={{ clusterId, scope: group.kind === "Pod" ? "pod" : "workload", uid: group.identity }}
          />
          <button type="button" title="View resource history" onClick={() => viewHistory(groupKey(group))}>
            <AiIcon material="timeline" />
            View history
          </button>
        </td>
        <td>{summaryText(group.cpu, "cpu")}</td>
        <td>{summaryText(group.memory, "memory")}</td>
        <td>
          {unscheduledText(group.cpu, "cpu")} / {unscheduledText(group.memory, "memory")}
        </td>
      </tr>
      {expanded &&
        group.pods.map((pod) => (
          <tr key={pod.metadata.uid}>
            <td>
              <button type="button" title="Open pod details" onClick={() => openResource(pod, clusterId)}>
                <AiIcon material="open_in_new" />
                {pod.metadata.name}
              </button>{" "}
              {pod.metadata.uid && <TrackButton identity={{ clusterId, scope: "pod", uid: pod.metadata.uid }} />}
              {pod.status?.phase ?? "Unknown"} ·{" "}
              {pod.spec?.nodeName ? `Assigned to ${pod.spec.nodeName}` : "Unscheduled"}
            </td>
            <td>{podSummary(pod, usage, "cpu")}</td>
            <td>{podSummary(pod, usage, "memory")}</td>
            <td>{pod.spec?.nodeName ? "—" : "Included above"}</td>
          </tr>
        ))}
    </>
  );
}

function TrackButton({ identity }: { identity: HistoryIdentity }) {
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  const [, update] = useState(0);
  useEffect(
    () =>
      reaction(
        () => [preferences.historyEnabled, isHistoryTracked(identity)],
        () => update((value) => value + 1),
      ),
    [identity.clusterId, identity.scope, identity.uid, preferences],
  );
  const tracked = isHistoryTracked(identity);
  return (
    <button
      type="button"
      disabled={!preferences.historyEnabled}
      title={
        preferences.historyEnabled
          ? "Track numeric resource history locally"
          : "Enable local history in extension preferences"
      }
      aria-pressed={tracked}
      onClick={() => {
        if (activeId() !== identity.clusterId || !preferences.historyEnabled) return;
        setHistoryTracked(identity, !tracked);
        update((value) => value + 1);
      }}
    >
      <AiIcon material={tracked ? "visibility" : "visibility_off"} />
      {tracked ? "Stop tracking" : "Track history"}
    </button>
  );
}

function podRequest(pod: DiagnosticsObject, metric: "cpu" | "memory"): string {
  try {
    return resourceText(effectivePodResource(pod, metric), metric);
  } catch {
    return "Unavailable";
  }
}
function podSummary(pod: DiagnosticsObject, usage: PodUsage[], metric: "cpu" | "memory"): string {
  let request: number | undefined;
  try {
    request = effectivePodResource(pod, metric);
  } catch {}
  const value = usage.find((item) => item.uid === pod.metadata.uid)?.[metric];
  return `${resourceText(value, metric)}, requests ${resourceText(request, metric)}${value !== undefined && request ? `, ${((value / request) * 100).toFixed(0)}% of requests` : ", ratio unavailable"}`;
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
  viewHistory,
}: {
  namespace: string;
  groups: ConsumerGroup[];
  clusterId: string;
  usage: PodUsage[];
  viewHistory: (key: string) => void;
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
        <tr>
          <td>
            <button type="button" title="Expand namespace workloads" aria-expanded={open} onClick={toggleNamespace}>
              <AiIcon material={open ? "expand_less" : "expand_more"} />
              {namespace}
            </button>
            <small>{groups.length} consumers</small>
          </td>
          <td>{summaryText(sum("cpu"), "cpu")}</td>
          <td>{summaryText(sum("memory"), "memory")}</td>
          <td>
            {unscheduledText(sum("cpu"), "cpu")} / {unscheduledText(sum("memory"), "memory")}
          </td>
        </tr>
      )}
      {open &&
        groups.map((group) => (
          <ConsumerRows
            key={groupKey(group)}
            group={group}
            clusterId={clusterId}
            expanded={expanded.includes(groupKey(group))}
            toggle={() => toggleGroup(groupKey(group))}
            usage={usage}
            viewHistory={viewHistory}
          />
        ))}
    </>
  );
}

function ApplicationHistory({ data, group }: { data: MonitoringSnapshot; group?: ConsumerGroup }) {
  const live = useMemo((): MonitoringSample[] => {
    if (
      !group ||
      group.cpu.coveredPods !== group.cpu.totalPods ||
      group.memory.coveredPods !== group.memory.totalPods ||
      group.cpu.usage === undefined ||
      group.memory.usage === undefined
    )
      return [];
    const names = new Set(group.pods.map((pod) => `${pod.metadata.namespace}/${pod.metadata.name}`));
    const times = (data.podMetrics ?? [])
      .filter((metric) => names.has(`${metric.metadata.namespace}/${metric.metadata.name}`))
      .map((metric) => Date.parse(metric.timestamp));
    if (!times.length || times.some((time) => !Number.isFinite(time))) return [];
    return [
      {
        time: Math.min(...times),
        cpu: group.cpu.usage,
        memory: group.memory.usage,
        resources: {
          cpu: { requests: group.cpu.unknownRequestPods ? undefined : group.cpu.requests },
          memory: { requests: group.memory.unknownRequestPods ? undefined : group.memory.requests },
        },
      },
    ];
  }, [data, group]);
  const history = useMonitoringHistory(
    group
      ? { clusterId: data.clusterId, scope: group.kind === "Pod" ? "pod" : "workload", uid: group.identity }
      : undefined,
    live,
  );
  return (
    <section aria-label="Application resource history">
      <h3>{group?.name ?? "Unavailable application"} resource history</h3>
      <MonitoringHistoryRange range={history.range} onChange={history.setRange} />
      <p role="status">{history.status}</p>
      <p>
        {live.length
          ? "Live usage includes every current pod; source metric timestamps are used"
          : "Complete current usage unavailable; missing coverage remains a gap"}
      </p>
      {(["cpu", "memory"] as const).map((metric) => (
        <MetricChart
          key={metric}
          metric={metric}
          samples={history.samples}
          scope="pod"
          status={live.length ? "" : "Complete live usage unavailable"}
        />
      ))}
    </section>
  );
}
