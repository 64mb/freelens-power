import { expect, it, vi } from "vitest";
import { createLogColumnSizer } from "./power-log-column-widths";

import type { LogRecord } from "../common/power-logs";

function record(message: string): LogRecord {
  return {
    timestamp: null,
    pod: "sample",
    podUid: "sample",
    container: "app",
    level: "info",
    message,
    fieldsJson: null,
  };
}

it("sizes short and long content independently and caps large values", () => {
  const size = createLogColumnSizer((row, path) => (path[0] === "a" ? "ok" : row.message));
  const [short, long] = size([record("x".repeat(20))], [["a"], ["b"]], 800, false);
  expect(short).toBeGreaterThanOrEqual(6);
  expect(long).toBeGreaterThan(short);
  expect(createLogColumnSizer((row) => row.message)([record("x".repeat(10000))], [["a"]], 800, false)).toEqual([25]);
});

it("uses the 90th percentile rather than letting rare outliers dominate", () => {
  const rows = Array.from({ length: 100 }, (_, index) => record(index < 90 ? "short" : "x".repeat(256)));
  const size = createLogColumnSizer((row) => row.message);
  expect(size(rows, [["a"]], 800, false)).toEqual(
    createLogColumnSizer((row) => row.message)([record("short")], [["a"]], 800, false),
  );
});

it("samples at most 200 evenly distributed records including both endpoints", () => {
  const rows = Array.from({ length: 10000 }, (_, index) => record(String(index)));
  const read = vi.fn((row: LogRecord) => row.message);
  createLogColumnSizer(read)(rows, [["a"]], 800, false);
  expect(read).toHaveBeenCalledTimes(200);
  expect(read.mock.calls[0][0]).toBe(rows[0]);
  expect(read.mock.calls[199][0]).toBe(rows[9999]);
  const positions = read.mock.calls.map(([row]) => rows.indexOf(row));
  expect(positions.every((position, index) => index === 0 || position - positions[index - 1] >= 50)).toBe(true);
});

it("keeps existing widths through live updates and resize while sizing new and readded fields", () => {
  const read = vi.fn((row: LogRecord) => row.message);
  const size = createLogColumnSizer(read);
  const initial = size([record("short")], [["a"]], 800, false)[0];
  expect(size([record("x".repeat(100))], [["a"], ["b"]], 1200, false)).toEqual([initial, 25]);
  expect(read).toHaveBeenCalledTimes(2);
  size([], [["b"]], 800, false);
  expect(size([record("x".repeat(100))], [["a"]], 800, false)).toEqual([25]);
});

it("caches exact typed paths separately and accepts equivalent path arrays", () => {
  const read = vi.fn((_row: LogRecord, path: readonly (string | number)[]) =>
    typeof path[0] === "number" ? "x".repeat(20) : "ok",
  );
  const size = createLogColumnSizer(read);
  const widths = size([record("")], [[0], ["0"]], 800, false);
  expect(widths[0]).toBeGreaterThan(widths[1]);
  expect(size([], [[0], ["0"]], 1600, false)).toEqual(widths);
  expect(read).toHaveBeenCalledTimes(2);
});

it("remeasures on compact changes and uses a safe fallback viewport", () => {
  const rows = [record("x".repeat(20))];
  const size = createLogColumnSizer((row) => row.message);
  const regular = size(rows, [["a"]], 800, false)[0];
  expect(size(rows, [["a"]], 800, true)[0]).toBeLessThan(regular);
  for (const viewport of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(createLogColumnSizer((row) => row.message)(rows, [["a"]], viewport, false)).toEqual([regular]);
  }
});

it("accounts for wide glyphs, tabs and the longest line without inflating Cyrillic", () => {
  const width = (value: string) => createLogColumnSizer(() => value)([record("")], [["a"]], 800, false)[0];
  expect(width("界".repeat(10))).toBe(width("x".repeat(20)));
  expect(width("😀".repeat(10))).toBe(width("x".repeat(20)));
  expect(width("я".repeat(20))).toBe(width("x".repeat(20)));
  expect(width("\t".repeat(5))).toBe(width("x".repeat(20)));
  expect(width(`${"x".repeat(20)}\n${"x".repeat(10)}`)).toBe(width("x".repeat(20)));
});

it("sizes empty records from readable headers and handles long or deep labels", () => {
  const size = createLogColumnSizer(() => "");
  expect(size([], [["long readable field name"]], 800, false)[0]).toBeGreaterThan(6);
  expect(size([], [["x".repeat(10000)], Array.from({ length: 10000 }, () => "a")], 800, false)).toEqual([25, 6]);
});

it("measures visible leaves rather than hidden ancestors", () => {
  const size = createLogColumnSizer(() => "");
  expect(size([], [["x".repeat(10000), "url"]], 800, false)[0]).toBeCloseTo(6.7);
});

it("updates header widths when duplicate leaves appear without rereading cached content", () => {
  const read = vi.fn(() => "ok");
  const size = createLogColumnSizer(read);
  const rows = [record("")];
  const first = ["long_request", "url"];
  expect(size(rows, [first], 800, false)[0]).toBeCloseTo(6.7);
  const qualified = size(rows, [first, ["response", "url"]], 800, false);
  expect(qualified[0]).toBeGreaterThan(6);
  expect(read).toHaveBeenCalledTimes(2);
  expect(size(rows, [first], 800, false)[0]).toBeCloseTo(6.7);
  expect(read).toHaveBeenCalledTimes(2);
});
