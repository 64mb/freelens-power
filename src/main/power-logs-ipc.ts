import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Main } from "@freelensapp/extensions";
import { BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain } from "electron";
import { reaction } from "mobx";
import {
  POWER_LOGS_LIMITS as L,
  type LogRecord,
  type LogRequest,
  type LogTarget,
  POWER_LOGS_CHANNEL,
  POWER_LOGS_STORAGE_CHANNEL,
  POWER_LOGS_STORAGE_FULL,
} from "../common/power-logs";
import { applyPowerLogsLimits, normalizePowerLogsLimits } from "../common/power-logs-limits";
import { LogsPreferencesStore } from "../common/store/logs-preferences-store";
import {
  acquirePowerLogStream,
  cancelPowerLogPermits,
  releasePowerLogStream,
  renewPowerLogStream,
  requestPowerLogPermit,
  startPowerLogBudget,
} from "./power-logs-budget";
import { PowerLogsWorker, sweepPowerLogsStorage } from "./power-logs-worker";
import { trustedSearchSender } from "./resource-search";

const text = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit && !/[\x00]/.test(value);
const identifier = (value: unknown): value is string => text(value, 253) && /^[a-zA-Z0-9_.:-]+$/.test(value);
const fail = (): never => {
  throw new Error("Invalid log request");
};
export function validateLogRequest(input: unknown): LogRequest {
  if (!input || typeof input !== "object") return fail();
  const r = input as LogRequest;
  if (!identifier(r.clusterId) || !text(r.contextId, 512) || !r.contextId) return fail();
  const partition = { clusterId: r.clusterId, contextId: r.contextId };
  if (r.operation === "stream-open" || r.operation === "stream-close" || r.operation === "stream-renew") {
    if (!identifier(r.streamId)) return fail();
    if (r.operation === "stream-open") {
      if (typeof r.follow !== "boolean") return fail();
      return { ...partition, operation: "stream-open", streamId: r.streamId, follow: r.follow };
    }
    return { ...partition, operation: r.operation, streamId: r.streamId };
  }
  if (r.operation === "permit") {
    if (r.lane === "start" && r.bytes === undefined) return { ...partition, operation: "permit", lane: "start" };
    if (r.lane === "bytes" && Number.isSafeInteger(r.bytes) && r.bytes! > 0 && r.bytes! <= L.batchBytes)
      return { ...partition, operation: "permit", lane: "bytes", bytes: r.bytes };
    return fail();
  }
  if (r.operation === "list" || r.operation === "clear-persistent") return { ...partition, operation: r.operation };
  if (r.operation === "cancel") {
    if (!identifier(r.queryId)) return fail();
    return { ...partition, operation: "cancel", queryId: r.queryId };
  }
  if (r.operation === "create") {
    const t = r.target as LogTarget | undefined;
    if (
      !t ||
      !["Pod", "Deployment", "DaemonSet", "StatefulSet", "ReplicaSet", "Job", "CronJob"].includes(t.kind) ||
      !identifier(t.namespace) ||
      !identifier(t.name) ||
      !identifier(t.uid)
    )
      return fail();
    return {
      ...partition,
      operation: "create",
      target: { kind: t.kind, namespace: t.namespace, name: t.name, uid: t.uid },
    };
  }
  if (!("captureId" in r) || !identifier(r.captureId)) return fail();
  const scoped = { ...partition, captureId: r.captureId };
  if (r.operation === "delete" || r.operation === "export") return { ...scoped, operation: r.operation };
  if (r.operation === "set-persistent") {
    if (typeof r.persistent !== "boolean") throw new Error("Invalid persistence flag");
    return { ...scoped, operation: "set-persistent", persistent: r.persistent };
  }
  if (r.operation === "save-sql") {
    if (!text(r.sql, 65536)) return fail();
    return { ...scoped, operation: "save-sql", sql: r.sql };
  }
  if (r.operation === "query") {
    if (!identifier(r.queryId) || !text(r.sql, 65536) || !r.sql.trim()) return fail();
    return { ...scoped, operation: "query", queryId: r.queryId, sql: r.sql };
  }
  if (r.operation === "finish") {
    if (
      typeof r.partial !== "boolean" ||
      !Array.isArray(r.notes) ||
      r.notes.length > 20 ||
      r.notes.some((n) => !text(n, 512))
    )
      return fail();
    return { ...scoped, operation: "finish", partial: r.partial, notes: [...r.notes] };
  }
  if (r.operation !== "append" || !Array.isArray(r.records) || r.records.length > L.batchRows) return fail();
  const records: LogRecord[] = r.records.map((record) => {
    if (
      !record ||
      typeof record !== "object" ||
      (record.timestamp !== null && (!Number.isSafeInteger(record.timestamp) || record.timestamp < 0)) ||
      !identifier(record.pod) ||
      !identifier(record.podUid) ||
      !identifier(record.container) ||
      (record.previous !== undefined && typeof record.previous !== "boolean") ||
      !["trace", "debug", "info", "access", "warn", "error", "fatal", "unknown"].includes(record.level) ||
      !text(record.message, L.recordBytes) ||
      (record.fieldsJson !== null && !text(record.fieldsJson, L.recordBytes))
    )
      return fail();
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
    if (Buffer.byteLength(JSON.stringify(projected)) > L.recordBytes) return fail();
    return projected;
  });
  if (Buffer.byteLength(JSON.stringify(records)) > L.batchBytes) return fail();
  return { ...scoped, operation: "append", records };
}

export function trustedLogStorageSender(event: IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame)
    return false;
  try {
    const frame = new URL(event.senderFrame.url);
    const root = new URL(event.sender.getURL());
    return (
      frame.protocol === "https:" &&
      frame.hostname === "renderer.freelens.app" &&
      !frame.username &&
      !frame.password &&
      frame.origin === root.origin
    );
  } catch {
    return false;
  }
}

export function startPowerLogs(): () => void {
  let storageAvailable = true;
  try {
    sweepPowerLogsStorage();
  } catch {
    storageAvailable = false;
  }
  startPowerLogBudget();
  let active = true,
    worker: PowerLogsWorker | undefined;
  const streamOwners = new Map<
    string,
    { owner: string; contextId: string; clusterId: string; streamId: string; expiresAt: number }
  >();
  const dropExpiredOwners = () => {
    for (const [key, value] of streamOwners)
      if (value.expiresAt <= Date.now()) {
        releasePowerLogStream(value.clusterId, value.streamId);
        streamOwners.delete(key);
      }
  };
  const preferences = LogsPreferencesStore.getInstanceOrCreate<LogsPreferencesStore>();
  const stop = reaction(
    () => ({ enabled: preferences.enabled, limits: normalizePowerLogsLimits(preferences.limits) }),
    ({ enabled, limits }) => {
      applyPowerLogsLimits(limits);
      if (!enabled) {
        cancelPowerLogPermits();
        streamOwners.clear();
        worker?.close();
        worker = undefined;
      }
    },
    { fireImmediately: true },
  );
  const fingerprint = (r: LogRequest): string => {
    const cluster = Main.Catalog.getClusterById(r.clusterId);
    if (!cluster) throw new Error("Log cluster unavailable");
    return createHash("sha256")
      .update(r.contextId)
      .update("\0")
      .update(cluster.contextName)
      .update("\0")
      .update(cluster.kubeConfigPath)
      .update("\0")
      .update(readFileSync(cluster.kubeConfigPath))
      .digest("hex");
  };
  ipcMain.handle(POWER_LOGS_STORAGE_CHANNEL, async (event, input: unknown) => {
    const allowed = () => active && preferences.enabled && trustedLogStorageSender(event);
    try {
      if (!allowed() || !storageAvailable || !input || typeof input !== "object") throw new Error();
      const operation = (input as { operation?: unknown }).operation;
      if (operation !== "status" && operation !== "clear") throw new Error();
      if (!worker || worker.isClosed) worker = new PowerLogsWorker();
      const result = await worker.call({
        clusterId: "settings",
        contextId: "settings",
        operation: operation === "status" ? "storage-status" : "clear-storage",
      });
      if (!allowed()) throw new Error();
      return result;
    } catch {
      throw new Error("Log storage operation failed or is unavailable");
    }
  });
  ipcMain.handle(POWER_LOGS_CHANNEL, async (event, input: unknown) => {
    try {
      const request = validateLogRequest(input);
      const allowed = () => active && preferences.enabled && trustedSearchSender(event, request.clusterId);
      if (!allowed()) throw new Error("Power Logs is disabled or unavailable");
      const contextId = fingerprint(request);
      if (
        request.operation === "stream-open" ||
        request.operation === "stream-close" ||
        request.operation === "stream-renew"
      ) {
        dropExpiredOwners();
        const key = JSON.stringify([request.clusterId, request.streamId]);
        const owner = `${event.sender.id}:${event.senderFrame?.processId}:${event.senderFrame?.routingId}`;
        if (request.operation === "stream-open") {
          if (streamOwners.has(key)) throw new Error("Log stream already exists");
          const entry = {
            owner,
            contextId,
            clusterId: request.clusterId,
            streamId: request.streamId,
            expiresAt: Date.now() + 35000,
          };
          streamOwners.set(key, entry);
          try {
            await acquirePowerLogStream(request.clusterId, request.streamId, request.follow);
            if (!allowed() || fingerprint(request) !== contextId) throw new Error("Log context changed");
            entry.expiresAt = Date.now() + 35000;
          } catch (error) {
            if (streamOwners.get(key) === entry) {
              streamOwners.delete(key);
              releasePowerLogStream(request.clusterId, request.streamId);
            }
            throw error;
          }
        } else {
          const entry = streamOwners.get(key);
          if (!entry || entry.owner !== owner) throw new Error("Log stream owner changed");
          if (request.operation === "stream-close") {
            streamOwners.delete(key);
            releasePowerLogStream(request.clusterId, request.streamId);
          } else {
            if (entry.contextId !== contextId) throw new Error("Log context changed");
            renewPowerLogStream(request.clusterId, request.streamId);
            entry.expiresAt = Date.now() + 35000;
          }
        }
        return true;
      }
      if (request.operation === "permit") {
        await requestPowerLogPermit(request.clusterId, request.lane === "bytes" ? request.bytes : undefined);
        if (!allowed() || fingerprint(request) !== contextId) throw new Error("Log context changed");
        return true;
      }
      if (!storageAvailable) throw new Error("Log storage unavailable");
      let destination: string | undefined;
      if (request.operation === "export") {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) throw new Error("Log window unavailable");
        const choice = await dialog.showSaveDialog(window, {
          title: "Export captured logs",
          defaultPath: "logs.ndjson",
          filters: [{ name: "NDJSON", extensions: ["ndjson"] }],
        });
        if (choice.canceled || !choice.filePath) return false;
        destination = choice.filePath;
        if (!allowed() || fingerprint(request) !== contextId) throw new Error("Log context changed");
      }
      if (!worker || worker.isClosed) worker = new PowerLogsWorker();
      const result = await worker.call({ ...request, contextId }, destination);
      if (!allowed() || fingerprint(request) !== contextId) throw new Error("Log context changed");
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === POWER_LOGS_STORAGE_FULL ||
          error.message === "Saved snapshot limit reached. Delete a saved snapshot before keeping another.")
      )
        throw error;
      throw new Error("Power Logs operation failed or is unavailable");
    }
  });
  return () => {
    active = false;
    cancelPowerLogPermits(true);
    streamOwners.clear();
    stop();
    ipcMain.removeHandler(POWER_LOGS_CHANNEL);
    ipcMain.removeHandler(POWER_LOGS_STORAGE_CHANNEL);
    worker?.close();
    worker = undefined;
  };
}
