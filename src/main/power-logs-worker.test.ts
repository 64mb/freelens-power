import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fork, paths } = vi.hoisted(() => ({ fork: vi.fn(), paths: { userData: "/tmp/power-logs-user-data-test" } }));
vi.mock("electron", () => ({ app: { getPath: () => paths.userData }, utilityProcess: { fork } }));

import { POWER_LOGS_LIMITS } from "../common/power-logs";
import { applyPowerLogsLimits } from "../common/power-logs-limits";
import { PowerLogsDatabase } from "./power-logs-database";
import { PowerLogsWorker, sweepPowerLogsStorage } from "./power-logs-worker";

import type { LogCapture, LogRequest } from "../common/power-logs";

const partition = { clusterId: "cluster-example", contextId: "context-example" };
class Child extends EventEmitter {
  kill = vi.fn();
  postMessage = vi.fn();
}
afterEach(() => {
  applyPowerLogsLimits(undefined);
  vi.useRealTimers();
  fork.mockReset();
});
describe("isolated log worker lifecycle", () => {
  it("purges unpinned files through worker shutdown while retaining saved captures", async () => {
    const root = mkdtempSync(join(tmpdir(), "logs-worker-persistence-"));
    paths.userData = root;
    const child = new Child();
    let database!: PowerLogsDatabase;
    fork.mockImplementationOnce((_path, directories: string[]) => {
      database = new PowerLogsDatabase(directories[0], directories[1]);
      child.postMessage.mockImplementation(({ id, request }: { id: number; request: LogRequest }) => {
        void database.run(request).then(
          (result) => child.emit("message", { id, result }),
          () => child.emit("message", { id, error: "unavailable" }),
        );
      });
      return child;
    });
    const worker = new PowerLogsWorker();
    const directory = fork.mock.calls[0][1][0] as string;
    const saved = fork.mock.calls[0][1][1] as string;
    try {
      const ids: string[] = [];
      for (let index = 0; index < 2; index++) {
        const capture = (await worker.call({
          ...partition,
          operation: "create",
          target: { kind: "Pod", namespace: "example", name: "example", uid: "example" },
        })) as LogCapture;
        ids.push(capture.id);
        await worker.call({ ...partition, operation: "finish", captureId: capture.id, partial: false, notes: [] });
        await worker.call({ ...partition, operation: "set-persistent", captureId: capture.id, persistent: true });
      }
      await worker.call({ ...partition, operation: "set-persistent", captureId: ids[0], persistent: false });
      expect(existsSync(join(saved, ids[0]))).toBe(false);
      expect(existsSync(join(directory, ids[0], "logs.sqlite"))).toBe(true);
      worker.close();
      child.emit("exit", 0);
      expect(existsSync(directory)).toBe(false);
      expect(existsSync(join(saved, ids[1], "logs.sqlite"))).toBe(true);
    } finally {
      worker.close();
      child.emit("exit", 0);
      database.close();
      paths.userData = "/tmp/power-logs-user-data-test";
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    ["Saved snapshot limit reached. Delete a saved snapshot before keeping another.", "Saved snapshot limit reached"],
    ["private filesystem detail", "Log operation failed or exceeded its limit"],
  ])("only exposes the known capture limit error [%s]", async (error, expected) => {
    const child = new Child();
    fork.mockReturnValue(child);
    const worker = new PowerLogsWorker();
    try {
      const pending = worker.call({ ...partition, operation: "list" });
      const { id } = child.postMessage.mock.calls[0][0];
      child.emit("message", { id, error });
      await expect(pending).rejects.toThrow(expected);
    } finally {
      worker.close();
      child.emit("exit", 0);
    }
  });
  it("forwards trusted limit snapshots separately from request data", async () => {
    const child = new Child();
    fork.mockReturnValue(child);
    const worker = new PowerLogsWorker();
    try {
      applyPowerLogsLimits({ resultRows: 123 });
      const pending = worker.call({ ...partition, operation: "list" });
      const envelope = child.postMessage.mock.calls[0][0];
      expect(envelope.limits.resultRows).toBe(123);
      expect(envelope.request).not.toHaveProperty("limits");
      applyPowerLogsLimits({ resultRows: 456 });
      expect(envelope.limits.resultRows).toBe(123);
      child.emit("message", { id: envelope.id, result: [] });
      await pending;
      expect(worker.isClosed).toBe(false);
    } finally {
      worker.close();
      child.emit("exit", 0);
    }
  });
  it("sweeps crashed session roots while preserving active sessions and symlinks", () => {
    const directory = mkdtempSync(join(tmpdir(), "logs-sweep-test-"));
    const root = join(directory, "storage");
    mkdirSync(root, { mode: 0o700 });
    const dead = join(root, "2147483646-00000000-0000-4000-8000-000000000001");
    const live = join(root, `${process.pid}-00000000-0000-4000-8000-000000000002`);
    const outside = join(directory, "outside");
    const link = join(root, "2147483646-00000000-0000-4000-8000-000000000003");
    for (const path of [dead, live, outside]) mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(dead, "logs.ndjson"), "private example");
    writeFileSync(join(outside, "sentinel"), "example");
    symlinkSync(outside, link);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === process.pid) return true;
      throw Object.assign(new Error("No process"), { code: "ESRCH" });
    });
    try {
      expect(sweepPowerLogsStorage(root)).toBe(root);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(link)).toBe(true);
      expect(existsSync(join(outside, "sentinel"))).toBe(true);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(() => sweepPowerLogsStorage(link)).toThrow("unavailable");
    } finally {
      kill.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("rejects pending requests immediately and purges only after process exit", async () => {
    const child = new Child();
    fork.mockReturnValue(child);
    const worker = new PowerLogsWorker();
    const directory = fork.mock.calls[0][1][0] as string;
    const request = worker.call({ ...partition, operation: "list" });
    const rejected = expect(request).rejects.toThrow("unavailable");
    worker.close();
    expect(worker.isClosed).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(existsSync(directory)).toBe(true);
    await rejected;
    child.emit("exit", 0);
    expect(existsSync(directory)).toBe(false);
  });
  it("marks a timed out process closed so the IPC owner can replace it", async () => {
    vi.useFakeTimers();
    const child = new Child();
    fork.mockReturnValue(child);
    const worker = new PowerLogsWorker();
    const request = worker.call({ ...partition, operation: "list" });
    const rejected = expect(request).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expect(worker.isClosed).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", 1);
    await expect(worker.call({ ...partition, operation: "list" })).rejects.toThrow("unavailable");
  });
  function setupQuery() {
    const storage = new Child(),
      sql = new Child(),
      nextSql = new Child();
    fork.mockReturnValueOnce(storage).mockReturnValueOnce(sql).mockReturnValueOnce(nextSql);
    const worker = new PowerLogsWorker();
    const directory = fork.mock.calls[0][1][0] as string;
    const request = {
      ...partition,
      operation: "query" as const,
      captureId: "capture-example",
      queryId: "query-example",
      sql: "SELECT 42",
    };
    const reply = (result: unknown) => {
      const { id } = storage.postMessage.mock.calls.at(-1)![0];
      storage.emit("message", { id, result });
    };
    const snapshot = {
      database: join(directory, request.captureId, "logs.sqlite"),
      captureId: request.captureId,
      expiresAt: Date.now() + 60000,
    };
    const start = async () => {
      const pending = worker.call(request);
      reply(snapshot);
      await Promise.resolve();
      return { pending };
    };
    const cleanup = () => {
      worker.close();
      storage.emit("exit", 0);
      sql.emit("exit", 0);
      nextSql.emit("exit", 0);
    };
    return { storage, sql, nextSql, worker, directory, request, reply, snapshot, start, cleanup };
  }
  it.each([
    "clear-persistent",
    "clear-storage",
  ] as const)("drains readers from other partitions before %s", async (operation) => {
    const f = setupQuery();
    try {
      const { pending } = await f.start();
      const rejected = expect(pending).rejects.toThrow("canceled");
      const clearing = f.worker.call({ ...partition, contextId: "other-context", operation });
      await rejected;
      expect(f.sql.kill).toHaveBeenCalled();
      expect(f.storage.postMessage.mock.calls).toHaveLength(1);
      f.sql.emit("exit", 0);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(f.storage.postMessage.mock.calls.at(-1)![0].request.operation).toBe(operation);
      f.reply(true);
      await expect(clearing).resolves.toBe(true);
    } finally {
      f.cleanup();
    }
  });
  it("cancels only the SQL process, preserves captures and runs another query", async () => {
    const f = setupQuery();
    try {
      const { pending } = await f.start();
      const rejected = expect(pending).rejects.toThrow("canceled");
      const cancel = f.worker.call({ ...partition, operation: "cancel", queryId: f.request.queryId });
      f.reply(true);
      await cancel;
      await rejected;
      expect(f.sql.kill).toHaveBeenCalledOnce();
      expect(f.storage.kill).not.toHaveBeenCalled();
      expect(f.worker.isClosed).toBe(false);
      const list = f.worker.call({ ...partition, operation: "list" });
      f.reply([{ id: f.request.captureId }]);
      await expect(list).resolves.toEqual([{ id: f.request.captureId }]);
      f.sql.emit("exit", 0);
      const next = f.worker.call({ ...f.request, queryId: "next-query" });
      f.reply(f.snapshot);
      await Promise.resolve();
      expect(f.nextSql.postMessage).toHaveBeenCalledWith({
        id: 1,
        database: f.snapshot.database,
        sql: "SELECT 42",
        limits: { ...POWER_LOGS_LIMITS },
      });
      f.nextSql.emit("message", { id: 1, result: { columns: ["42"], rows: [[42]] } });
      await expect(next).resolves.toEqual({ columns: ["42"], rows: [[42]] });
    } finally {
      f.cleanup();
    }
  });
  it("latches cancellation while storage prepares the snapshot and never spawns SQL", async () => {
    const f = setupQuery();
    try {
      const pending = f.worker.call(f.request);
      const preparationId = f.storage.postMessage.mock.calls[0][0].id;
      const rejected = expect(pending).rejects.toThrow("canceled");
      const cancel = f.worker.call({ ...partition, operation: "cancel", queryId: f.request.queryId });
      f.reply(true);
      await cancel;
      f.storage.emit("message", { id: preparationId, result: f.snapshot });
      await rejected;
      await Promise.resolve();
      expect(fork).toHaveBeenCalledOnce();
      expect(f.storage.kill).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it("times out SQL without closing storage", async () => {
    vi.useFakeTimers();
    const f = setupQuery();
    try {
      const { pending } = await f.start();
      const rejected = expect(pending).rejects.toThrow("time limit");
      await vi.advanceTimersByTimeAsync(15000);
      await rejected;
      expect(f.sql.kill).toHaveBeenCalledOnce();
      expect(f.storage.kill).not.toHaveBeenCalled();
      expect(f.worker.isClosed).toBe(false);
      const list = f.worker.call({ ...partition, operation: "list" });
      f.reply([]);
      await expect(list).resolves.toEqual([]);
    } finally {
      f.cleanup();
    }
  });
  it("rejects simultaneous queries before sending another storage request", async () => {
    const f = setupQuery();
    try {
      const { pending } = await f.start();
      const rejected = expect(pending).rejects.toThrow("unavailable");
      await expect(f.worker.call({ ...f.request, queryId: "other" })).rejects.toThrow("busy");
      expect(f.storage.postMessage).toHaveBeenCalledOnce();
      f.worker.close();
      await rejected;
    } finally {
      f.cleanup();
    }
  });
  it("waits for both storage and SQL exits before purging their files", async () => {
    const f = setupQuery();
    try {
      const { pending } = await f.start();
      const rejected = expect(pending).rejects.toThrow("unavailable");
      f.worker.close();
      await rejected;
      expect(existsSync(f.directory)).toBe(true);
      f.storage.emit("exit", 0);
      expect(existsSync(f.directory)).toBe(true);
      f.sql.emit("exit", 0);
      expect(existsSync(f.directory)).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it.each(["delete", "unpin"])("waits for the reader exit before %s", async (operation) => {
    const f = setupQuery();
    try {
      const { pending } = await f.start();
      const rejected = expect(pending).rejects.toThrow("canceled");
      const remove = f.worker.call(
        operation === "delete"
          ? { ...partition, operation: "delete", captureId: f.request.captureId }
          : { ...partition, operation: "set-persistent", captureId: f.request.captureId, persistent: false },
      );
      await rejected;
      expect(f.storage.postMessage).toHaveBeenCalledOnce();
      await expect(f.worker.call(f.request)).rejects.toThrow("busy");
      f.sql.emit("exit", 0);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.storage.postMessage).toHaveBeenCalledTimes(2);
      f.reply(true);
      await expect(remove).resolves.toBe(true);
      expect(f.storage.kill).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
  it("does not cancel a query for another partition with the same identifiers", async () => {
    const f = setupQuery();
    try {
      const { pending } = await f.start();
      for (const scope of [
        { ...partition, contextId: "other" },
        { ...partition, clusterId: "other" },
      ]) {
        const cancel = f.worker.call({ ...scope, operation: "cancel", queryId: f.request.queryId });
        f.reply(true);
        await cancel;
        const remove = f.worker.call({ ...scope, operation: "delete", captureId: f.request.captureId });
        f.reply(true);
        await remove;
      }
      expect(f.sql.kill).not.toHaveBeenCalled();
      f.sql.emit("message", { id: 1, result: { rows: [[42]] } });
      await expect(pending).resolves.toEqual({ rows: [[42]] });
    } finally {
      f.cleanup();
    }
  });
});
