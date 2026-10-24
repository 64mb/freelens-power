import { createHash } from "node:crypto";
import { LogLineDecoder, parseLogLine } from "../common/power-log-parser";
import { type LogRecord, type LogSource, type LogTarget, POWER_LOGS_LIMITS } from "../common/power-logs";
export type LogQuery = Record<string, string | number | boolean>;
export interface PowerLogsTransport {
  get<T>(path: string, query?: LogQuery, signal?: AbortSignal): Promise<T>;
  stream(path: string, query: LogQuery, signal?: AbortSignal, onOpen?: () => void): AsyncIterable<Uint8Array | string>;
}
interface ObjectMetadata {
  name?: string;
  namespace?: string;
  uid?: string;
  ownerReferences?: { uid: string; controller?: boolean }[];
}
interface Resource {
  metadata?: ObjectMetadata;
  spec?: { containers?: { name: string }[]; initContainers?: { name: string }[] };
}
const resources = {
  Pod: ["/api/v1", "pods"],
  Deployment: ["/apis/apps/v1", "deployments"],
  ReplicaSet: ["/apis/apps/v1", "replicasets"],
  DaemonSet: ["/apis/apps/v1", "daemonsets"],
  StatefulSet: ["/apis/apps/v1", "statefulsets"],
  Job: ["/apis/batch/v1", "jobs"],
  CronJob: ["/apis/batch/v1", "cronjobs"],
};
const pathFor = (kind: LogTarget["kind"], namespace: string) =>
  `${resources[kind][0]}/namespaces/${encodeURIComponent(namespace)}/${resources[kind][1]}`;
const canceled = () => new Error("Log collection canceled");
function check(signal?: AbortSignal) {
  if (signal?.aborted) throw canceled();
}
async function delay(ms: number, signal?: AbortSignal) {
  check(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(canceled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
let nextStart = 0;
let nextBytes = 0;
async function permit(signal?: AbortSignal) {
  const start = Math.max(Date.now(), nextStart);
  nextStart = start + 1000 / POWER_LOGS_LIMITS.requestsPerSecond;
  await delay(Math.max(0, start - Date.now()), signal);
}
async function bytesPermit(bytes: number, signal?: AbortSignal) {
  const start = Math.max(Date.now(), nextBytes);
  nextBytes = start + (bytes / POWER_LOGS_LIMITS.bytesPerSecond) * 1000;
  await delay(Math.max(0, start - Date.now()), signal);
}
async function request<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await permit(signal);
    try {
      return await operation();
    } catch (error) {
      check(signal);
      const value = error as { status?: number; retryAfter?: string };
      if (attempt >= 2 || ![429, 503].includes(value.status ?? 0)) throw new Error("Log API request failed");
      const seconds = Number(value.retryAfter);
      const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value.retryAfter ?? "") - Date.now();
      await delay(Math.min(5000, Math.max(500, Number.isFinite(wait) ? wait : 1000)), signal);
    }
  }
}
export async function resolveLogSources(
  target: LogTarget,
  transport: PowerLogsTransport,
  signal?: AbortSignal,
): Promise<{ sources: LogSource[]; partial: boolean; notes: string[] }> {
  const root = await request(
    () =>
      transport.get<Resource>(
        `${pathFor(target.kind, target.namespace)}/${encodeURIComponent(target.name)}`,
        undefined,
        signal,
      ),
    signal,
  );
  if (root.metadata?.uid !== target.uid) throw new Error("The selected workload has changed");
  const notes: string[] = [];
  async function list(kind: LogTarget["kind"]): Promise<Resource[]> {
    const items: Resource[] = [];
    let continuation = "";
    const seen = new Set<string>();
    do {
      const page = await request(
        () =>
          transport.get<{ items?: Resource[]; metadata?: { continue?: string } }>(
            pathFor(kind, target.namespace),
            { limit: 200, ...(continuation ? { continue: continuation } : {}) },
            signal,
          ),
        signal,
      );
      items.push(...(page.items ?? []));
      continuation = page.metadata?.continue ?? "";
      if (continuation && seen.has(continuation)) throw new Error("Repeated resource page");
      seen.add(continuation);
      if (items.length >= 10000 && continuation) {
        notes.push("Resource discovery reached its page budget");
        break;
      }
    } while (continuation);
    return items;
  }
  let owners = new Set([target.uid]);
  const owned = (item: Resource) =>
    item.metadata?.ownerReferences?.some((owner) => owners.has(owner.uid) && owner.controller === true);
  if (target.kind === "Deployment" || target.kind === "CronJob") {
    const children = await list(target.kind === "Deployment" ? "ReplicaSet" : "Job");
    owners = new Set(children.filter(owned).flatMap((item) => (item.metadata?.uid ? [item.metadata.uid] : [])));
  }
  const pods = target.kind === "Pod" ? [root] : (await list("Pod")).filter(owned);
  const sources: LogSource[] = [];
  for (const pod of pods) {
    if (
      !pod.metadata?.uid ||
      !pod.metadata.name ||
      (pod.metadata.namespace && pod.metadata.namespace !== target.namespace)
    )
      continue;
    for (const container of [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])]) {
      if (sources.length >= POWER_LOGS_LIMITS.sources) {
        notes.push(`Only the first ${POWER_LOGS_LIMITS.sources} container sources are included`);
        return { sources, partial: true, notes };
      }
      sources.push({
        namespace: target.namespace,
        pod: pod.metadata.name,
        podUid: pod.metadata.uid,
        container: container.name,
      });
    }
  }
  return { sources, partial: notes.length > 0, notes };
}
export interface CollectionOptions {
  onSourceActivity?(delta: number): void;
  initialRecords?: LogRecord[];
  signal?: AbortSignal;
  tailLines?: number;
  sinceSeconds?: number;
  limitBytes?: number;
  sinceTime?: string;
  onCoverage?(coverage: LiveLogCoverage): void;
  onRecords(records: LogRecord[]): void | Promise<void>;
}
let historicalActive = 0;
async function historicalSlot(signal?: AbortSignal) {
  while (historicalActive >= POWER_LOGS_LIMITS.historyConcurrency) await delay(50, signal);
  check(signal);
  historicalActive++;
}
async function consume(source: LogSource, transport: PowerLogsTransport, options: CollectionOptions, follow: boolean) {
  const podPath = `/api/v1/namespaces/${encodeURIComponent(source.namespace)}/pods/${encodeURIComponent(source.pod)}`;
  const pod = await request(() => transport.get<Resource>(podPath, undefined, options.signal), options.signal);
  if (pod.metadata?.uid !== source.podUid) throw new Error("The container source has changed");
  const decoder = new LogLineDecoder();
  let bytes = 0;
  let lineCount = 0;
  const query: LogQuery = {
    container: source.container,
    timestamps: true,
    follow,
    tailLines: Math.max(
      1,
      Math.min(
        Math.max(POWER_LOGS_LIMITS.historyLines, POWER_LOGS_LIMITS.captureSourceLines),
        options.tailLines ?? POWER_LOGS_LIMITS.historyLines,
      ),
    ),
    ...(!follow
      ? {
          limitBytes: Math.max(
            1,
            Math.min(
              Math.max(POWER_LOGS_LIMITS.historyBytes, POWER_LOGS_LIMITS.captureSourceBytes),
              options.limitBytes ?? POWER_LOGS_LIMITS.historyBytes,
            ),
          ),
        }
      : {}),
    ...(source.previous ? { previous: true } : {}),
    ...(options.sinceTime
      ? { sinceTime: options.sinceTime }
      : options.sinceSeconds
        ? { sinceSeconds: options.sinceSeconds }
        : {}),
  };
  const path = `/api/v1/namespaces/${encodeURIComponent(source.namespace)}/pods/${encodeURIComponent(source.pod)}/log`;
  let started = false;
  let opened = false;
  try {
    await request(async () => {
      try {
        for await (const chunk of transport.stream(path, query, options.signal, () => {
          if (!opened) {
            opened = true;
            options.onSourceActivity?.(1);
          }
        })) {
          started = true;
          check(options.signal);
          const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
          bytes += size;
          if (!follow && bytes > Number(query.limitBytes)) return;
          await bytesPermit(size, options.signal);
          const records = decoder.push(chunk).map((line) => parseLogLine(line, source));
          lineCount += records.length;
          if (records.length) await options.onRecords(records);
        }
      } catch (error) {
        if (started) throw new Error("Container log stream interrupted");
        throw error;
      }
      const final = decoder.push(new Uint8Array(), true).map((line) => parseLogLine(line, source));
      lineCount += final.length;
      if (final.length) await options.onRecords(final);
    }, options.signal);
  } finally {
    if (opened) options.onSourceActivity?.(-1);
  }
  return (
    decoder.truncated ||
    (!follow && (bytes >= Number(query.limitBytes) || lineCount >= Number(query.tailLines))) ||
    (follow && started)
  );
}
export async function collectHistoricalLogs(
  sources: LogSource[],
  transport: PowerLogsTransport,
  options: CollectionOptions,
): Promise<{ partial: boolean; notes: string[] }> {
  const notes: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(POWER_LOGS_LIMITS.historyConcurrency, sources.length) }, async () => {
      while (next < sources.length) {
        const source = sources[next++];
        await historicalSlot(options.signal);
        try {
          if (await consume(source, transport, options, false))
            notes.push("Some source logs reached a collection limit");
        } catch {
          check(options.signal);
          notes.push("A container log source was unavailable");
        } finally {
          historicalActive--;
        }
      }
    }),
  );
  return { partial: notes.length > 0, notes: [...new Set(notes)] };
}
export interface LiveLogCoverage {
  active: number;
  total: number;
  partial: boolean;
  notes: string[];
}
export function startLiveLogs(sources: LogSource[], transport: PowerLogsTransport, options: CollectionOptions) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  const coverage: LiveLogCoverage = {
    active: 0,
    total: sources.length,
    partial: sources.length > POWER_LOGS_LIMITS.liveConcurrency,
    notes:
      sources.length > POWER_LOGS_LIMITS.liveConcurrency
        ? ["All sources are polled in rotation; live coverage is delayed and bounded tails can omit busy-source logs"]
        : [],
  };
  const notify = () => options.onCoverage?.({ ...coverage, notes: [...coverage.notes] });
  const note = (message: string) => {
    coverage.partial = true;
    if (!coverage.notes.includes(message)) coverage.notes.push(message);
    notify();
  };
  notify();
  const seen = new Map<string, true>();
  const cursors = new Map<string, number>();
  const sourceKey = (source: Pick<LogSource, "podUid" | "container" | "previous">) =>
    `${source.podUid}/${source.container}/${Boolean(source.previous)}`;
  const recordKey = (record: LogRecord) => {
    const projected = {
      timestamp: record.timestamp,
      pod: record.pod,
      podUid: record.podUid,
      container: record.container,
      level: record.level,
      message: record.message,
      fieldsJson: record.fieldsJson,
      previous: record.previous === true,
    };
    return createHash("sha256").update(sourceKey(record)).update(JSON.stringify(projected)).digest("hex");
  };
  const initialCounts = new Map<string, number>();
  for (const record of (options.initialRecords ?? []).slice(-POWER_LOGS_LIMITS.liveRows)) {
    const digest = recordKey(record),
      occurrence = (initialCounts.get(digest) ?? 0) + 1;
    initialCounts.set(digest, occurrence);
    seen.set(`${digest}/${occurrence}`, true);
    if (record.timestamp !== null)
      cursors.set(sourceKey(record), Math.max(cursors.get(sourceKey(record)) ?? 0, record.timestamp));
  }
  async function collect(source: LogSource, follow: boolean) {
    const key = sourceKey(source);
    const counts = new Map<string, number>();
    const cursor = cursors.get(key);
    return consume(
      source,
      transport,
      {
        ...options,
        signal: controller.signal,
        onSourceActivity: (delta) => {
          coverage.active = Math.max(0, coverage.active + delta);
          notify();
        },
        ...(cursor !== undefined ? { sinceTime: new Date(cursor).toISOString() } : {}),
        onRecords: async (records) => {
          const fresh: LogRecord[] = [];
          for (const record of records) {
            const digest = recordKey(record);
            const occurrence = (counts.get(digest) ?? 0) + 1;
            counts.set(digest, occurrence);
            const identity = `${digest}/${occurrence}`;
            if (!seen.has(identity)) {
              fresh.push(record);
              seen.set(identity, true);
            }
            if (record.timestamp !== null) cursors.set(key, Math.max(cursors.get(key) ?? 0, record.timestamp));
            while (seen.size > POWER_LOGS_LIMITS.liveRows) seen.delete(seen.keys().next().value!);
            if (counts.size > POWER_LOGS_LIMITS.liveRows) counts.delete(counts.keys().next().value!);
          }
          if (fresh.length) await options.onRecords(fresh);
        },
      },
      follow,
    );
  }
  const done = (async () => {
    if (sources.length > POWER_LOGS_LIMITS.liveConcurrency) {
      while (!controller.signal.aborted) {
        let next = 0;
        await Promise.all(
          Array.from({ length: POWER_LOGS_LIMITS.historyConcurrency }, async () => {
            while (next < sources.length && !controller.signal.aborted) {
              const source = sources[next++];
              await historicalSlot(controller.signal);
              try {
                if (await collect(source, false)) note("Some live polling tails reached their byte or line budget");
              } catch {
                if (!controller.signal.aborted) note("A live container log source was unavailable");
              } finally {
                historicalActive--;
              }
            }
          }),
        );
        await delay(5000, controller.signal);
      }
    } else {
      await Promise.all(
        sources.map(async (source) => {
          while (!controller.signal.aborted) {
            try {
              await collect(source, true);
              if (!controller.signal.aborted) note("A live source disconnected and is reconnecting");
            } catch {
              if (!controller.signal.aborted) note("A live container log source was unavailable and is reconnecting");
            }
            await delay(5000, controller.signal);
          }
        }),
      );
    }
  })()
    .catch(() => {
      if (!controller.signal.aborted) note("Live collection stopped unexpectedly");
    })
    .finally(() => {
      options.signal?.removeEventListener("abort", stop);
      coverage.active = 0;
      notify();
    });
  return { stop, coverage, done };
}
