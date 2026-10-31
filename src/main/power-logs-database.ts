import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
  POWER_LOGS_LIMITS as L,
  type LogCapture,
  type LogRequest,
  POWER_LOGS_STORAGE_FULL,
  POWER_LOGS_STORAGE_MAX_BYTES,
} from "../common/power-logs";

import type { PowerLogsQuerySnapshot } from "./power-logs-query";

type Capture = {
  meta: LogCapture;
  partition: string;
  directory: string;
  spool: string;
  database: string;
  retiredDirectory?: string;
  limits: { captureBytes: number; captureRows: number };
};
export class PowerLogsDatabase {
  private captures = new Map<string, Capture>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private directory: string,
    private persistentDirectory?: string,
    private storageLimit = POWER_LOGS_STORAGE_MAX_BYTES,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    if (persistentDirectory) {
      mkdirSync(persistentDirectory, { recursive: true, mode: 0o700 });
      chmodSync(persistentDirectory, 0o700);
      for (const id of readdirSync(persistentDirectory)) {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pending$/.test(id)) {
          const pending = join(persistentDirectory, id);
          const info = lstatSync(pending);
          if (info.isDirectory() && !info.isSymbolicLink() && (!process.getuid || info.uid === process.getuid())) {
            rmSync(pending, { recursive: true, force: true });
          }
          continue;
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) continue;
        const directory = join(persistentDirectory, id);
        try {
          if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) continue;
          const manifest = join(directory, "capture.json");
          if (!lstatSync(manifest).isFile() || lstatSync(manifest).isSymbolicLink()) continue;
          const saved = JSON.parse(readFileSync(manifest, "utf8"));
          if (saved.meta?.id === id && saved.meta.persistent === false) {
            rmSync(directory, { recursive: true, force: true });
            continue;
          }
          if (
            saved.meta?.id !== id ||
            saved.meta.persistent !== true ||
            !["ready", "partial"].includes(saved.meta.state) ||
            typeof saved.partition !== "string"
          )
            continue;
          const spool = join(directory, "logs.ndjson"),
            database = join(directory, "logs.sqlite");
          if (![spool, database].every((path) => lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()))
            continue;
          this.captures.set(id, {
            meta: saved.meta,
            partition: saved.partition,
            limits: saved.limits,
            directory,
            spool,
            database,
          });
        } catch {
          // leave unreadable saved captures available for recovery
        }
      }
    }
    this.timer = setInterval(() => this.expire(), 30000);
    this.timer.unref();
  }
  private directoryBytes(directory: string): number {
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Log storage unavailable");
    let bytes = 0;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      if (info.isFile()) bytes += info.size;
      else if (info.isDirectory()) bytes += this.directoryBytes(path);
    }
    return bytes;
  }
  private storageBytes(): number {
    return (
      this.directoryBytes(this.directory) +
      (this.persistentDirectory ? this.directoryBytes(this.persistentDirectory) : 0)
    );
  }
  private reserve(bytes: number): void {
    if (this.storageBytes() + bytes > this.storageLimit) throw new Error(POWER_LOGS_STORAGE_FULL);
  }
  private partition(request: LogRequest): string {
    return JSON.stringify([request.clusterId, request.contextId]);
  }
  private expire(): void {
    for (const [id, capture] of this.captures) {
      if (capture.meta.persistent || capture.meta.expiresAt > Date.now()) continue;
      try {
        this.remove(id);
      } catch {
        // retain expired entries within the capture limit until a later sweep can remove locked files
      }
    }
  }
  private remove(id: string): void {
    const capture = this.captures.get(id);
    if (!capture) return;
    try {
      if (capture.retiredDirectory) rmSync(capture.retiredDirectory, { recursive: true, force: true });
      rmSync(capture.directory, { recursive: true, force: true });
    } catch {
      throw new Error("Log capture storage is busy or unavailable");
    }
    this.captures.delete(id);
  }
  exportPath(request: LogRequest & { captureId: string }): string {
    return this.capture(request).spool;
  }
  private capture(request: LogRequest & { captureId: string }): Capture {
    const capture = this.captures.get(request.captureId);
    if (
      !capture ||
      capture.partition !== this.partition(request) ||
      (!capture.meta.persistent && capture.meta.expiresAt <= Date.now())
    )
      throw new Error("Capture unavailable");
    return capture;
  }
  async run(request: LogRequest): Promise<unknown> {
    if (this.closed) throw new Error("Log storage unavailable");
    this.expire();
    if (request.operation === "permit" || "streamId" in request) throw new Error("Log permits require main process");
    const partition = this.partition(request);
    if (request.operation === "cancel") return true;
    if (request.operation === "storage-status") {
      return {
        bytes: this.storageBytes(),
        maxBytes: this.storageLimit,
        captures: this.captures.size,
        collecting: [...this.captures.values()].filter((capture) => capture.meta.state === "collecting").length,
      };
    }
    if (request.operation === "clear-storage") {
      for (const [id, capture] of this.captures) if (capture.meta.state !== "collecting") this.remove(id);
      return true;
    }
    if (request.operation === "clear-persistent") {
      for (const [id, capture] of this.captures) if (capture.meta.persistent) this.remove(id);
      return true;
    }
    if (request.operation === "list")
      return [...this.captures.values()]
        .filter((c) => c.partition === partition && (c.meta.persistent || c.meta.expiresAt > Date.now()))
        .map((c) => ({ ...c.meta }));
    if (request.operation === "create") {
      const captures = [...this.captures.values()];
      if (
        captures.filter((capture) => capture.partition === partition).length >= L.captures ||
        captures.filter((capture) => !capture.meta.persistent).length >= L.captures
      )
        throw new Error("Capture limit reached");
      const id = randomUUID(),
        directory = join(this.directory, id),
        now = Date.now();
      this.reserve(0);
      mkdirSync(directory, { mode: 0o700 });
      const spool = join(directory, "logs.ndjson");
      writeFileSync(spool, "", { mode: 0o600 });
      const meta: LogCapture = {
        id,
        target: request.target,
        createdAt: now,
        expiresAt: now + L.ttlMs,
        state: "collecting",
        rows: 0,
        bytes: 0,
        notes: [],
      };
      this.captures.set(id, {
        meta,
        partition,
        directory,
        spool,
        database: join(directory, "logs.sqlite"),
        limits: { captureBytes: L.captureBytes, captureRows: L.captureRows },
      });
      return { ...meta };
    }
    const capture = this.capture(request);
    if (request.operation === "delete") {
      this.remove(request.captureId);
      return true;
    }
    if (request.operation === "set-persistent") {
      if (typeof request.persistent !== "boolean") throw new Error("Invalid persistence flag");
      if (capture.meta.state === "collecting") throw new Error("Finish capture before saving");
      if (request.persistent === !!capture.meta.persistent) return { ...capture.meta };
      if (request.persistent) {
        if ([...this.captures.values()].filter((item) => item.meta.persistent).length >= L.captures)
          throw new Error("Saved snapshot limit reached. Delete a saved snapshot before keeping another.");
        if (!this.persistentDirectory) throw new Error("Persistent storage unavailable");
        const directory = join(this.persistentDirectory, capture.meta.id);
        if (capture.directory === directory) {
          this.saveMetadata({ ...capture, meta: { ...capture.meta, persistent: true } });
          capture.meta.persistent = true;
          return { ...capture.meta };
        }
        const staging = join(this.persistentDirectory, `${capture.meta.id}.pending`);
        try {
          this.reserve(this.directoryBytes(capture.directory));
          cpSync(capture.directory, staging, { recursive: true, errorOnExist: true, force: false });
          this.saveMetadata({ ...capture, directory, meta: { ...capture.meta, persistent: true } }, staging);
          renameSync(staging, directory);
        } catch (error) {
          rmSync(staging, { recursive: true, force: true });
          if (error instanceof Error && error.message === POWER_LOGS_STORAGE_FULL) throw error;
          throw new Error("Persistent storage unavailable");
        }
        // retain the original directory for active readers until capture deletion drains them
        capture.retiredDirectory = capture.directory;
        capture.directory = directory;
        capture.spool = join(directory, "logs.ndjson");
        capture.database = join(directory, "logs.sqlite");
        capture.meta.persistent = true;
      } else {
        if ([...this.captures.values()].filter((item) => !item.meta.persistent).length >= L.captures)
          throw new Error("Capture limit reached");
        const directory = join(this.directory, capture.meta.id);
        const staging = `${directory}.pending`;
        try {
          this.reserve(this.directoryBytes(capture.directory));
          cpSync(capture.directory, staging, { recursive: true, errorOnExist: true, force: false });
          rmSync(directory, { recursive: true, force: true });
          renameSync(staging, directory);
          rmSync(capture.directory, { recursive: true, force: true });
        } catch (error) {
          rmSync(staging, { recursive: true, force: true });
          if (error instanceof Error && error.message === POWER_LOGS_STORAGE_FULL) throw error;
          throw new Error("Temporary storage unavailable");
        }
        capture.directory = directory;
        capture.retiredDirectory = undefined;
        capture.spool = join(directory, "logs.ndjson");
        capture.database = join(directory, "logs.sqlite");
        capture.meta = { ...capture.meta, persistent: false, expiresAt: Date.now() + L.ttlMs };
      }
      return { ...capture.meta };
    }
    if (request.operation === "save-sql") {
      if (typeof request.sql !== "string" || request.sql.length > 65536 || request.sql.includes("\0"))
        throw new Error("Invalid SQL draft");
      const meta = { ...capture.meta, lastSql: request.sql };
      if (capture.meta.persistent) this.saveMetadata({ ...capture, meta });
      capture.meta = meta;
      return { ...capture.meta };
    }
    if (request.operation === "export") throw new Error("Export requires trusted destination");
    if (request.operation === "append") {
      if (capture.meta.state !== "collecting") throw new Error("Capture is complete");
      if (request.records.length > L.batchRows) throw new Error("Log batch exceeds limit");
      const data = request.records
        .map((record) => JSON.stringify({ ...record, previous: record.previous === true }) + "\n")
        .join("");
      const bytes = Buffer.byteLength(data);
      if (
        bytes > L.batchBytes ||
        capture.meta.bytes + bytes > capture.limits.captureBytes ||
        capture.meta.rows + request.records.length > capture.limits.captureRows
      )
        throw new Error("Capture limit reached");
      this.reserve(bytes);
      try {
        appendFileSync(capture.spool, data);
      } catch {
        truncateSync(capture.spool, capture.meta.bytes);
        throw new Error("Log capture storage unavailable");
      }
      capture.meta.rows += request.records.length;
      capture.meta.bytes += bytes;
      return { ...capture.meta };
    }
    if (request.operation === "finish") {
      if (capture.meta.state !== "collecting") return { ...capture.meta };
      const pages = Math.floor((this.storageLimit - this.storageBytes()) / 4096);
      if (pages < 2) throw new Error(POWER_LOGS_STORAGE_FULL);
      let database: DatabaseSync | undefined;
      try {
        writeFileSync(capture.database, "", { mode: 0o600 });
        database = new DatabaseSync(capture.database, { allowExtension: false });
        database.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=${pages}`);
        database.exec(
          "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-16384; PRAGMA temp_store=MEMORY",
        );
        database.exec(
          "CREATE TABLE logs(timestamp INTEGER, pod TEXT, podUid TEXT, container TEXT, level TEXT, message TEXT, fieldsJson TEXT, previous INTEGER CHECK(previous IN (0,1)))",
        );
        const insert = database.prepare("INSERT INTO logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        const input = createReadStream(capture.spool);
        const lines = createInterface({ input, crlfDelay: Infinity });
        let count = 0;
        database.exec("BEGIN");
        try {
          for await (const line of lines) {
            const record = JSON.parse(line);
            insert.run(
              record.timestamp,
              record.pod,
              record.podUid,
              record.container,
              record.level,
              record.message,
              record.fieldsJson,
              record.previous ? 1 : 0,
            );
            if (++count % 5000 === 0) {
              database.exec("COMMIT; BEGIN");
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }
          database.exec("COMMIT");
        } finally {
          lines.close();
          input.destroy();
        }
        database.exec("CREATE INDEX logs_timestamp ON logs(timestamp)");
      } catch (error) {
        database?.close();
        database = undefined;
        rmSync(capture.database, { force: true });
        if (error instanceof Error && /database or disk is full/.test(error.message))
          throw new Error(POWER_LOGS_STORAGE_FULL);
        throw new Error("Log capture storage unavailable");
      } finally {
        database?.close();
      }
      capture.meta.state = request.partial ? "partial" : "ready";
      capture.meta.notes = request.notes;
      return { ...capture.meta };
    }
    if (capture.meta.state === "collecting") throw new Error("Finish capture before querying");
    return {
      database: capture.database,
      captureId: capture.meta.id,
      expiresAt: capture.meta.persistent ? Number.MAX_SAFE_INTEGER : capture.meta.expiresAt,
    } satisfies PowerLogsQuerySnapshot;
  }
  private saveMetadata(capture: Capture, directory = capture.directory): void {
    const temporary = join(directory, "capture.json.pending");
    const data = JSON.stringify({ meta: capture.meta, partition: capture.partition, limits: capture.limits });
    this.reserve(Buffer.byteLength(data));
    writeFileSync(temporary, data, { mode: 0o600 });
    renameSync(temporary, join(directory, "capture.json"));
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const [id, capture] of this.captures) {
      if (!capture.meta.persistent) this.remove(id);
    }
    this.captures.clear();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
