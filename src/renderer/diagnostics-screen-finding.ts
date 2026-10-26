import type { ConsumerGroup, ResourceSummary, TimelineEntry } from "../common/resource-diagnostics";
import type { DiagnosticFinding } from "./ai-diagnostic-handoff";

export function diagnosticsScreenFinding(
  clusterId: string,
  tab: "Consumers" | "Timeline",
  groups: ConsumerGroup[],
  timeline: TimelineEntry[],
  resource: (entry: TimelineEntry) => string,
): DiagnosticFinding {
  const metric = (value: ResourceSummary) => ({
    requests: value.requests,
    scheduledRequests: value.scheduledRequests,
    unscheduledRequests: value.unscheduledRequests,
    usage: value.usage,
    coveredPods: value.coveredPods,
    totalPods: value.totalPods,
    unknownRequestPods: value.unknownRequestPods,
  });
  const rows =
    tab === "Consumers"
      ? groups.slice(0, 100).map((group) => ({
          namespace: group.namespace,
          kind: group.kind,
          name: group.name,
          pods: group.pods.length,
          cpu: metric(group.cpu),
          memory: metric(group.memory),
        }))
      : timeline.slice(0, 100).map((entry) => ({
          resource: resource(entry).slice(0, 800),
          reason: entry.reason.slice(0, 300),
          message: entry.message.slice(0, 1000),
          time: entry.time,
          firstTime: entry.firstTime,
          count: entry.count,
          certainty: entry.certainty,
          gap: entry.gap?.slice(0, 300),
        }));
  const snapshot = {
    view: tab,
    scope: "Current filtered and sorted diagnostics list; read-only snapshot, may be partial or stale",
    omitted: (tab === "Consumers" ? groups.length : timeline.length) - rows.length,
    rows,
  };
  let summary = JSON.stringify(snapshot);
  while (summary.length > 8000 && snapshot.rows.length) {
    snapshot.rows.pop();
    snapshot.omitted++;
    summary = JSON.stringify(snapshot);
  }
  return { automatic: true, clusterId, source: "diagnostics", title: `Diagnostics · ${tab}`, summary };
}
