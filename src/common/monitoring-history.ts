export const MONITORING_HISTORY_CHANNEL = "freelens-power:monitoring-history";
export const HISTORY_RETENTION = 7 * 24 * 60 * 60 * 1000;
export const HISTORY_MAX_BYTES = 100 * 1024 * 1024;
export type HistoryIdentity = {
  clusterId: string;
  scope: "cluster" | "node" | "pod" | "workload";
  uid: string;
};
export const HISTORY_METRICS = [
  "cpu",
  "memory",
  "cpuRequests",
  "memoryRequests",
  "cpuLimits",
  "memoryLimits",
  "cpuCapacity",
  "memoryCapacity",
  "cpuAllocatable",
  "memoryAllocatable",
  "restarts",
] as const;
export type HistoryMetric = (typeof HISTORY_METRICS)[number];
export type HistorySample = HistoryIdentity & { time: number; values: Partial<Record<HistoryMetric, number>> };
export type HistoryQuery = HistoryIdentity & { from: number; to: number };
export type HistoryPoint = {
  time: number;
  resolution: number;
  metric: HistoryMetric;
  min: number;
  avg: number;
  max: number;
  count: number;
  gap: boolean;
};
export type HistoryStatus = { available: boolean; enabled: boolean; bytes: number; samples: number; error?: string };
export type HistoryRequest =
  | { operation: "status" | "clear" }
  | { operation: "append"; samples: HistorySample[] }
  | { operation: "query"; query: HistoryQuery };
export function validHistoryIdentity(value: HistoryIdentity): boolean {
  return (
    !!value &&
    [value.clusterId, value.uid].every((id) => typeof id === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(id)) &&
    ["cluster", "node", "pod", "workload"].includes(value.scope)
  );
}
export function projectHistorySamples(input: unknown, now = Date.now()): HistorySample[] {
  if (!Array.isArray(input) || input.length > 512) throw new Error("Invalid history samples");
  return input.map((sample) => {
    if (
      !validHistoryIdentity(sample) ||
      !Number.isSafeInteger(sample.time) ||
      sample.time < now - HISTORY_RETENTION ||
      sample.time > now + 30_000 ||
      !sample.values ||
      typeof sample.values !== "object"
    )
      throw new Error("Invalid history sample");
    const values: HistorySample["values"] = {};
    for (const metric of HISTORY_METRICS) {
      const value = sample.values[metric];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e30)
        throw new Error("Invalid history value");
      values[metric] = value;
    }
    return { clusterId: sample.clusterId, scope: sample.scope, uid: sample.uid, time: sample.time, values };
  });
}
