import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, createReadStream, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { POWER_LOGS_LIMITS as L, type LogCapture, type LogRequest } from "../common/power-logs";

import type { PowerLogsQuerySnapshot } from "./power-logs-query";

type Capture = {
  meta: LogCapture;
  partition: string;
  directory: string;
  spool: string;
  database: string;
  limits: { captureBytes: number; captureRows: number };
};
export class PowerLogsDatabase {
  private captures = new Map<string, Capture>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.timer = setInterval(() => this.expire(), 30000);
    this.timer.unref();
  }
  private partition(request: LogRequest): string {
    return JSON.stringify([request.clusterId, request.contextId]);
  }
  private expire(): void {
    for (const [id, capture] of this.captures) {
      if (capture.meta.expiresAt > Date.now()) continue;
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
    if (!capture || capture.partition !== this.partition(request) || capture.meta.expiresAt <= Date.now())
      throw new Error("Capture unavailable");
    return capture;
  }
  async run(request: LogRequest): Promise<unknown> {
    if (this.closed) throw new Error("Log storage unavailable");
    this.expire();
    if (request.operation === "permit" || "streamId" in request) throw new Error("Log permits require main process");
    const partition = this.partition(request);
    if (request.operation === "cancel") return true;
    if (request.operation === "list")
      return [...this.captures.values()]
        .filter((c) => c.partition === partition && c.meta.expiresAt > Date.now())
        .map((c) => ({ ...c.meta }));
    if (request.operation === "create") {
      if (this.captures.size >= L.captures) throw new Error("Capture limit reached");
      const id = randomUUID(),
        directory = join(this.directory, id),
        now = Date.now();
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
      let database: DatabaseSync | undefined;
      try {
        writeFileSync(capture.database, "", { mode: 0o600 });
        database = new DatabaseSync(capture.database, { allowExtension: false });
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
      } catch {
        database?.close();
        database = undefined;
        rmSync(capture.database, { force: true });
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
      expiresAt: capture.meta.expiresAt,
    } satisfies PowerLogsQuerySnapshot;
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.captures.clear();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
