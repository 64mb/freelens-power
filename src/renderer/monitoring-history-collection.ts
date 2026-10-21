import { Renderer } from "@freelensapp/extensions";
import { type HistoryIdentity, type HistorySample, validHistoryIdentity } from "../common/monitoring-history";
import { aggregateMetrics, aggregateResources, type MonitoringSample } from "../common/monitoring-math";
import { buildConsumerGroups, effectivePodResource } from "../common/resource-diagnostics";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";
import {
  getCollectedPodUsage,
  getNodeSample,
  type MonitoringSnapshot,
  onMonitoringSnapshot,
} from "./monitoring-collector";
import { monitoringHistory } from "./monitoring-history";
export function isHistoryTracked(identity: HistoryIdentity): boolean {
  return MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>().trackedHistory.some(
    (item) => item.clusterId === identity.clusterId && item.scope === identity.scope && item.uid === identity.uid,
  );
}
export function setHistoryTracked(identity: HistoryIdentity, tracked: boolean): void {
  if (!validHistoryIdentity(identity)) return;
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  const rest = preferences.trackedHistory.filter(
    (item) => !(item.clusterId === identity.clusterId && item.scope === identity.scope && item.uid === identity.uid),
  );
  preferences.trackedHistory = tracked
    ? [...rest, { clusterId: identity.clusterId, scope: identity.scope, uid: identity.uid }].slice(-100)
    : rest;
}
function numeric(sample: MonitoringSample): HistorySample["values"] {
  const values: HistorySample["values"] = { cpu: sample.cpu, memory: sample.memory };
  for (const metric of ["cpu", "memory"] as const)
    for (const field of ["requests", "limits", "capacity", "allocatable"] as const) {
      const value = sample.resources?.[metric]?.[field];
      if (value !== undefined && Number.isFinite(value))
        values[`${metric}${field[0].toUpperCase()}${field.slice(1)}` as keyof typeof values] = value;
    }
  return values;
}
export function historySnapshotSamples(data: MonitoringSnapshot, tracked: HistoryIdentity[]): HistorySample[] {
  const result: HistorySample[] = [];
  const add = (scope: HistoryIdentity["scope"], uid: string, sample: MonitoringSample) =>
    result.push({ clusterId: data.clusterId, scope, uid, time: sample.time, values: numeric(sample) });
  if (data.nodeMetrics?.length) {
    try {
      const sample = aggregateMetrics(data.nodeMetrics);
      sample.time = Math.min(...data.nodeMetrics.map((metric) => Date.parse(metric.timestamp)));
      if (data.nodes?.length) {
        try {
          sample.resources = aggregateResources(data.nodes, data.pods);
        } catch {
          // usage remains valid when capacity or request data is incomplete
        }
      }
      add("cluster", data.clusterId, sample);
    } catch {
      /* invalid or stale metrics leave a gap */
    }
  }
  const nodeMetricsByName = new Map<string, NonNullable<MonitoringSnapshot["nodeMetrics"]>>();
  for (const metric of data.nodeMetrics ?? []) {
    if (!metric.metadata?.name) continue;
    const metrics = nodeMetricsByName.get(metric.metadata.name) ?? [];
    metrics.push(metric);
    nodeMetricsByName.set(metric.metadata.name, metrics);
  }
  const podsByNode = new Map<string, NonNullable<MonitoringSnapshot["pods"]>>();
  for (const pod of data.pods ?? []) {
    const name = pod.spec.nodeName;
    if (!name) continue;
    const pods = podsByNode.get(name) ?? [];
    pods.push(pod);
    podsByNode.set(name, pods);
  }
  for (const node of data.nodes ?? []) {
    if (!node.metadata.uid) continue;
    try {
      const sample = getNodeSample(
        {
          ...data,
          nodes: [node],
          nodeMetrics: nodeMetricsByName.get(node.metadata.name),
          pods: data.pods ? (podsByNode.get(node.metadata.name) ?? []) : undefined,
        },
        node.metadata.name,
        node.metadata.uid,
      );
      if (sample) add("node", node.metadata.uid, sample);
    } catch {
      /* invalid or stale metrics leave a gap */
    }
  }
  const usage = getCollectedPodUsage(data);
  const targets = tracked.filter((item) => item.clusterId === data.clusterId);
  const podsByUid = new Map((data.pods ?? []).map((pod) => [pod.metadata.uid, pod]));
  const usageByUid = new Map(usage.map((item) => [item.uid, item]));
  const metricsByName = new Map(
    (data.podMetrics ?? []).map((metric) => [`${metric.metadata.namespace ?? ""}/${metric.metadata.name}`, metric]),
  );
  const workloadTargets = new Set(targets.filter((item) => item.scope === "workload").map((item) => item.uid));
  for (const target of targets.filter((item) => item.scope === "pod")) {
    const pod = podsByUid.get(target.uid);
    const metric = usageByUid.get(target.uid);
    const raw = pod ? metricsByName.get(`${pod.metadata.namespace ?? ""}/${pod.metadata.name}`) : undefined;
    if (!pod || !metric || metric.cpu === undefined || metric.memory === undefined || !raw) continue;
    const sample: MonitoringSample = { time: Date.parse(raw.timestamp), cpu: metric.cpu, memory: metric.memory };
    try {
      sample.resources = {
        cpu: { requests: effectivePodResource(pod, "cpu"), limits: effectivePodResource(pod, "cpu", "limits") },
        memory: {
          requests: effectivePodResource(pod, "memory"),
          limits: effectivePodResource(pod, "memory", "limits"),
        },
      };
    } catch {
      /* usage remains available without resource totals */
    }
    add("pod", target.uid, sample);
  }
  for (const group of workloadTargets.size ? buildConsumerGroups(data.pods ?? [], data.owners ?? [], usage) : []) {
    if (
      !group.ownerResolved ||
      !workloadTargets.has(group.identity) ||
      group.cpu.coveredPods !== group.cpu.totalPods ||
      group.memory.coveredPods !== group.memory.totalPods ||
      group.cpu.usage === undefined ||
      group.memory.usage === undefined
    )
      continue;
    const times = group.pods.flatMap((pod) => {
      const metric = metricsByName.get(`${pod.metadata.namespace ?? ""}/${pod.metadata.name}`);
      return metric ? [Date.parse(metric.timestamp)] : [];
    });
    if (!times.length) continue;
    add("workload", group.identity, {
      time: Math.min(...times),
      cpu: group.cpu.usage,
      memory: group.memory.usage,
      resources: {
        cpu: { requests: group.cpu.unknownRequestPods ? undefined : group.cpu.requests },
        memory: { requests: group.memory.unknownRequestPods ? undefined : group.memory.requests },
      },
    });
  }
  return result;
}
export function startMonitoringHistoryCollection(): () => void {
  const seen = new Map<string, number>();
  let stopped = false;
  let writing = false;
  let queued: MonitoringSnapshot | undefined;
  const permitted = (data: MonitoringSnapshot) => {
    const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
    return (
      !stopped &&
      preferences.enabled &&
      preferences.historyEnabled &&
      document.visibilityState !== "hidden" &&
      Renderer.Catalog.activeCluster.get()?.metadata.uid === data.clusterId
    );
  };
  const flush = async () => {
    if (writing) return;
    writing = true;
    try {
      while (queued && !stopped) {
        const data = queued;
        queued = undefined;
        if (!permitted(data)) continue;
        const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
        const samples = historySnapshotSamples(data, preferences.trackedHistory).filter(
          (sample) => (seen.get(`${sample.clusterId}/${sample.scope}/${sample.uid}`) ?? 0) < sample.time,
        );
        for (let i = 0; i < samples.length; i += 512) {
          if (!permitted(data)) break;
          const batch = samples.slice(i, i + 512);
          try {
            if (!(await monitoringHistory.append(batch)) || stopped) continue;
            for (const sample of batch) {
              const key = `${sample.clusterId}/${sample.scope}/${sample.uid}`;
              seen.set(key, Math.max(seen.get(key) ?? 0, sample.time));
            }
            while (seen.size > 10_000) seen.delete(seen.keys().next().value!);
          } catch {
            // failed batches remain eligible for the next snapshot
          }
        }
      }
    } finally {
      writing = false;
    }
  };
  const unsubscribe = onMonitoringSnapshot((data) => {
    if (!permitted(data)) return;
    // retain only the newest pending snapshot while writes are in flight
    queued = data;
    void flush();
  });
  return () => {
    stopped = true;
    queued = undefined;
    unsubscribe();
    seen.clear();
  };
}
