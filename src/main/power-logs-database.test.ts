import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPowerLogsLimits } from "../common/power-logs-limits";
import { PowerLogsDatabase } from "./power-logs-database";
import { type PowerLogsQuerySnapshot, runPowerLogsQuery } from "./power-logs-query";

import type { LogCapture, LogRecord } from "../common/power-logs";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

const partition = { clusterId: "cluster-example", contextId: "context-example" };
const target = { kind: "Pod" as const, namespace: "example", name: "example", uid: "uid-example" };
const record: LogRecord = {
  timestamp: 1000,
  pod: "example",
  podUid: "uid-example",
  container: "app",
  level: "info",
  message: "example message",
  fieldsJson: '{"count":3}',
};
const databases: PowerLogsDatabase[] = [];
afterEach(() => {
  applyPowerLogsLimits(undefined);
  for (const db of databases.splice(0)) db.close();
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), "power-logs-test-"));
  const db = new PowerLogsDatabase(directory);
  databases.push(db);
  return { db, directory };
}
async function capture(db: PowerLogsDatabase) {
  const result = (await db.run({ ...partition, operation: "create", target })) as LogCapture;
  await db.run({ ...partition, operation: "append", captureId: result.id, records: [record] });
  await db.run({ ...partition, operation: "finish", captureId: result.id, partial: false, notes: [] });
  return result.id;
}
async function query(db: PowerLogsDatabase, captureId: string, sql: string, queryId = "query-example") {
  const snapshot = (await db.run({
    ...partition,
    operation: "query",
    captureId,
    sql,
    queryId,
  })) as PowerLogsQuerySnapshot;
  return runPowerLogsQuery(snapshot.database, sql);
}

describe("temporary native log captures", () => {
  it("keeps existing capture capacity and expiry when settings change", async () => {
    const { db } = database();
    applyPowerLogsLimits({ captureRows: 2, ttlMs: 120000 });
    const created = (await db.run({ ...partition, operation: "create", target })) as LogCapture;
    applyPowerLogsLimits({ captureRows: 1, ttlMs: 60000 });
    await db.run({ ...partition, operation: "append", captureId: created.id, records: [record, record] });
    const current = (await db.run({ ...partition, operation: "list" })) as LogCapture[];
    expect(current[0]).toMatchObject({ rows: 2, expiresAt: created.expiresAt });
    const next = (await db.run({ ...partition, operation: "create", target })) as LogCapture;
    expect(next.expiresAt - next.createdAt).toBe(60000);
    await expect(
      db.run({ ...partition, operation: "append", captureId: next.id, records: [record, record] }),
    ).rejects.toThrow("limit");
  });
  it("spools privately, materializes typed records only on finish and purges on close", async () => {
    const { db, directory } = database();
    const created = (await db.run({ ...partition, operation: "create", target })) as LogCapture;
    const spool = db.exportPath({ ...partition, operation: "export", captureId: created.id });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(spool).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(directory, created.id))).toEqual(["logs.ndjson"]);
    await db.run({ ...partition, operation: "append", captureId: created.id, records: [record] });
    expect(JSON.parse(readFileSync(spool, "utf8").trim())).toEqual({ ...record, previous: false });
    await db.run({
      ...partition,
      operation: "finish",
      captureId: created.id,
      partial: true,
      notes: ["Capture interrupted"],
    });
    expect(
      (await query(db, created.id, "SELECT timestamp, message, json_extract(fieldsJson, '$.count') FROM logs")).rows,
    ).toEqual([[1000, "example message", 3]]);
    expect(await db.run({ ...partition, operation: "list" })).toEqual([
      expect.objectContaining({ state: "partial", rows: 1 }),
    ]);
    db.close();
    expect(existsSync(directory)).toBe(false);
  });
  it("keeps the spool and collecting state after a failed materialization so finish can retry", async () => {
    const { db, directory } = database();
    const created = (await db.run({ ...partition, operation: "create", target })) as LogCapture;
    await db.run({ ...partition, operation: "append", captureId: created.id, records: [record] });
    const spool = db.exportPath({ ...partition, operation: "export", captureId: created.id });
    const length = statSync(spool).size;
    appendFileSync(spool, "invalid json\n");
    await expect(
      db.run({ ...partition, operation: "finish", captureId: created.id, partial: true, notes: [] }),
    ).rejects.toThrow("storage unavailable");
    expect(existsSync(join(directory, created.id, "logs.sqlite"))).toBe(false);
    expect(await db.run({ ...partition, operation: "list" })).toEqual([
      expect.objectContaining({ state: "collecting", rows: 1 }),
    ]);
    truncateSync(spool, length);
    await db.run({ ...partition, operation: "finish", captureId: created.id, partial: true, notes: [] });
    expect((await query(db, created.id, "SELECT count(*) FROM logs")).rows).toEqual([[1]]);
    expect(statSync(join(directory, created.id, "logs.sqlite")).mode & 0o777).toBe(0o600);
  });
  it("keeps previous and current container records distinguishable", async () => {
    const { db } = database();
    const created = (await db.run({ ...partition, operation: "create", target })) as LogCapture;
    await db.run({
      ...partition,
      operation: "append",
      captureId: created.id,
      records: [record, { ...record, previous: true }],
    });
    await db.run({ ...partition, operation: "finish", captureId: created.id, partial: false, notes: [] });
    expect(
      (await query(db, created.id, "SELECT previous, count(*) FROM logs GROUP BY previous ORDER BY previous")).rows,
    ).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });
  it("isolates captures by context, caps capture count and removes deleted data", async () => {
    const { db } = database();
    const id = await capture(db);
    await expect(db.run({ ...partition, contextId: "other", operation: "delete", captureId: id })).rejects.toThrow(
      "unavailable",
    );
    await capture(db);
    await capture(db);
    await expect(capture(db)).rejects.toThrow("limit");
    const spool = db.exportPath({ ...partition, operation: "export", captureId: id });
    await db.run({ ...partition, operation: "delete", captureId: id });
    expect(existsSync(spool)).toBe(false);
  });
  it("rejects mutations, multiple statements, external readers and configuration changes", async () => {
    const { db } = database();
    const id = await capture(db);
    for (const sql of [
      "DELETE FROM logs",
      "UPDATE logs SET absent_column=1",
      "SELECT 1; SELECT 2",
      "SET threads=8",
      "INSTALL json",
      "SELECT load_extension('forbidden')",
      "SELECT * FROM sqlite_master",
      "SELECT * FROM pragma_table_info('logs')",
      "COPY logs TO '/tmp/forbidden-log-export'",
      "ATTACH DATABASE 'forbidden' AS external",
      "PRAGMA table_info(logs)",
    ])
      await expect(query(db, id, sql)).rejects.toThrow();
    expect(
      (await query(db, id, "-- safe comment\n WITH example AS (SELECT * FROM logs) SELECT count(*) FROM example")).rows,
    ).toEqual([[1]]);
    expect((await query(db, id, "EXPLAIN SELECT * FROM logs")).rows.length).toBeGreaterThan(0);
  });
  it("returns bounded guidance without SQL values", async () => {
    const { db } = database();
    const id = await capture(db);
    const invalid = await query(db, id, "SELECT absent_column FROM logs");
    expect(invalid.error).toContain("Check SQL syntax");
    expect(invalid.rows).toEqual([]);
    expect((await query(db, id, "SELECT 42")).rows).toEqual([[42]]);
  });
  it("caps streaming results and preserves nulls, duplicate labels and large integers", async () => {
    const { db } = database();
    const id = await capture(db);
    const capped = await query(
      db,
      id,
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000) SELECT x FROM n",
    );
    expect(capped.rows).toHaveLength(1000);
    expect(capped.truncated).toBe(true);
    expect((await query(db, id, "SELECT NULL AS x, 9007199254740993 AS x")).rows).toEqual([[null, "9007199254740993"]]);
    expect((await query(db, id, "SELECT ';' AS x; -- trailing comment")).rows).toEqual([[";"]]);
  });
  it.each([
    "EBUSY",
    "EPERM",
  ])("hides expired snapshots locked with %s and retries cleanup without disrupting live captures", async (code) => {
    vi.useFakeTimers();
    const { db } = database();
    const expired = await capture(db);
    const spool = db.exportPath({ ...partition, operation: "export", captureId: expired });
    vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    const live = await capture(db);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const remove = vi.mocked(rmSync).mockImplementation((path, options) => {
      if (path === join(spool, "..")) throw Object.assign(new Error("locked"), { code });
      actual.rmSync(path, options);
    });
    try {
      vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1);
      expect(() => vi.advanceTimersByTime(30000)).not.toThrow();
      expect(existsSync(spool)).toBe(true);
      expect(await db.run({ ...partition, operation: "list" })).toEqual([expect.objectContaining({ id: live })]);
      await expect(query(db, expired, "SELECT 1")).rejects.toThrow("unavailable");
      expect(() => db.exportPath({ ...partition, operation: "export", captureId: expired })).toThrow("unavailable");
      expect((await query(db, live, "SELECT count(*) FROM logs")).rows).toEqual([[1]]);
      remove.mockImplementation(actual.rmSync);
      vi.advanceTimersByTime(30000);
      expect(existsSync(spool)).toBe(false);
      expect((await query(db, live, "SELECT count(*) FROM logs")).rows).toEqual([[1]]);
    } finally {
      remove.mockImplementation(actual.rmSync);
      vi.useRealTimers();
    }
  });
  it("expires captures without restoring data into a new engine", async () => {
    const { db, directory } = database();
    const id = await capture(db);
    const spool = db.exportPath({ ...partition, operation: "export", captureId: id });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60 * 60 * 1000 + 1);
    try {
      expect(await db.run({ ...partition, operation: "list" })).toEqual([]);
      expect(existsSync(spool)).toBe(false);
    } finally {
      clock.mockRestore();
    }
    db.close();
    const fresh = new PowerLogsDatabase(directory);
    databases.push(fresh);
    expect(await fresh.run({ ...partition, operation: "list" })).toEqual([]);
  });
  it("rejects oversized append batches and appending after finish", async () => {
    const { db } = database();
    const result = (await db.run({ ...partition, operation: "create", target })) as LogCapture;
    await expect(
      db.run({ ...partition, operation: "append", captureId: result.id, records: Array(1001).fill(record) }),
    ).rejects.toThrow("limit");
    await expect(
      db.run({
        ...partition,
        operation: "append",
        captureId: result.id,
        records: Array(1000).fill({ ...record, message: "x".repeat(3000) }),
      }),
    ).rejects.toThrow("limit");
    await db.run({ ...partition, operation: "finish", captureId: result.id, partial: false, notes: [] });
    await expect(
      db.run({ ...partition, operation: "append", captureId: result.id, records: [record] }),
    ).rejects.toThrow("complete");
    expect((await query(db, result.id, "SELECT count(*) FROM logs")).rows).toEqual([[0]]);
  });
  it("does not interrupt another capture query when removing a snapshot", async () => {
    const { db } = database();
    const first = await capture(db),
      second = await capture(db);
    const pending = query(db, second, "SELECT 42");
    await db.run({ ...partition, operation: "delete", captureId: first });
    expect((await pending).rows).toEqual([[42]]);
  });
});

it("keeps independent SQL drafts only in temporary capture metadata without executing them", async () => {
  const { db, directory } = database();
  const collecting = (await db.run({ ...partition, operation: "create", target })) as LogCapture;
  expect(collecting.lastSql).toBeUndefined();
  const draft = "DROP TABLE logs; -- incomplete editable draft\nSELECT '";
  const updated = (await db.run({
    ...partition,
    operation: "save-sql",
    captureId: collecting.id,
    sql: draft,
  })) as LogCapture;
  expect(updated).toMatchObject({ id: collecting.id, lastSql: draft, state: "collecting", rows: 0, bytes: 0 });
  expect(readdirSync(join(directory, collecting.id))).toEqual(["logs.ndjson"]);
  const ready = await capture(db);
  await db.run({ ...partition, operation: "save-sql", captureId: ready, sql: "DELETE FROM logs" });
  const listed = (await db.run({ ...partition, operation: "list" })) as LogCapture[];
  expect(listed.map(({ id, lastSql }) => ({ id, lastSql }))).toEqual([
    { id: collecting.id, lastSql: draft },
    { id: ready, lastSql: "DELETE FROM logs" },
  ]);
  expect((await query(db, ready, "SELECT count(*) FROM logs")).rows).toEqual([[1]]);
  updated.lastSql = "renderer mutation";
  expect(((await db.run({ ...partition, operation: "list" })) as LogCapture[])[0].lastSql).toBe(draft);
  await db.run({ ...partition, operation: "delete", captureId: collecting.id });
  expect(await db.run({ ...partition, operation: "list" })).toEqual([
    expect.objectContaining({ id: ready, lastSql: "DELETE FROM logs" }),
  ]);
  await expect(
    db.run({ ...partition, operation: "save-sql", captureId: collecting.id, sql: "replacement" }),
  ).rejects.toThrow("unavailable");
});

it("bounds SQL drafts, preserves whitespace and blank drafts, and enforces capture ownership and expiry", async () => {
  const { db } = database();
  const id = await capture(db);
  for (const sql of ["x".repeat(65536), " \n\t", ""]) {
    expect(await db.run({ ...partition, operation: "save-sql", captureId: id, sql })).toMatchObject({ lastSql: sql });
  }
  for (const sql of ["x".repeat(65537), "SELECT\0", undefined]) {
    await expect(db.run({ ...partition, operation: "save-sql", captureId: id, sql: sql as string })).rejects.toThrow(
      "Invalid SQL draft",
    );
  }
  for (const changed of [{ contextId: "another" }, { clusterId: "another" }]) {
    await expect(
      db.run({ ...partition, ...changed, operation: "save-sql", captureId: id, sql: "changed" }),
    ).rejects.toThrow("unavailable");
  }
  expect(await db.run({ ...partition, operation: "list" })).toEqual([expect.objectContaining({ id, lastSql: "" })]);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60 * 1000 + 1);
  try {
    await expect(db.run({ ...partition, operation: "save-sql", captureId: id, sql: "expired" })).rejects.toThrow(
      "unavailable",
    );
    expect(await db.run({ ...partition, operation: "list" })).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});
