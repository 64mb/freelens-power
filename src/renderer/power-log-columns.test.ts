import { expect, it } from "vitest";
import { createLogColumnReader, logColumnLabel } from "./power-log-columns";

import type { LogRecord } from "../common/power-logs";

function record(fieldsJson: string | null): LogRecord {
  return { timestamp: null, pod: "sample", podUid: "sample", container: "app", level: "info", message: "", fieldsJson };
}

it("labels literal keys and typed array indices unambiguously", () => {
  expect(logColumnLabel(["a.b", "0", 0, 'quote"'])).toBe('$["a.b"]["0"][0]["quote\\\""]');
  expect(logColumnLabel([])).toBe("$");
});

it("reads the same typed path across records and preserves scalar values", () => {
  const read = createLogColumnReader();
  const row = record('{"items":[{"value":false}],"zero":0,"empty":"","nil":null,"0":"key"}');
  expect(read(row, ["items", 0, "value"])).toBe("false");
  expect(read(record('{"items":[{"value":"next"}]}'), ["items", 0, "value"])).toBe("next");
  expect(read(row, ["items", "0", "value"])).toBe("—");
  expect(read(row, [0])).toBe("—");
  expect(read(row, ["0"])).toBe("key");
  expect(read(row, ["zero"])).toBe("0");
  expect(read(row, ["empty"])).toBe('""');
  expect(read(row, ["nil"])).toBe("null");
  expect(read(row, ["nil", "missing"])).toBe("—");
});

it("guards inherited properties while retaining explicit prototype-like keys", () => {
  const read = createLogColumnReader();
  const row = record('{"__proto__":{"value":"own"}}');
  expect(read(row, ["__proto__", "value"])).toBe("own");
  expect(read(row, ["constructor"])).toBe("—");
  expect(read(row, ["__proto__", "toString"])).toBe("—");
});

it("rejects invalid, duplicate, absent and oversized source JSON", () => {
  const read = createLogColumnReader();
  for (const source of [null, '{"a":', '{"a":1,"\\u0061":2}', '{"a":{"b":1,"b":2}}', " ".repeat(2 * 1024 * 1024 + 1)]) {
    expect(read(record(source), ["a"])).toBe("—");
  }
});

it("bounds previews of wide, deep, and long values", () => {
  const read = createLogColumnReader();
  for (const value of ["x".repeat(10000), Array.from({ length: 1000 }, (_, i) => i), { long: "x".repeat(10000) }]) {
    const text = read(record(JSON.stringify({ value })), ["value"]);
    expect(text.length).toBeLessThanOrEqual(256);
    expect(text).toContain("…");
  }
  const deep = JSON.parse(`${"[".repeat(40)}0${"]".repeat(40)}`);
  expect(read(record(JSON.stringify({ value: deep })), ["value"])).toContain("…");
  expect(read(record('{"value":{"a":[1,false,null]}}'), ["value"])).toBe('{"a":[1,false,null]}');
});

it("reads immutable record sources once even across paths and invalid JSON", () => {
  const read = createLogColumnReader();
  for (const source of ['{"a":1,"b":2}', "invalid"]) {
    let reads = 0;
    const row = record(null);
    Object.defineProperty(row, "fieldsJson", {
      get: () => {
        reads++;
        return source;
      },
    });
    read(row, ["a"]);
    read(row, ["b"]);
    read(row, ["a"]);
    expect(reads).toBe(1);
  }
});
