import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { POWER_LOGS_LIMITS } from "../common/power-logs";
import { runPowerLogsQuery } from "./power-logs-query";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "log-query-test-"));
  directories.push(directory);
  const path = join(directory, "logs.sqlite");
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE logs(message TEXT); INSERT INTO logs VALUES ('example')");
  database.close();
  return (sql: string) => runPowerLogsQuery(path, sql);
}

it("handles quoted semicolons, escaped quotes and comments without accepting another statement", () => {
  const query = fixture();
  expect(query("/* ; */ SELECT 'it''s;ok' AS [semi;colon]; -- ; trailing").rows).toEqual([["it's;ok"]]);
  expect(query('SELECT 1 AS "semi;colon" /* ; */').columns).toEqual(["semi;colon"]);
  for (const sql of [
    "SELECT 1; /* comment */ SELECT 2",
    "SELECT 1;;",
    "SELECT 'unterminated",
    "SELECT 1 /* unterminated",
  ])
    expect(() => query(sql)).toThrow("single SELECT");
});

it("bounds result bytes and column counts and preserves array cells with duplicate labels", () => {
  const query = fixture();
  const result = query(
    "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) SELECT printf('%10000s', 'x') FROM n",
  );
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.rows))).toBeLessThan(POWER_LOGS_LIMITS.resultBytes);
  expect(query(`SELECT ${Array.from({ length: 101 }, () => "1").join(",")}`).error).toBeDefined();
  expect(query("SELECT NULL AS x, 9007199254740993 AS x, X'0102' AS x")).toMatchObject({
    columns: ["x", "x", "x"],
    rows: [[null, "9007199254740993", "0102"]],
  });
});

it("denies hidden writes, file access and database introspection while preserving the snapshot", () => {
  const query = fixture();
  for (const sql of [
    "WITH x AS (SELECT 1) DELETE FROM logs",
    "EXPLAIN UPDATE logs SET message='changed'",
    "SELECT * FROM sqlite_schema",
    "SELECT * FROM pragma_table_info('logs')",
    "SELECT load_extension('example')",
    "SELECT readfile('example')",
  ]) {
    try {
      expect(query(sql).error).toBeDefined();
    } catch (error) {
      expect(String(error)).toMatch(/read-only/);
    }
  }
  expect(query("SELECT message FROM logs").rows).toEqual([["example"]]);
});

it("requires a runtime with SQL authorization before preparing queries and still closes the snapshot", () => {
  const query = fixture();
  const authorizer = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "setAuthorizer")!;
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const close = vi.spyOn(DatabaseSync.prototype, "close");
  try {
    Object.defineProperty(DatabaseSync.prototype, "setAuthorizer", { ...authorizer, value: undefined });
    expect(query("SELECT message FROM logs")).toMatchObject({
      columns: [],
      rows: [],
      truncated: false,
      error: "Update Freelens to use secure Power Logs SQL queries. This runtime does not support SQL authorization.",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    Object.defineProperty(DatabaseSync.prototype, "setAuthorizer", authorizer);
    prepare.mockRestore();
    close.mockRestore();
  }
  expect(query("SELECT message FROM logs").rows).toEqual([["example"]]);
});
