import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import {
  aggregateMetrics,
  aggregateResources,
  MONITORING_INTERVAL,
  type MonitoringSample,
} from "../common/monitoring-math";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";

import type { DiagnosticsEvent, DiagnosticsObject, PodUsage } from "../common/resource-diagnostics";

type NodeMetric = NonNullable<Awaited<ReturnType<typeof Renderer.K8sApi.nodesMetricsApi.list>>>[number];
type PodMetric = NonNullable<Awaited<ReturnType<typeof Renderer.K8sApi.podsMetricsApi.list>>>[number];
export interface MonitoringSnapshot {
  clusterId: string;
  time: number;
  diagnosticsTime?: number;
  nodes?: Renderer.K8sApi.Node[];
  pods?: Renderer.K8sApi.Pod[];
  nodeMetrics?: NodeMetric[];
  podMetrics?: PodMetric[];
  owners?: DiagnosticsObject[];
  events?: DiagnosticsEvent[];
  pvcs?: DiagnosticsObject[];
  errors: string[];
}

let snapshot: MonitoringSnapshot | undefined;
let pending: Promise<MonitoringSnapshot> | undefined;
let extraPending: Promise<MonitoringSnapshot> | undefined;
let extraTime = 0;
let epoch = 0;
let collectingCluster: string | undefined;
let retained = 0;
const listeners = new Set<(snapshot: MonitoringSnapshot) => void>();

export function resetMonitoringCollector(): void {
  epoch++;
  snapshot = undefined;
  pending = undefined;
  extraPending = undefined;
  extraTime = 0;
  collectingCluster = undefined;
}

export function retainMonitoringCollector(): () => void {
  retained++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--retained === 0) resetMonitoringCollector();
  };
}

export function onMonitoringSnapshot(listener: (snapshot: MonitoringSnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// one snapshot is shared by all views in this cluster renderer
export async function getMonitoringSnapshot(diagnostics = false): Promise<MonitoringSnapshot> {
  const clusterId = Renderer.Catalog.activeCluster.get()?.metadata.uid;
  if (!clusterId) throw new Error("Select a connected cluster");
  if ((snapshot?.clusterId ?? collectingCluster) && (snapshot?.clusterId ?? collectingCluster) !== clusterId)
    resetMonitoringCollector();
  collectingCluster = clusterId;
  if (!snapshot || Date.now() - snapshot.time >= MONITORING_INTERVAL) {
    if (!pending) {
      const current = epoch;
      pending = (async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => Renderer.K8sApi.nodesMetricsApi.list()),
          Promise.resolve().then(() => Renderer.K8sApi.nodesApi.list()),
          Promise.resolve().then(() => Renderer.K8sApi.podsApi.list()),
          Promise.resolve().then(() => Renderer.K8sApi.podsMetricsApi.list()),
        ]);
        if (current !== epoch || Renderer.Catalog.activeCluster.get()?.metadata.uid !== clusterId)
          throw new Error("Cluster changed during collection");
        const [metrics, nodes, pods, podMetrics] = results;
        const next: MonitoringSnapshot = {
          owners: snapshot?.owners,
          events: snapshot?.events,
          pvcs: snapshot?.pvcs,
          diagnosticsTime: snapshot?.diagnosticsTime,
          clusterId,
          time: Date.now(),
          nodeMetrics: metrics.status === "fulfilled" ? (metrics.value ?? undefined) : undefined,
          nodes: nodes.status === "fulfilled" ? (nodes.value ?? undefined) : undefined,
          pods: pods.status === "fulfilled" ? (pods.value ?? undefined) : undefined,
          podMetrics: podMetrics.status === "fulfilled" ? (podMetrics.value ?? undefined) : undefined,
          errors: results.flatMap((result, i) =>
            result.status === "rejected" || result.value === null
              ? [`${["Node metrics", "Nodes", "Pods", "Pod metrics"][i]} unavailable or access denied`]
              : [],
          ),
        };
        snapshot = next;
        for (const listener of listeners) listener(next);
        return next;
      })().finally(() => {
        if (current === epoch) pending = undefined;
      });
    }
    await pending;
  }
  if (!snapshot || snapshot.clusterId !== clusterId) throw new Error("Cluster changed during collection");
  if (diagnostics && (!extraTime || Date.now() - extraTime >= MONITORING_INTERVAL)) {
    if (!extraPending) {
      const current = epoch;
      const base = snapshot;
      extraPending = (async () => {
        const apis = [
          Renderer.K8sApi.replicaSetApi,
          Renderer.K8sApi.deploymentApi,
          Renderer.K8sApi.statefulSetApi,
          Renderer.K8sApi.daemonSetApi,
          Renderer.K8sApi.jobApi,
          Renderer.K8sApi.cronJobApi,
        ];
        const results = await Promise.allSettled([
          ...apis.map((api) =>
            Promise.resolve().then<DiagnosticsObject[] | null>(() => api.list() as Promise<DiagnosticsObject[] | null>),
          ),
          Promise.resolve().then(() => Renderer.K8sApi.eventApi.list()),
          Promise.resolve().then(() => Renderer.K8sApi.pvcApi.list()),
        ]);
        if (current !== epoch || Renderer.Catalog.activeCluster.get()?.metadata.uid !== clusterId)
          throw new Error("Cluster changed during collection");
        const owners = results
          .slice(0, apis.length)
          .flatMap((result) =>
            result.status === "fulfilled" ? ((result.value ?? []) as DiagnosticsObject[]) : [],
          ) as DiagnosticsObject[];
        const events = results[apis.length];
        const pvcs = results[apis.length + 1];
        snapshot = {
          ...(snapshot ?? base),
          diagnosticsTime: Date.now(),
          owners,
          events: events.status === "fulfilled" ? (events.value as DiagnosticsEvent[]) : undefined,
          pvcs: pvcs.status === "fulfilled" ? (pvcs.value as DiagnosticsObject[]) : undefined,
          errors: [
            ...(snapshot ?? base).errors,
            ...results.flatMap((result, index) =>
              result.status === "rejected"
                ? [
                    `${["ReplicaSets", "Deployments", "StatefulSets", "DaemonSets", "Jobs", "CronJobs", "Events", "PVCs"][index]} unavailable or access denied`,
                  ]
                : [],
            ),
          ],
        };
        extraTime = Date.now();
        for (const listener of listeners) listener(snapshot);
        return snapshot;
      })().finally(() => {
        if (current === epoch) extraPending = undefined;
      });
    }
    await extraPending;
  }
  if (!snapshot || Renderer.Catalog.activeCluster.get()?.metadata.uid !== clusterId)
    throw new Error("Cluster changed during collection");
  return snapshot;
}

export function getNodeSample(data: MonitoringSnapshot, name: string, uid?: string): MonitoringSample | undefined {
  const node = data.nodes?.find((item) => item.metadata.name === name && (!uid || item.metadata.uid === uid));
  const metric = data.nodeMetrics?.filter((item) => item.metadata.name === name);
  if (!node || metric?.length !== 1) return;
  if (metric[0].metadata.uid && node.metadata.uid && metric[0].metadata.uid !== node.metadata.uid) return;
  const sample = aggregateMetrics(metric);
  sample.time = Date.parse(metric[0].timestamp);
  const created = Date.parse(node.metadata.creationTimestamp ?? "");
  if (Number.isFinite(created) && sample.time < created) return;
  try {
    sample.resources = aggregateResources([node], data.pods);
  } catch {
    sample.resourceStatus = "Resource totals unavailable: incomplete node/pod data";
  }
  if (!data.pods) sample.resourceStatus = "Pod inventory unavailable; requests unavailable";
  return sample;
}

export function getCollectedPodUsage(data: MonitoringSnapshot): PodUsage[] {
  const index = new Map<string, PodMetric | undefined>();
  for (const metric of data.podMetrics ?? []) {
    const key = `${metric.metadata.namespace}/${metric.metadata.name}`;
    index.set(key, index.has(key) ? undefined : metric);
  }
  return (data.pods ?? []).flatMap((pod) => {
    if (!pod.metadata.uid) return [];
    const metric = index.get(`${pod.metadata.namespace}/${pod.metadata.name}`);
    if (!metric) return [];
    if (metric.metadata.uid && metric.metadata.uid !== pod.metadata.uid) return [];
    const time = Date.parse(metric.timestamp);
    const created = Date.parse(pod.metadata.creationTimestamp ?? "");
    if (
      !Number.isFinite(time) ||
      time < Date.now() - 120_000 ||
      time > Date.now() + 30_000 ||
      (Number.isFinite(created) && time < created)
    )
      return [];
    try {
      if (
        !metric.containers.length ||
        new Set(metric.containers.map((container) => container.name)).size !== metric.containers.length
      )
        return [];
      const sample = aggregateMetrics(
        metric.containers.map((container) => ({ ...container, timestamp: metric.timestamp })),
      );
      return [{ uid: pod.metadata.uid, cpu: sample.cpu, memory: sample.memory }];
    } catch {
      return [];
    }
  });
}

export function startMonitoringCollector(): () => void {
  const retain = retainMonitoringCollector();
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  const stop = reaction(
    () => preferences.enabled,
    () => resetMonitoringCollector(),
  );
  const collect = () => {
    if (preferences.enabled && document.visibilityState !== "hidden" && Renderer.Catalog.activeCluster.get())
      void getMonitoringSnapshot(
        preferences.historyEnabled && preferences.trackedHistory.some((item) => item.scope === "workload"),
      ).catch(() => {});
  };
  const timer = window.setInterval(collect, 1000);
  collect();
  return () => {
    window.clearInterval(timer);
    stop();
    retain();
  };
}
