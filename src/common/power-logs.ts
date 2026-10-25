export const POWER_LOGS_CHANNEL = "freelens-power:logs";
export const POWER_LOGS_DEFAULT_LIMITS = {
  liveRows: 10000,
  liveBytes: 16 * 1024 * 1024,
  batchRows: 1000,
  batchBytes: 2 * 1024 * 1024,
  recordBytes: 64 * 1024,
  captureBytes: 256 * 1024 * 1024,
  captureRows: 1000000,
  captures: 3,
  sources: 200,
  resultRows: 1000,
  resultBytes: 2 * 1024 * 1024,
  queryMs: 15000,
  ttlMs: 60 * 60 * 1000,
  historyLines: 1000,
  historyBytes: 1024 * 1024,
  captureSourceLines: 10000,
  captureSourceBytes: 8 * 1024 * 1024,
  requestsPerSecond: 2,
  bytesPerSecond: 1024 * 1024,
  historyConcurrency: 2,
  liveConcurrency: 4,
} as const;

export type PowerLogsLimitKey = keyof typeof POWER_LOGS_DEFAULT_LIMITS;
export type PowerLogsLimits = { [Key in PowerLogsLimitKey]: number };
export const POWER_LOGS_LIMITS: PowerLogsLimits = { ...POWER_LOGS_DEFAULT_LIMITS };

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "unknown";
export type LogWorkloadKind = "Pod" | "Deployment" | "DaemonSet" | "StatefulSet" | "ReplicaSet" | "Job" | "CronJob";
export interface LogTarget {
  kind: LogWorkloadKind;
  namespace: string;
  name: string;
  uid: string;
}
export interface LogSource {
  namespace: string;
  pod: string;
  podUid: string;
  container: string;
  previous?: boolean;
}
export interface LogRecord {
  timestamp: number | null;
  pod: string;
  podUid: string;
  container: string;
  level: LogLevel;
  message: string;
  fieldsJson: string | null;
  previous?: boolean;
}
export interface LogCapture {
  id: string;
  target: LogTarget;
  createdAt: number;
  expiresAt: number;
  state: "collecting" | "ready" | "partial";
  rows: number;
  bytes: number;
  notes: string[];
  lastSql?: string;
}
export type LogCell = string | number | boolean | null;
export interface LogQueryResult {
  error?: string;
  columns: string[];
  rows: LogCell[][];
  truncated: boolean;
  elapsedMs: number;
}
export interface LogPartition {
  clusterId: string;
  contextId: string;
}
export type LogRequest = LogPartition &
  (
    | { operation: "permit"; lane: "start" | "bytes"; bytes?: number }
    | { operation: "stream-open"; streamId: string; follow: boolean }
    | { operation: "stream-close" | "stream-renew"; streamId: string }
    | { operation: "create"; target: LogTarget }
    | { operation: "append"; captureId: string; records: LogRecord[] }
    | { operation: "finish"; captureId: string; partial: boolean; notes: string[] }
    | { operation: "list" }
    | { operation: "delete"; captureId: string }
    | { operation: "save-sql"; captureId: string; sql: string }
    | { operation: "query"; captureId: string; queryId: string; sql: string }
    | { operation: "cancel"; queryId: string }
    | { operation: "export"; captureId: string }
  );
