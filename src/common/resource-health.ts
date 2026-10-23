import type { DiagnosticsObject } from "./resource-diagnostics";

export type HealthObject = DiagnosticsObject & {
  spec?: DiagnosticsObject["spec"] & { replicas?: number; minReadySeconds?: number };
  status?: DiagnosticsObject["status"] & {
    replicas?: number;
    availableReplicas?: number;
    desiredNumberScheduled?: number;
    numberReady?: number;
    updatedNumberScheduled?: number;
    initContainerStatuses?: { name: string; restartCount: number; ready?: boolean }[];
  };
};
export interface ObjectHealth {
  state: "healthy" | "warning" | "unknown";
  rows: { name: string; value: string }[];
  issue?: string;
}
export function summarizeObjectHealth(object: HealthObject): ObjectHealth {
  const status = object.status;
  const conditions = status?.conditions ?? [];
  const rows: ObjectHealth["rows"] = [];
  let ready: boolean | undefined;
  let issue: string | undefined;
  if (object.kind === "Pod") {
    rows.push({ name: "Phase", value: status?.phase ?? "Unknown" });
    const condition = conditions.find((condition) => condition.type === "Ready");
    ready = condition?.status === "True" ? true : condition?.status === "False" ? false : undefined;
    const containers = status?.containerStatuses ?? [];
    rows.push({
      name: "Readiness",
      value:
        status?.phase === "Succeeded"
          ? "Completed"
          : ready === undefined
            ? "Readiness unknown"
            : ready
              ? "Ready"
              : "Not ready",
    });
    rows.push({
      name: "Containers ready",
      value: `${containers.filter((container) => container.ready).length}/${object.spec?.containers?.length ?? "?"}`,
    });
    rows.push({
      name: "Restarts",
      value: String(
        [...containers, ...(status?.initContainerStatuses ?? [])].reduce(
          (sum, container) => sum + container.restartCount,
          0,
        ),
      ),
    });
    if (status?.phase === "Succeeded") ready = true;
    if (status?.phase === "Failed") {
      ready = false;
      issue = "Pod failed";
    }
  } else if (object.kind === "Node") {
    const condition = conditions.find((condition) => condition.type === "Ready");
    ready = condition?.status === "True" ? true : condition?.status === "False" ? false : undefined;
    rows.push({ name: "Readiness", value: ready === undefined ? "Readiness unknown" : ready ? "Ready" : "Not ready" });
    rows.push({ name: "Scheduling", value: object.spec?.unschedulable ? "Cordoned" : "Enabled" });
    const pressure = conditions.find(
      (condition) => /Pressure$|NetworkUnavailable/.test(condition.type) && condition.status === "True",
    );
    if (pressure) {
      issue = pressure.reason || pressure.type;
      ready = false;
    }
  } else if (object.kind === "Namespace") {
    rows.push({ name: "Phase", value: status?.phase ?? "Unknown" });
    ready = status?.phase ? status.phase === "Active" : undefined;
  } else {
    const desired = object.kind === "DaemonSet" ? status?.desiredNumberScheduled : (object.spec?.replicas ?? 1);
    const count = object.kind === "DaemonSet" ? status?.numberReady : status?.readyReplicas;
    const observed = status?.observedGeneration;
    const stale =
      object.metadata.generation !== undefined && (observed === undefined || observed < object.metadata.generation);
    ready = status && desired !== undefined ? (count ?? 0) >= desired && !stale : undefined;
    rows.push({ name: "Ready replicas", value: `${status ? (count ?? 0) : "?"}/${desired ?? "?"}` });
    const updated = object.kind === "DaemonSet" ? status?.updatedNumberScheduled : status?.updatedReplicas;
    rows.push({ name: "Updated replicas", value: status ? String(updated ?? 0) : "Unknown" });
    if (stale) issue = "Controller has not observed the latest generation";
  }
  const failure = conditions.find(
    (condition) =>
      (condition.type === "ReplicaFailure" && condition.status === "True") ||
      (["Ready", "Available", "Progressing", "PodScheduled"].includes(condition.type) && condition.status === "False"),
  );
  if (!issue && failure && !(object.kind === "Pod" && status?.phase === "Succeeded")) {
    issue = failure.reason || `${failure.type}: ${failure.status}`;
    ready = false;
  }
  if (!issue && ready === false)
    issue = object.kind === "Namespace" ? "Namespace is not active" : "Readiness target is not met";
  return { state: ready === undefined ? "unknown" : ready ? "healthy" : "warning", rows, issue };
}
