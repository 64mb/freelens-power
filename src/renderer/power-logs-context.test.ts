import { describe, expect, it } from "vitest";
import { withLogContext } from "./power-logs-context";

import type { LogRecord } from "../common/power-logs";

function record(message: string, source: Partial<LogRecord> = {}): LogRecord {
  return {
    timestamp: null,
    pod: "sample-pod",
    podUid: "sample-uid",
    container: "app",
    level: "info",
    message,
    fieldsJson: null,
    ...source,
  };
}

describe("withLogContext", () => {
  it("clips context at the beginning and end", () => {
    const records = Array.from({ length: 8 }, (_, index) => record(String(index)));
    expect(withLogContext(records, new Set([records[0]]), 3)).toEqual(records.slice(0, 4));
    expect(withLogContext(records, new Set([records[7]]), 3)).toEqual(records.slice(4));
  });

  it("unites overlapping windows in original order without mutating inputs", () => {
    const records = Object.freeze(Array.from({ length: 12 }, (_, index) => Object.freeze(record(String(index)))));
    const matches = new Set([records[6], records[3]]);
    const result = withLogContext(records, matches, 3);
    expect(result).toEqual(records.slice(0, 10));
    result.forEach((item, index) => expect(item).toBe(records[index]));
    expect([...matches]).toEqual([records[6], records[3]]);
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("returns matches only for invalid or zero radius %s", (radius) => {
    const records = [record("before"), record("match"), record("after")];
    expect(withLogContext(records, new Set([records[1]]), radius)).toEqual([records[1]]);
  });

  it("handles empty records, no matches, and matches absent from records", () => {
    const records = [record("line")];
    expect(withLogContext([], new Set(records), 5)).toEqual([]);
    expect(withLogContext(records, new Set(), 5)).toEqual([]);
    expect(withLogContext(records, new Set([record("line")]), 5)).toEqual([]);
  });

  it("counts neighbors independently for each pod uid, pod, container, and stream", () => {
    const sources: Partial<LogRecord>[] = [
      {},
      { podUid: "replacement-uid" },
      { pod: "other-pod" },
      { container: "sidecar" },
      { previous: true },
    ];
    const records = Array.from({ length: 5 }, (_, index) =>
      sources.map((source) => record(String(index), source)),
    ).flat();
    expect(withLogContext(records, new Set([records[10]]), 1)).toEqual([records[5], records[10], records[15]]);
    expect(withLogContext(records, new Set([records[14]]), 1)).toEqual([records[9], records[14], records[19]]);
  });

  it("treats an omitted previous flag as the current stream", () => {
    const records = [record("before", { previous: false }), record("match"), record("after", { previous: false })];
    expect(withLogContext(records, new Set([records[1]]), 1)).toEqual(records);
  });

  it.each([3, 5, 10])("selects the requested radius %s in a large interleaved collection", (radius) => {
    const records = Array.from({ length: 20000 }, (_, index) =>
      record(String(index), { container: `app-${index % 2}` }),
    );
    const matchIndex = 10000;
    const result = withLogContext(records, new Set([records[matchIndex]]), radius);
    expect(result).toHaveLength(radius * 2 + 1);
    result.forEach((item, index) => expect(item).toBe(records[matchIndex + (index - radius) * 2]));
  });
});
