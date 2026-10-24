import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ partialWrite: false }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    appendFileSync(
      path: Parameters<typeof original.appendFileSync>[0],
      data: string | Uint8Array,
      options?: Parameters<typeof original.appendFileSync>[2],
    ) {
      if (fault.partialWrite) {
        fault.partialWrite = false;
        original.appendFileSync(path, typeof data === "string" ? data.slice(0, 8) : data.subarray(0, 8), options);
        throw Object.assign(new Error("Storage full"), { code: "ENOSPC" });
      }
      original.appendFileSync(path, data, options);
    },
  };
});

import { PowerLogsDatabase } from "./power-logs-database";
import { type PowerLogsQuerySnapshot, runPowerLogsQuery } from "./power-logs-query";

import type { LogCapture, LogRecord } from "../common/power-logs";

it("rolls back a partially written NDJSON record so older rows can be finalized and exported", async () => {
  const directory = mkdtempSync(join(tmpdir(), "power-logs-storage-test-"));
  const db = new PowerLogsDatabase(directory);
  const partition = { clusterId: "cluster-example", contextId: "context-example" };
  const target = { kind: "Pod" as const, namespace: "example", name: "example", uid: "uid-example" };
  const record: LogRecord = {
    timestamp: null,
    pod: "example",
    podUid: "uid-example",
    container: "app",
    level: "info",
    message: "first valid example",
    fieldsJson: null,
  };
  try {
    const capture = (await db.run({ ...partition, operation: "create", target })) as LogCapture;
    await db.run({ ...partition, operation: "append", captureId: capture.id, records: [record] });
    const spool = db.exportPath({ ...partition, operation: "export", captureId: capture.id });
    const before = readFileSync(spool, "utf8");
    fault.partialWrite = true;
    await expect(
      db.run({
        ...partition,
        operation: "append",
        captureId: capture.id,
        records: [{ ...record, message: "incomplete example" }],
      }),
    ).rejects.toThrow("storage");
    expect(readFileSync(spool, "utf8")).toBe(before);
    expect(
      await db.run({
        ...partition,
        operation: "finish",
        captureId: capture.id,
        partial: true,
        notes: ["Storage limit reached"],
      }),
    ).toEqual(expect.objectContaining({ rows: 1, state: "partial", bytes: Buffer.byteLength(before) }));
    const snapshot = (await db.run({
      ...partition,
      operation: "query",
      captureId: capture.id,
      queryId: "query-example",
      sql: "SELECT message FROM logs",
    })) as PowerLogsQuerySnapshot;
    const result = runPowerLogsQuery(snapshot.database, "SELECT message FROM logs");
    expect(result.rows).toEqual([["first valid example"]]);
    expect(JSON.parse(readFileSync(spool, "utf8").trim()).message).toBe("first valid example");
  } finally {
    fault.partialWrite = false;
    db.close();
  }
});
