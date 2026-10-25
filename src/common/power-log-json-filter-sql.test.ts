import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { runPowerLogsQuery } from "../main/power-logs-query";
import { type JSONValue, matchesAllJsonFilters } from "./power-log-field-filters";
import { buildJsonFilterSql, type SqlJsonFieldFilter } from "./power-log-json-filter-sql";

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function database(rows: string[], column = "json") {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const identifier = `"${column.replace(/"/g, '""')}"`;
  db.exec(`CREATE TABLE logs (id INTEGER PRIMARY KEY, ${identifier} TEXT)`);
  const insert = db.prepare(`INSERT INTO logs (id, ${identifier}) VALUES (?, ?)`);
  rows.forEach((value, i) => insert.run(i, value));
  return db;
}

function ids(db: DatabaseSync, filters: SqlJsonFieldFilter[], base = "SELECT * FROM logs") {
  return db
    .prepare(buildJsonFilterSql(base, filters))
    .all()
    .map((row) => Number(row.id));
}

it("preserves the query without filters and filters outside its order and limit", () => {
  const base = " SELECT * FROM logs ORDER BY id DESC LIMIT 1; \n";
  expect(buildJsonFilterSql(base, [])).toBe(base);
  const db = database(['{"a":1}', '{"a":2}']);
  const filters: SqlJsonFieldFilter[] = [{ column: "json", path: ["a"], operator: "eq", value: 1 }];
  expect(ids(db, filters, base)).toEqual([]);
  expect(buildJsonFilterSql(base, filters)).toContain(
    'SELECT * FROM (SELECT * FROM logs ORDER BY id DESC LIMIT 1\n) AS "__power_rows" WHERE',
  );
});

it("matches the in-memory semantics for typed values, missing fields, and AND filters", () => {
  const fields: JSONValue[] = [
    { a: null, b: 1 },
    { a: "null", b: 1 },
    { b: 1 },
    { a: true, b: 2 },
    { a: 1, b: 1 },
    { a: "1", b: 2 },
    { a: false, b: 1 },
    { a: { first: 1, second: [true, null] }, b: 2 },
    { a: { second: [true, null], first: 1 }, b: 1 },
    { a: [1, 2], b: 1 },
    { a: [2, 1], b: 1 },
  ];
  const db = database(fields.map((value) => JSON.stringify(value)));
  for (const value of [null, true, false, 1, "1", "null", { first: 1, second: [true, null] }, [1, 2]] as JSONValue[]) {
    for (const operator of ["eq", "neq"] as const) {
      for (const additional of [[], [{ column: "json", path: ["b"], operator: "eq" as const, value: 1 }]]) {
        const filters: SqlJsonFieldFilter[] = [{ column: "json", path: ["a"], operator, value }, ...additional];
        expect(ids(db, filters)).toEqual(
          fields.flatMap((field, id) => (matchesAllJsonFilters(field, filters) ? [id] : [])),
        );
      }
    }
  }
});

it("supports literal keys, quotes, brackets, numeric array indices and own prototype-like keys", () => {
  const field = JSON.parse('{"a.b[\\"c\\"]":[{"quote\'key":{"__proto__":42}}]}');
  const db = database([JSON.stringify(field)]);
  expect(
    ids(db, [{ column: "json", path: ['a.b["c"]', 0, "quote'key", "__proto__"], operator: "eq", value: 42 }]),
  ).toEqual([0]);
  expect(ids(db, [{ column: "json", path: ['a.b["c"]', "0"], operator: "eq", value: field['a.b["c"]'][0] }])).toEqual(
    [],
  );
});

it("safely quotes column identifiers and injection-like string values and keys", () => {
  const column = 'j" WHERE 1=1 --';
  const key = "x' OR 1=1 --";
  const value = "'; DROP TABLE logs; --";
  const db = database([JSON.stringify({ [key]: value }), JSON.stringify({ [key]: "other" })], column);
  expect(ids(db, [{ column, path: [key], operator: "eq", value }])).toEqual([0]);
  expect(db.prepare("SELECT count(*) AS n FROM logs").get()?.n).toBe(2);
});

it("treats invalid JSON as missing and compares scalar roots with their JSON types", () => {
  const db = database(["invalid", "null", '"null"', "true", "1", "1.0", "false", "{}", "[]"]);
  expect(ids(db, [{ column: "json", path: [], operator: "eq", value: null }])).toEqual([1]);
  expect(ids(db, [{ column: "json", path: [], operator: "neq", value: null }])).toEqual([0, 2, 3, 4, 5, 6, 7, 8]);
  expect(ids(db, [{ column: "json", path: [], operator: "eq", value: 1 }])).toEqual([4, 5]);
  expect(ids(db, [{ column: "json", path: [], operator: "eq", value: {} }])).toEqual([7]);
  expect(ids(db, [{ column: "json", path: [], operator: "eq", value: [] }])).toEqual([8]);
  expect(ids(db, [{ column: "json", path: ["a"], operator: "eq", value: null }])).toEqual([]);
});

it("normalizes integer and real types inside structures without conflating booleans", () => {
  const db = database(['{"a":1.0,"b":[2.0]}', '{"b":[2],"a":1}', '{"a":true,"b":[2]}']);
  expect(ids(db, [{ column: "json", path: [], operator: "eq", value: { a: 1, b: [2] } }])).toEqual([0, 1]);
});

it("rejects malformed filters, excessive paths, and excessive SQL without truncation", () => {
  for (const filter of [
    null,
    { column: "json", path: [-1], operator: "eq", value: 1 },
    { column: "json", path: [1.5], operator: "eq", value: 1 },
    { column: "json", path: [], operator: "other", value: null },
    { column: "json", path: new Array(129).fill("a"), operator: "eq", value: 1 },
    { column: "json", path: [], operator: "eq", value: undefined },
    { column: "json\0bad", path: [], operator: "eq", value: 1 },
  ]) {
    expect(() => buildJsonFilterSql("SELECT * FROM logs", [filter] as SqlJsonFieldFilter[])).toThrow();
  }
  expect(() =>
    buildJsonFilterSql("SELECT * FROM logs", [{ column: "json", path: [], operator: "eq", value: "x".repeat(65536) }]),
  ).toThrow("exceeds");
});

it("compares decoded key spellings and JavaScript numeric precision consistently", () => {
  const db = database(['{"\\u0061":{"x\\u002ey":9007199254740993}}', '{"a":{"x.y":9007199254740992}}']);
  expect(ids(db, [{ column: "json", path: [], operator: "eq", value: { a: { "x.y": 9007199254740992 } } }])).toEqual([
    0, 1,
  ]);
  expect(ids(db, [{ column: "json", path: ["a", "x.y"], operator: "eq", value: 9007199254740992 }])).toEqual([0, 1]);
});

it.each([
  "SELECT * FROM logs -- trailing comment",
  "SELECT * FROM logs -- trailing comment\n",
  "SELECT * FROM logs; -- trailing comment",
  "SELECT * FROM logs; /* trailing comment ; */",
  "SELECT * FROM logs; /* first */ -- last ;",
  "SELECT * FROM logs /* before ; */; -- after ;\n/* last */",
  "SELECT *, 'it''s; -- /* fine */' AS quoted FROM logs; -- tail",
  'SELECT *, 1 AS "quote"";--" FROM logs; /* tail */',
  "SELECT *, 1 AS `quote``;--` FROM logs; -- tail",
  "SELECT *, 1 AS [semi;--] FROM logs; -- tail",
])("wraps comment-terminated SQL safely in SQLite and the production executor: %s", (base) => {
  const filters: SqlJsonFieldFilter[] = [{ column: "json", path: ["a"], operator: "eq", value: 1 }];
  const db = database(['{"a":1}', '{"a":2}']);
  expect(ids(db, filters, base)).toEqual([0]);
  const directory = mkdtempSync(join(tmpdir(), "log-sql-comments-"));
  const path = join(directory, "logs.sqlite");
  try {
    const file = new DatabaseSync(path);
    file.exec("CREATE TABLE logs(id INTEGER, json TEXT); INSERT INTO logs VALUES (0, '{\"a\":1}'), (1, '{\"a\":2}')");
    file.close();
    const result = runPowerLogsQuery(path, buildJsonFilterSql(base, filters));
    expect(result.error).toBeUndefined();
    expect(result.rows.map((row) => row[0])).toEqual([0]);
    for (const malicious of [
      "SELECT * FROM logs; SELECT * FROM logs",
      "SELECT * FROM logs; /* opaque ; */ SELECT * FROM logs; -- tail",
      "SELECT * FROM logs;; -- tail",
    ]) {
      expect(() => runPowerLogsQuery(path, buildJsonFilterSql(malicious, filters))).toThrow("single SELECT");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
