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

it("discovers mixed source schemas but projects only the preferred actual message field", () => {
  const db = database([{ msg: "first", level: "info" }, { message: "second", pod: "source" }, null]);
  const keys = db
    .prepare(JSON_KEY_DISCOVERY_SQL)
    .all()
    .map((row) => String(row.key));
  expect(new Set(keys)).toEqual(new Set(["msg", "level", "message", "pod"]));
  const statement = db.prepare(buildJsonProjectionSql(keys));
  expect(statement.columns().map((column) => column.name)).toEqual(["message"]);
  expect(statement.all()).toEqual([{ message: "second" }, { message: null }]);
});

it("chooses a Pino msg field without inventing a message alias", () => {
  const db = database([{ msg: "actual", level: "info", pid: 1 }]);
  const keys = db
    .prepare(JSON_KEY_DISCOVERY_SQL)
    .all()
    .map((row) => String(row.key));
  const sql = buildJsonProjectionSql(keys);
  expect(sql).toContain(`json_extract(logs.fieldsJson, '$.msg') AS "msg"`);
  expect(sql).not.toContain("json_each");
  const statement = db.prepare(sql);
  expect(statement.columns().map((column) => column.name)).toEqual(["msg"]);
  expect(statement.get()).toEqual({ msg: "actual" });
});

it.each([
  "message",
  "msg",
  "text",
  "Message",
  "RenderedMessage",
  "@m",
  "@mt",
  "body",
  "Body",
])("prefers known message key %s to unrelated fields", (key) => {
  const statement = database([{ unrelated: "skip", [key]: "actual" }]).prepare(
    buildJsonProjectionSql(["unrelated", key]),
  );
  expect(statement.columns().map((column) => column.name)).toEqual([key]);
  expect(statement.get()).toEqual({ [key]: "actual" });
});

it.each([
  'quote"key',
  "a.b[0]",
  "x'); DROP TABLE logs; --",
  "",
  "__proto__",
  "Ä",
])("preserves the first exotic source key without interpreting SQL or JSON paths: %s", (key) => {
  const db = database([
    Object.fromEntries([
      [key, "actual"],
      ["other", "skip"],
    ]),
  ]);
  const statement = db.prepare(buildJsonProjectionSql([key, "other"]));
  expect(statement.columns().map((column) => column.name)).toEqual([key]);
  expect(statement.get()).toEqual({ [key]: "actual" });
  expect(db.prepare("SELECT count(*) AS count FROM logs").get()?.count).toBe(1);
});

it.each([
  { value: null },
  { value: { enabled: true } },
  { value: [1, false] },
])("preserves typed values in the single projected field: %j", ({ value }) => {
  for (const key of ["msg", "a.b"]) {
    const statement = database([{ [key]: value }]).prepare(buildJsonProjectionSql([key]));
    expect(statement.get()).toEqual({ [key]: value === null ? null : JSON.stringify(value) });
  }
});

it("ignores alias collisions and unrelated invalid keys because only one field is projected", () => {
  for (const keys of [
    ["msg", "MSG"],
    ["msg", "msg"],
    ["msg", "x".repeat(129)],
  ]) {
    expect(
      database([{ msg: "actual" }])
        .prepare(buildJsonProjectionSql(keys))
        .get(),
    ).toEqual({ msg: "actual" });
  }
  expect(
    database([{ usable: 42 }])
      .prepare(buildJsonProjectionSql(["bad\0key", "usable"]))
      .get(),
  ).toEqual({ usable: 42 });
});

it.each([
  { keys: [] },
  { keys: ["x".repeat(129)] },
  { keys: ["null\0key"] },
  { keys: Array.from({ length: 65 }, (_, index) => `key${index}`) },
])("falls back to complete JSON when no safe field can be chosen: %j", ({ keys }) => {
  expect(buildJsonProjectionSql(keys)).toBe("SELECT fieldsJson FROM logs WHERE fieldsJson IS NOT NULL LIMIT 100");
});

it("accepts a 128-character first key from a bounded 64-key schema", () => {
  const key = "x".repeat(128);
  const keys = [key, ...Array.from({ length: 63 }, (_, index) => `key${index}`)];
  const statement = database([{ [key]: true }]).prepare(buildJsonProjectionSql(keys));
  expect(statement.columns().map((column) => column.name)).toEqual([key]);
  expect(statement.get()).toEqual({ [key]: 1 });
});

it.each([
  { keys: [] },
  { keys: ["msg"] },
  { keys: ["timestamp", "message"] },
  { keys: ["x".repeat(129)] },
  { keys: null },
  { keys: undefined },
  { keys: 42 },
  { keys: { unexpected: true } },
])("keeps Recent as the original short normalized query regardless of keys: %j", ({ keys }) => {
  const sql = buildJsonProjectionSql(keys as string[], { recent: true });
  expect(sql).toBe(
    "SELECT message, level, container, pod, timestamp FROM logs ORDER BY timestamp DESC NULLS LAST LIMIT 200",
  );
  expect(sql).not.toContain("json_each");
  const db = database([{ msg: "source msg" }, null, { message: "source message" }]);
  const statement = db.prepare(sql);
  expect(statement.columns().map((column) => column.name)).toEqual([
    "message",
    "level",
    "container",
    "pod",
    "timestamp",
  ]);
  expect(statement.all().map((row) => row.message)).toEqual(["plain log", "plain log", "plain log"]);
});

it("bounds discovery to the sample and returns an overflow sentinel", () => {
  const db = database([{ old: true }, ...Array.from({ length: 200 }, () => ({ recent: true }))]);
  expect(db.prepare(JSON_KEY_DISCOVERY_SQL).all()).toEqual([{ key: "recent" }]);
  const many = database([Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, index]))]);
  expect(many.prepare(JSON_KEY_DISCOVERY_SQL).all()).toHaveLength(65);
});

it("discovers JSON keys beyond plain Recent rows while keeping a single valid projection", () => {
  const db = database([{ oldSchema: "retained" }, ...Array.from({ length: 201 }, () => null)]);
  const keys = db
    .prepare(JSON_KEY_DISCOVERY_SQL)
    .all()
    .map((row) => String(row.key));
  expect(keys).toContain("oldSchema");
  expect(keys).not.toContain("message");
  expect(db.prepare(buildJsonProjectionSql(keys)).get()).toEqual({ oldSchema: "retained" });
});

it("keeps the actual msg key when plain log rows are mixed with JSON", () => {
  const db = database([null, { msg: "actual message" }, null]);
  const keys = db
    .prepare(JSON_KEY_DISCOVERY_SQL)
    .all()
    .map((row) => String(row.key));
  expect(keys).toEqual(["msg"]);
  expect(db.prepare(buildJsonProjectionSql(keys)).all()).toEqual([{ msg: "actual message" }]);
});
