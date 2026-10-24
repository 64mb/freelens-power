import { POWER_LOGS_LIMITS as L } from "../common/power-logs";

type Wait = { timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void; detach: () => void };
type Stream = {
  follow: boolean;
  active: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
  detach: () => void;
};
type Budget = { start: number; bytes: number; pending: Set<Wait>; streams: Map<string, Stream> };
const budgets = new Map<string, Budget>();
let active = false;
export const POWER_LOG_STREAM_LEASE_MS = 30000;
const validId = (value: string) => /^[a-zA-Z0-9_.:-]{1,253}$/.test(value);
const pendingCount = (budget: Budget) =>
  budget.pending.size + [...budget.streams.values()].filter((stream) => !stream.active).length;
function getBudget(clusterId: string): Budget {
  if (!active) throw new Error("Log request canceled");
  if (!validId(clusterId)) throw new Error("Invalid log budget");
  const now = Date.now();
  for (const [key, value] of budgets)
    if (!value.pending.size && !value.streams.size && Math.max(value.start, value.bytes) <= now) budgets.delete(key);
  let budget = budgets.get(clusterId);
  if (!budget) {
    if (budgets.size >= 100) throw new Error("Log request queue is full");
    budget = { start: 0, bytes: 0, pending: new Set(), streams: new Map() };
    budgets.set(clusterId, budget);
  }
  return budget;
}
function activateStreams(clusterId: string, budget: Budget): void {
  for (const [id, stream] of budget.streams) {
    if (stream.active) continue;
    const count = [...budget.streams.values()].filter((other) => other.active && other.follow === stream.follow).length;
    if (count >= (stream.follow ? L.liveConcurrency : L.historyConcurrency)) continue;
    clearTimeout(stream.timer);
    stream.active = true;
    stream.timer = setTimeout(() => releasePowerLogStream(clusterId, id), POWER_LOG_STREAM_LEASE_MS);
    stream.resolve();
  }
}
export function startPowerLogBudget(): void {
  active = true;
}
export function cancelPowerLogPermits(stop = false): void {
  if (stop) active = false;
  for (const budget of budgets.values()) {
    for (const wait of budget.pending) {
      clearTimeout(wait.timer);
      wait.detach();
      wait.reject(new Error("Log request canceled"));
    }
    for (const stream of budget.streams.values()) {
      clearTimeout(stream.timer);
      stream.detach();
      if (!stream.active) stream.reject(new Error("Log request canceled"));
    }
  }
  budgets.clear();
}
export async function acquirePowerLogStream(
  clusterId: string,
  streamId: string,
  follow: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || !validId(streamId) || typeof follow !== "boolean") throw new Error("Log request canceled");
  const budget = getBudget(clusterId);
  if (budget.streams.has(streamId)) throw new Error("Log stream already exists");
  if (pendingCount(budget) >= 16) throw new Error("Log request queue is full");
  await new Promise<void>((resolve, reject) => {
    const abort = () => releasePowerLogStream(clusterId, streamId);
    const stream: Stream = {
      follow,
      active: false,
      timer: setTimeout(abort, POWER_LOG_STREAM_LEASE_MS),
      resolve,
      reject,
      detach: () => signal?.removeEventListener("abort", abort),
    };
    budget.streams.set(streamId, stream);
    signal?.addEventListener("abort", abort, { once: true });
    activateStreams(clusterId, budget);
  });
}
export function releasePowerLogStream(clusterId: string, streamId: string): void {
  const budget = budgets.get(clusterId),
    stream = budget?.streams.get(streamId);
  if (!budget || !stream) return;
  clearTimeout(stream.timer);
  stream.detach();
  budget.streams.delete(streamId);
  if (!stream.active) stream.reject(new Error("Log request canceled"));
  activateStreams(clusterId, budget);
}
export function renewPowerLogStream(clusterId: string, streamId: string): void {
  const budget = budgets.get(clusterId),
    stream = budget?.streams.get(streamId);
  if (!budget || !stream?.active) throw new Error("Log stream lease expired");
  clearTimeout(stream.timer);
  stream.timer = setTimeout(() => releasePowerLogStream(clusterId, streamId), POWER_LOG_STREAM_LEASE_MS);
}
export async function requestPowerLogPermit(clusterId: string, bytes?: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Log request canceled");
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > L.batchBytes))
    throw new Error("Invalid log budget");
  const budget = getBudget(clusterId),
    now = Date.now();
  if (pendingCount(budget) >= 16) throw new Error("Log request queue is full");
  const lane = bytes === undefined ? "start" : "bytes";
  const start = Math.max(now, budget[lane]);
  budget[lane] = start + (bytes === undefined ? 1000 / L.requestsPerSecond : (bytes / L.bytesPerSecond) * 1000);
  if (start <= now) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(wait.timer);
      wait.detach();
      budget.pending.delete(wait);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("Log request canceled"));
    const wait: Wait = {
      timer: setTimeout(() => finish(), Math.ceil(start - now)),
      reject,
      detach: () => signal?.removeEventListener("abort", abort),
    };
    budget.pending.add(wait);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
