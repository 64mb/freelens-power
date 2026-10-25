import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { type JSONValue, matchesAllJsonFilters } from "../common/power-log-field-filters";
import { buildJsonFilterSql, type SqlJsonFieldFilter } from "../common/power-log-json-filter-sql";
import { buildJsonProjectionSql, JSON_KEY_DISCOVERY_SQL } from "../common/power-log-json-preset";
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

it("runs generated typed JSON filters through the production SQL authorizer", () => {
  const directory = mkdtempSync(join(tmpdir(), "log-json-query-test-"));
  directories.push(directory);
  const path = join(directory, "logs.sqlite");
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE logs(id INTEGER, fields TEXT COLLATE NOCASE); CREATE TABLE unrelated(secret TEXT)");
  const fields: JSONValue[] = [
    { value: 1, group: "api" },
    { value: "1", group: "api" },
    { value: null, group: "api" },
    { group: "worker" },
    { value: true, group: "api" },
    { value: { a: 1, b: [false, null] }, group: "api" },
    { value: { b: [false, null], a: 1 }, group: "worker" },
    { 'dot["key"]': [{ "quote'key": "quoted'value" }], group: "api" },
    { value: "API", group: "api" },
    { value: "api", group: "api" },
    { value: { Kind: "API" }, group: "api" },
    { value: { kind: "api" }, group: "api" },
  ];
  const insert = database.prepare("INSERT INTO logs(id, fields) VALUES (?, ?)");
  fields.forEach((value, id) => insert.run(id, JSON.stringify(value)));
  database.close();
  for (const value of [1, "1", null, true, "API", { b: [false, null], a: 1 }, { Kind: "API" }] as JSONValue[]) {
    for (const operator of ["eq", "neq"] as const) {
      for (const extra of [[], [{ column: "fields", path: ["group"], operator: "eq" as const, value: "api" }]]) {
        const filters: SqlJsonFieldFilter[] = [{ column: "fields", path: ["value"], operator, value }, ...extra];
        const result = runPowerLogsQuery(path, buildJsonFilterSql("SELECT id, fields FROM logs ORDER BY id", filters));
        expect(result.error).toBeUndefined();
        expect(result.rows.map((row) => row[0])).toEqual(
          fields.flatMap((field, id) => (matchesAllJsonFilters(field, filters) ? [id] : [])),
        );
      }
    }
  }
  const quoted: SqlJsonFieldFilter[] = [
    { column: "fields", path: ['dot["key"]', 0, "quote'key"], operator: "eq", value: "quoted'value" },
    { column: "fields", path: ["group"], operator: "eq", value: "api" },
  ];
  expect(
    runPowerLogsQuery(path, buildJsonFilterSql("SELECT id FROM (SELECT * FROM logs)", quoted)).error,
  ).toBeDefined();
  expect(
    runPowerLogsQuery(path, buildJsonFilterSql("SELECT id, fields FROM logs", quoted)).rows.map((row) => row[0]),
  ).toEqual([7]);
  for (const sql of [
    "SELECT * FROM sqlite_master",
    "SELECT * FROM pragma_table_info('logs')",
    "SELECT * FROM unrelated",
    "SELECT value FROM json_tree('{}')",
    "SELECT json FROM json_each('{}')",
    "SELECT root FROM json_each('{}')",
    "SELECT value FROM json_each(readfile('example'))",
    "SELECT value FROM json_each('{}'); ATTACH 'example' AS other",
  ]) {
    try {
      expect(runPowerLogsQuery(path, sql).error).toBeDefined();
    } catch (error) {
      expect(String(error)).toMatch(/read-only|single SELECT/);
    }
  }
});

it("executes original JSON presets through the production read-only authorizer", () => {
  const directory = mkdtempSync(join(tmpdir(), "log-preset-test-"));
  directories.push(directory);
  const path = join(directory, "logs.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE logs(timestamp INTEGER, fieldsJson TEXT, message TEXT)");
  db.prepare("INSERT INTO logs VALUES (?,?,?)").run(1, '{"msg":"ready","levelname":"DEBUG"}', "ready");
  db.prepare("INSERT INTO logs VALUES (?,?,?)").run(2, null, "plain");
  db.close();
  const schema = runPowerLogsQuery(path, JSON_KEY_DISCOVERY_SQL);
  expect(schema.error).toBeUndefined();
  const keys = schema.rows.map((row) => String(row[0]));
  expect(keys).toEqual(expect.arrayContaining(["msg", "levelname", "message"]));
  const projected = runPowerLogsQuery(path, buildJsonProjectionSql(keys, { recent: true }));
  expect(projected.error).toBeUndefined();
  expect(projected.columns).toContain("msg");
  expect(projected.rows[0][projected.columns.indexOf("message")]).toBe("plain");
  expect(projected.rows[1][projected.columns.indexOf("msg")]).toBe("ready");
});
