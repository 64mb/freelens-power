import { beforeEach, expect, it, vi } from "vitest";

import type { LogRequest } from "../common/power-logs";

type Message = { data: { id: number; request: LogRequest } };
const mocks = vi.hoisted(() => ({
  listener: undefined as ((message: Message) => void) | undefined,
  run: vi.fn(),
  post: vi.fn(),
}));
vi.mock("./power-logs-database", () => ({
  PowerLogsDatabase: class {
    run = mocks.run;
  },
}));
beforeEach(() => {
  vi.resetModules();
  mocks.run.mockReset();
  mocks.post.mockReset();
  mocks.listener = undefined;
});
it("cancels a query queued behind an import without running it or releasing unbounded queue capacity", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "parentPort");
  const port = {
    on: (_event: string, listener: (message: Message) => void) => {
      mocks.listener = listener;
    },
    postMessage: mocks.post,
  };
  Object.defineProperty(process, "parentPort", { configurable: true, value: port });
  let finish!: (value: unknown) => void;
  const blocked = new Promise((resolve) => {
    finish = resolve;
  });
  mocks.run.mockImplementation((request: LogRequest) =>
    request.operation === "finish" ? blocked : Promise.resolve(true),
  );
  const partition = { clusterId: "cluster-example", contextId: "context-example" };
  const send = (id: number, request: LogRequest) => mocks.listener!({ data: { id, request } });
  try {
    await import("./power-logs-child");
    send(1, { ...partition, operation: "finish", captureId: "capture-example", partial: false, notes: [] });
    await Promise.resolve();
    send(2, {
      ...partition,
      operation: "query",
      captureId: "capture-example",
      queryId: "queued-query",
      sql: "SELECT 42",
    });
    send(4, {
      ...partition,
      operation: "query",
      captureId: "capture-example",
      queryId: "distinct-queued-query",
      sql: "SELECT 99",
    });
    expect(mocks.post).toHaveBeenCalledWith({ id: 4, error: "Log query is busy" });
    send(3, { ...partition, operation: "cancel", queryId: "queued-query" });
    expect(mocks.post).toHaveBeenCalledWith({ id: 2, error: "Log query canceled" });
    expect(mocks.post).toHaveBeenCalledWith({ id: 3, result: true });
    for (let i = 0; i < 14; i++) send(10 + i, { ...partition, operation: "list" });
    send(100, { ...partition, operation: "list" });
    expect(mocks.post).toHaveBeenCalledWith({ id: 100, error: "Log operation queue is full" });
    finish(true);
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith({ id: 23, result: true }));
    expect(mocks.run.mock.calls.some(([request]) => request.operation === "query")).toBe(false);
    expect(mocks.post.mock.calls.filter(([message]) => message.id === 2)).toHaveLength(1);
  } finally {
    finish(true);
    if (descriptor) Object.defineProperty(process, "parentPort", descriptor);
    else Reflect.deleteProperty(process, "parentPort");
  }
});

it("rejects another distinct SQL query while one is active and accepts a query after completion", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", {
    configurable: true,
    value: {
      on: (_event: string, listener: (message: Message) => void) => {
        mocks.listener = listener;
      },
      postMessage: mocks.post,
    },
  });
  let finish!: (value: unknown) => void;
  const blocked = new Promise((resolve) => {
    finish = resolve;
  });
  mocks.run.mockImplementation((request: LogRequest) =>
    request.operation === "query" ? blocked : Promise.resolve(true),
  );
  const partition = { clusterId: "cluster-example", contextId: "context-example" };
  const query = (id: number, queryId: string) =>
    mocks.listener!({
      data: {
        id,
        request: { ...partition, operation: "query", captureId: "capture-example", queryId, sql: "SELECT 42" },
      },
    });
  try {
    await import("./power-logs-child");
    query(1, "active-query");
    await Promise.resolve();
    expect(mocks.run).toHaveBeenCalledOnce();
    query(2, "different-query");
    expect(mocks.post).toHaveBeenCalledWith({ id: 2, error: "Log query is busy" });
    expect(mocks.run).toHaveBeenCalledOnce();
    mocks.listener!({ data: { id: 3, request: { ...partition, operation: "cancel", queryId: "active-query" } } });
    expect(mocks.run).toHaveBeenCalledWith({ ...partition, operation: "cancel", queryId: "active-query" });
    finish(true);
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith({ id: 1, result: true }));
    query(4, "next-query");
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith({ id: 4, result: true }));
  } finally {
    finish(true);
    if (descriptor) Object.defineProperty(process, "parentPort", descriptor);
    else Reflect.deleteProperty(process, "parentPort");
  }
});
