import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { buildJsonProjectionSql, JSON_KEY_DISCOVERY_SQL } from "./power-log-json-preset";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function database(rows: (Record<string, unknown> | null)[]) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE logs(fieldsJson TEXT, message TEXT, level TEXT, container TEXT, pod TEXT, timestamp INTEGER)");
  const insert = db.prepare("INSERT INTO logs(fieldsJson, message, timestamp) VALUES (?, ?, ?)");
  rows.forEach((row, index) => insert.run(row === null ? null : JSON.stringify(row), "plain log", index));
  return db;
}

it("discovers original keys and preserves their names across mixed log formats", () => {
  const db = database([{ msg: "first", level: "info" }, { message: "second", pod: "source" }, null]);
  const keys = db
    .prepare(JSON_KEY_DISCOVERY_SQL)
    .all()
    .map((row) => String(row.key));
  expect(new Set(keys)).toEqual(new Set(["msg", "level", "message", "pod"]));
  const statement = db.prepare(buildJsonProjectionSql(keys));
  expect(statement.columns().map((column) => column.name)).toEqual(keys);
  expect(statement.all()).toEqual([
    { msg: null, level: null, message: "second", pod: "source" },
    { msg: "first", level: "info", message: null, pod: null },
  ]);
});

it("quotes literal keys and aliases without interpreting JSON paths or SQL", () => {
  const keys = ["msg", 'quote"key', "a.b[0]", "x'); DROP TABLE logs; --", "", "__proto__"];
  const record = Object.fromEntries(keys.map((key, index) => [key, index]));
  const db = database([record]);
  const statement = db.prepare(buildJsonProjectionSql(keys));
  expect(statement.columns().map((column) => column.name)).toEqual(keys);
  expect(statement.get()).toEqual(record);
  expect(db.prepare("SELECT count(*) AS count FROM logs").get()?.count).toBe(1);
});

it("bounds discovery to recent JSON rows and returns an overflow sentinel key", () => {
  const db = database([{ old: true }, ...Array.from({ length: 200 }, () => ({ recent: true }))]);
  expect(db.prepare(JSON_KEY_DISCOVERY_SQL).all()).toEqual([{ key: "recent" }]);
  const many = database([Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, index]))]);
  expect(many.prepare(JSON_KEY_DISCOVERY_SQL).all()).toHaveLength(65);
});

it.each([
  [],
  ["msg", "MSG"],
  ["msg", "msg"],
  ["x".repeat(129)],
  ["null\0key"],
  Array.from({ length: 65 }, (_, index) => `key${index}`),
])("falls back to complete JSON when keys cannot be represented safely: %j", (...keys) => {
  expect(buildJsonProjectionSql(keys)).toBe("SELECT fieldsJson FROM logs WHERE fieldsJson IS NOT NULL LIMIT 100");
});

it("accepts 64 columns, 128-character keys and distinct Unicode casing", () => {
  const keys = ["x".repeat(128), "Ä", "ä", ...Array.from({ length: 61 }, (_, index) => `key${index}`)];
  const db = database([Object.fromEntries(keys.map((key) => [key, true]))]);
  expect(db.prepare(buildJsonProjectionSql(keys)).columns()).toHaveLength(64);
});

it("shows original fields for Recent and preserves plain messages in mixed captures", () => {
  const db = database([{ msg: "source msg" }, null, { message: "source message" }]);
  const keys = db
    .prepare(JSON_KEY_DISCOVERY_SQL)
    .all()
    .map((row) => String(row.key));
  expect(new Set(keys)).toEqual(new Set(["msg", "message"]));
  const statement = db.prepare(buildJsonProjectionSql(keys, { recent: true }));
  expect(statement.columns().map((column) => column.name)).toEqual(keys);
  expect(statement.all()).toEqual([
    { msg: null, message: "source message" },
    { msg: null, message: "plain log" },
    { msg: "source msg", message: null },
  ]);
});

it("keeps Recent msg columns without inventing a message column for JSON-only captures", () => {
  const db = database([{ msg: "first" }, { msg: "second" }]);
  const keys = db
    .prepare(JSON_KEY_DISCOVERY_SQL)
    .all()
    .map((row) => String(row.key));
  const statement = db.prepare(buildJsonProjectionSql(keys, { recent: true }));
  expect(statement.columns().map((column) => column.name)).toEqual(["msg"]);
  expect(statement.all()).toEqual([{ msg: "second" }, { msg: "first" }]);
});

it("falls back to the stored log schema for Recent when keys are unsafe or unavailable", () => {
  const db = database([null]);
  for (const keys of [[], ["msg", "MSG"], ["x".repeat(129)]]) {
    const statement = db.prepare(buildJsonProjectionSql(keys, { recent: true }));
    expect(statement.columns().map((column) => column.name)).toEqual([
      "fieldsJson",
      "message",
      "level",
      "container",
      "pod",
      "timestamp",
    ]);
    expect(statement.get()).toEqual({
      fieldsJson: null,
      message: "plain log",
      level: null,
      container: null,
      pod: null,
      timestamp: 0,
    });
  }
});

it("orders Recent by capture timestamps when source JSON also defines timestamp", () => {
  const db = database([{ timestamp: "z", msg: "old" }, { timestamp: "a", msg: "new" }, null]);
  const rows = db.prepare(buildJsonProjectionSql(["timestamp", "msg", "message"], { recent: true })).all();
  expect(rows.map((row) => row.msg ?? row.message)).toEqual(["plain log", "new", "old"]);
});

it("discovers the full JSON preset sample even when newest Recent rows are all plain", () => {
  const db = database([{ oldSchema: "retained" }, ...Array.from({ length: 201 }, () => null)]);
  const keys = db
    .prepare(JSON_KEY_DISCOVERY_SQL)
    .all()
    .map((row) => String(row.key));
  expect(keys).toContain("oldSchema");
  expect(db.prepare(buildJsonProjectionSql(keys)).get()?.oldSchema).toBe("retained");
});
