import { describe, expect, it, vi } from "vitest";

vi.mock("@freelensapp/extensions", () => ({ Main: {} }));
vi.mock("electron", () => ({ BrowserWindow: {}, dialog: {}, ipcMain: {} }));
vi.mock("../common/store/logs-preferences-store", () => ({ LogsPreferencesStore: {} }));
vi.mock("./resource-search", () => ({ trustedSearchSender: vi.fn() }));
vi.mock("./power-logs-worker", () => ({ PowerLogsWorker: vi.fn() }));

import { validateLogRequest } from "./power-logs-ipc";

const partition = { clusterId: "cluster-example", contextId: "context-example" };
const record = {
  timestamp: null,
  pod: "example",
  podUid: "uid-example",
  container: "app",
  level: "info",
  message: "example",
  fieldsJson: null,
};
describe("log IPC validation", () => {
  it("projects target metadata and refuses missing immutable identity", () => {
    expect(
      validateLogRequest({
        ...partition,
        operation: "create",
        target: { kind: "Pod", namespace: "example", name: "example", uid: "uid-example", unsafe: "discard" },
      }),
    ).toEqual({
      ...partition,
      operation: "create",
      target: { kind: "Pod", namespace: "example", name: "example", uid: "uid-example" },
    });
    expect(() =>
      validateLogRequest({
        ...partition,
        operation: "create",
        target: { kind: "Pod", namespace: "example", name: "example" },
      }),
    ).toThrow();
  });
  it("projects log fields and rejects batches or individual records exceeding budgets", () => {
    expect(
      validateLogRequest({
        ...partition,
        operation: "append",
        captureId: "capture-example",
        records: [{ ...record, unsafe: "discard" }],
      }),
    ).toEqual({
      ...partition,
      operation: "append",
      captureId: "capture-example",
      records: [{ ...record, previous: false }],
    });
    for (const records of [
      Array(1001).fill(record),
      [{ ...record, message: "x".repeat(65536) }],
      [{ ...record, fieldsJson: "x".repeat(65536) }],
      [{ ...record, timestamp: NaN }],
      [{ ...record, level: "invalid" }],
      [{ ...record, previous: "true" }],
    ])
      expect(() =>
        validateLogRequest({ ...partition, operation: "append", captureId: "capture-example", records }),
      ).toThrow();
  });
  it("accepts only bounded main process transport permits", () => {
    expect(validateLogRequest({ ...partition, operation: "permit", lane: "start" })).toEqual({
      ...partition,
      operation: "permit",
      lane: "start",
    });
    expect(validateLogRequest({ ...partition, operation: "permit", lane: "bytes", bytes: 2048 })).toEqual({
      ...partition,
      operation: "permit",
      lane: "bytes",
      bytes: 2048,
    });
    for (const permit of [
      { lane: "unknown" },
      { lane: "start", bytes: 1 },
      { lane: "bytes" },
      { lane: "bytes", bytes: 0 },
      { lane: "bytes", bytes: 2097153 },
      { lane: "bytes", bytes: NaN },
    ])
      expect(() => validateLogRequest({ ...partition, operation: "permit", ...permit })).toThrow();
  });
  it("refuses paths and strips renderer supplied export destinations", () => {
    expect(() => validateLogRequest({ ...partition, operation: "delete", captureId: "../../private" })).toThrow();
    expect(
      validateLogRequest({
        ...partition,
        operation: "export",
        captureId: "capture-example",
        destination: "/tmp/unsafe",
      }),
    ).toEqual({ ...partition, operation: "export", captureId: "capture-example" });
    for (const value of [
      null,
      {},
      { ...partition, operation: "unknown" },
      { ...partition, operation: "query", captureId: "capture-example", queryId: "query", sql: "x".repeat(65537) },
    ])
      expect(() => validateLogRequest(value)).toThrow();
  });
});

it("accepts bounded SQL drafts including blank or invalid syntax and strips unrelated request fields", () => {
  for (const sql of ["", " \n\t", "SELECT '", "DROP TABLE logs", "x".repeat(65536)]) {
    expect(
      validateLogRequest({
        ...partition,
        operation: "save-sql",
        captureId: "capture-example",
        sql,
        queryId: "discard",
        destination: "discard",
      }),
    ).toEqual({
      ...partition,
      operation: "save-sql",
      captureId: "capture-example",
      sql,
    });
  }
  for (const sql of [undefined, null, 1, {}, "bad\0sql", "x".repeat(65537)]) {
    expect(() =>
      validateLogRequest({ ...partition, operation: "save-sql", captureId: "capture-example", sql }),
    ).toThrow("Invalid log request");
  }
  expect(() => validateLogRequest({ ...partition, operation: "save-sql", captureId: "../other", sql: "" })).toThrow();
  expect(() => validateLogRequest({ ...partition, operation: "save-sql", sql: "" })).toThrow();
});
