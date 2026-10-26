import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { app, type UtilityProcess, utilityProcess } from "electron";
import { POWER_LOGS_LIMITS as L, type LogRequest } from "../common/power-logs";
import { normalizePowerLogsLimits } from "../common/power-logs-limits";

import type { PowerLogsQuerySnapshot } from "./power-logs-query";

type ActiveQuery = {
  request: Extract<LogRequest, { operation: "query" }>;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  child?: UtilityProcess;
  expiry?: ReturnType<typeof setTimeout>;
};

export function sweepPowerLogsStorage(directory = join(tmpdir(), "freelens-power-logs")): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || (process.getuid && root.uid !== process.getuid()))
    throw new Error("Log storage unavailable");
  chmodSync(directory, 0o700);
  for (const name of readdirSync(directory)) {
    const match = /^([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid > 2147483647) continue;
    const path = join(directory, name);
    try {
      const entry = lstatSync(path);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid()))
        continue;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(path, { recursive: true, force: true });
      }
    } catch {
      /* another process may have completed cleanup */
    }
  }
  return directory;
}

export class PowerLogsWorker {
  private child: UtilityProcess;
  private directory: string;
  private persistentDirectory: string;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private sequence = 0;
  private closed = false;
  private children = new Set<UtilityProcess>();
  private query?: ActiveQuery;
  private readers = new Map<UtilityProcess, LogRequest & { captureId: string }>();
  private deleting = new Set<string>();
  private captureKey(request: LogRequest & { captureId: string }): string {
    return JSON.stringify([request.clusterId, request.contextId, request.captureId]);
  }
  get isClosed(): boolean {
    return this.closed;
  }
  constructor() {
    this.persistentDirectory = join(app.getPath("userData"), "freelens-power", "log-captures");
    this.directory = join(sweepPowerLogsStorage(), `${process.pid}-${randomUUID()}`);
    mkdirSync(this.directory, { mode: 0o700 });
    try {
      this.child = utilityProcess.fork(
        join(__dirname, "power-logs-child.js"),
        [this.directory, this.persistentDirectory],
        {
          serviceName: "Power Logs",
          stdio: "ignore",
        },
      );
    } catch {
      rmSync(this.directory, { recursive: true, force: true });
      throw new Error("Log process unavailable");
    }
    this.track(this.child);
    this.child.on("message", ({ id, result, error }) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (error)
        pending.reject(
          new Error(
            error === "Saved snapshot limit reached. Delete a saved snapshot before keeping another."
              ? error
              : "Log operation failed or exceeded its limit",
          ),
        );
      else pending.resolve(result);
    });
    this.child.on("exit", () => {
      this.close();
    });
  }
  private track(child: UtilityProcess): void {
    this.children.add(child);
    child.once("exit", () => {
      this.children.delete(child);
      this.cleanup();
    });
  }
  private cleanup(): void {
    if (this.closed && this.children.size === 0) rmSync(this.directory, { recursive: true, force: true });
  }
  private clearing = false;
  call(request: LogRequest, destination?: string): Promise<unknown> {
    if (request.operation === "clear-persistent") {
      if (this.clearing) return Promise.reject(new Error("Log storage busy"));
      this.clearing = true;
      this.query?.reject(new Error("Log query canceled"));
      const readers = [...this.readers.keys()];
      return Promise.all(
        readers.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("Log query process is still closing")), 5000);
              child.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
              child.kill();
            }),
        ),
      )
        .then(() => this.callStorage(request, destination))
        .finally(() => {
          this.clearing = false;
        });
    }
    if (request.operation === "query") return this.runQuery(request);
    const removesCapture =
      request.operation === "delete" || (request.operation === "set-persistent" && !request.persistent);
    const active = this.query;
    if (
      active &&
      request.clusterId === active.request.clusterId &&
      request.contextId === active.request.contextId &&
      ((request.operation === "cancel" && request.queryId === active.request.queryId) ||
        (removesCapture && "captureId" in request && request.captureId === active.request.captureId))
    ) {
      active.reject(new Error("Log query canceled"));
    }
    if (removesCapture && "captureId" in request) {
      const key = this.captureKey(request);
      this.deleting.add(key);
      const readers = [...this.readers].filter(([, owner]) => this.captureKey(owner) === key);
      if (readers.length === 0) return this.callStorage(request, destination).finally(() => this.deleting.delete(key));
      return Promise.all(
        readers.map(
          ([child]) =>
            new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("Log query process is still closing")), 5000);
              child.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
              child.kill();
            }),
        ),
      )
        .then(() => this.callStorage(request, destination))
        .finally(() => this.deleting.delete(key));
    }
    return this.callStorage(request, destination);
  }
  private runQuery(request: Extract<LogRequest, { operation: "query" }>): Promise<unknown> {
    if (this.closed || this.clearing || this.query || this.deleting.has(this.captureKey(request)))
      return Promise.reject(new Error("Log query unavailable or busy"));
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: unknown) => {
        if (this.query !== active) return;
        this.query = undefined;
        clearTimeout(active.timer);
        clearTimeout(active.expiry);
        active.child?.kill();
        if (error) reject(error);
        else resolve(result);
      };
      const active: ActiveQuery = {
        request,
        reject: (error) => finish(error),
        timer: setTimeout(() => finish(new Error("Log query exceeded its time limit")), L.queryMs),
      };
      this.query = active;
      void this.callStorage(request).then(
        (value) => {
          if (this.query !== active) return;
          const snapshot = value as PowerLogsQuerySnapshot;
          const local = typeof snapshot?.database === "string" ? relative(this.directory, snapshot.database) : "..";
          const saved =
            typeof snapshot?.database === "string" ? relative(this.persistentDirectory, snapshot.database) : "..";
          const isLocal = (path: string) => !!path && !path.startsWith("..") && !isAbsolute(path);
          if (
            (!isLocal(local) && !isLocal(saved)) ||
            snapshot.captureId !== request.captureId ||
            !Number.isFinite(snapshot.expiresAt) ||
            snapshot.expiresAt <= Date.now()
          ) {
            finish(new Error("Log snapshot unavailable"));
            return;
          }
          try {
            const child = utilityProcess.fork(join(__dirname, "power-logs-query-child.js"), [], {
              serviceName: "Power Logs SQL",
              stdio: "ignore",
            });
            active.child = child;
            this.track(child);
            this.readers.set(child, request);
            child.once("exit", () => this.readers.delete(child));
            if (snapshot.expiresAt !== Number.MAX_SAFE_INTEGER)
              active.expiry = setTimeout(
                () => finish(new Error("Log snapshot expired")),
                snapshot.expiresAt - Date.now(),
              );
            child.once("exit", () => {
              clearTimeout(active.expiry);
              finish(new Error("Log query process unavailable"));
            });
            child.once("message", ({ id, result, error }) => {
              if (id !== 1) return;
              clearTimeout(active.expiry);
              finish(error ? new Error("Log query failed or exceeded its limit") : undefined, result);
            });
            child.postMessage({
              id: 1,
              database: snapshot.database,
              sql: request.sql,
              limits: normalizePowerLogsLimits(L),
            });
          } catch {
            finish(new Error("Log query process unavailable"));
          }
        },
        (error: Error) => finish(error),
      );
    });
  }
  private callStorage(request: LogRequest, destination?: string): Promise<unknown> {
    if (this.closed || this.pending.size >= 16) return Promise.reject(new Error("Log storage unavailable or busy"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.close(), 20000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.postMessage({ id, request, destination, limits: normalizePowerLogsLimits(L) });
      } catch {
        this.close();
      }
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.query?.reject(new Error("Log storage unavailable"));
    for (const child of this.children) child.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Log storage unavailable"));
    }
    this.pending.clear();
    this.cleanup();
  }
}
