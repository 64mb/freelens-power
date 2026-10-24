import {
  POWER_LOGS_DEFAULT_LIMITS,
  POWER_LOGS_LIMITS,
  type PowerLogsLimitKey,
  type PowerLogsLimits,
} from "./power-logs";

export interface LogLimitField {
  key: PowerLogsLimitKey;
  label: string;
  unit: string;
  group: "Live logs" | "History" | "Captures" | "SQL results" | "Throughput";
  min: number;
  max: number;
  step: number;
  scale?: number;
}

const KiB = 1024;
const MiB = KiB * KiB;

export const LOG_LIMIT_FIELDS: readonly LogLimitField[] = [
  { key: "liveRows", label: "Buffered rows", unit: "rows", group: "Live logs", min: 1, max: 1000000, step: 1000 },
  {
    key: "liveBytes",
    label: "Buffer size",
    unit: "MiB",
    group: "Live logs",
    min: KiB,
    max: 1024 * MiB,
    step: MiB,
    scale: MiB,
  },
  { key: "batchRows", label: "Batch rows", unit: "rows", group: "Live logs", min: 1, max: 100000, step: 100 },
  {
    key: "batchBytes",
    label: "Batch size",
    unit: "MiB",
    group: "Live logs",
    min: KiB,
    max: 64 * MiB,
    step: MiB,
    scale: MiB,
  },
  {
    key: "recordBytes",
    label: "Record size",
    unit: "KiB",
    group: "Live logs",
    min: KiB,
    max: 16 * MiB,
    step: KiB,
    scale: KiB,
  },
  { key: "historyLines", label: "Lines per source", unit: "lines", group: "History", min: 1, max: 1000000, step: 1000 },
  {
    key: "historyBytes",
    label: "Bytes per source",
    unit: "MiB",
    group: "History",
    min: KiB,
    max: 256 * MiB,
    step: MiB,
    scale: MiB,
  },
  {
    key: "historyConcurrency",
    label: "Parallel requests",
    unit: "requests",
    group: "History",
    min: 1,
    max: 32,
    step: 1,
  },
  {
    key: "captureBytes",
    label: "Capture size",
    unit: "MiB",
    group: "Captures",
    min: KiB,
    max: 4096 * MiB,
    step: MiB,
    scale: MiB,
  },
  {
    key: "captureRows",
    label: "Rows per capture",
    unit: "rows",
    group: "Captures",
    min: 1,
    max: 10000000,
    step: 10000,
  },
  { key: "captures", label: "Retained captures", unit: "captures", group: "Captures", min: 1, max: 100, step: 1 },
  { key: "sources", label: "Sources per capture", unit: "sources", group: "Captures", min: 1, max: 2000, step: 10 },
  {
    key: "captureSourceLines",
    label: "Lines per source",
    unit: "lines",
    group: "Captures",
    min: 1,
    max: 1000000,
    step: 1000,
  },
  {
    key: "captureSourceBytes",
    label: "Bytes per source",
    unit: "MiB",
    group: "Captures",
    min: KiB,
    max: 256 * MiB,
    step: MiB,
    scale: MiB,
  },
  {
    key: "ttlMs",
    label: "Retention",
    unit: "minutes",
    group: "Captures",
    min: 60000,
    max: 7 * 24 * 60 * 60000,
    step: 60000,
    scale: 60000,
  },
  { key: "resultRows", label: "Result rows", unit: "rows", group: "SQL results", min: 1, max: 100000, step: 100 },
  {
    key: "resultBytes",
    label: "Result size",
    unit: "MiB",
    group: "SQL results",
    min: KiB,
    max: 64 * MiB,
    step: MiB,
    scale: MiB,
  },
  {
    key: "queryMs",
    label: "Query timeout",
    unit: "seconds",
    group: "SQL results",
    min: 1000,
    max: 300000,
    step: 1000,
    scale: 1000,
  },
  {
    key: "requestsPerSecond",
    label: "Request rate",
    unit: "requests/s",
    group: "Throughput",
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: "bytesPerSecond",
    label: "Data rate",
    unit: "MiB/s",
    group: "Throughput",
    min: KiB,
    max: 256 * MiB,
    step: MiB,
    scale: MiB,
  },
  { key: "liveConcurrency", label: "Parallel streams", unit: "streams", group: "Throughput", min: 1, max: 64, step: 1 },
];

export function normalizePowerLogsLimits(input: unknown): PowerLogsLimits {
  const values = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const normalized: PowerLogsLimits = { ...POWER_LOGS_DEFAULT_LIMITS };
  for (const field of LOG_LIMIT_FIELDS) {
    const value = values[field.key];
    if (typeof value === "number" && Number.isFinite(value)) {
      normalized[field.key] = Math.max(field.min, Math.min(field.max, Math.trunc(value)));
    }
  }
  normalized.batchBytes = Math.max(normalized.batchBytes, normalized.recordBytes + 3);
  normalized.captureSourceBytes = Math.max(normalized.captureSourceBytes, normalized.recordBytes);
  return normalized;
}

export function applyPowerLogsLimits(input: unknown): PowerLogsLimits {
  const normalized = normalizePowerLogsLimits(input);
  Object.assign(POWER_LOGS_LIMITS, normalized);
  return normalized;
}
