import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>(),
  handler: undefined as ((event: unknown, input: unknown) => Promise<unknown>) | undefined,
  preferenceChanged: undefined as ((value: { enabled: boolean; limits?: unknown }) => void) | undefined,
  preferences: { enabled: true },
  trusted: vi.fn(),
  call: vi.fn(),
  close: vi.fn(),
  showSaveDialog: vi.fn(),
  read: vi.fn(),
}));
vi.mock("node:fs", () => ({ readFileSync: mocks.read }));
vi.mock("@freelensapp/extensions", () => ({
  Main: { Catalog: { getClusterById: () => ({ contextName: "example", kubeConfigPath: "example-config" }) } },
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  ipcMain: {
    handle: (_channel: string, handler: typeof mocks.handler) => {
      mocks.handler = handler;
      if (handler) mocks.handlers.set(_channel, handler);
    },
    removeHandler: vi.fn(),
  },
}));
vi.mock("mobx", () => ({
  reaction: (_read: unknown, changed: typeof mocks.preferenceChanged) => {
    mocks.preferenceChanged = changed;
    return () => {};
  },
}));
vi.mock("../common/store/logs-preferences-store", () => ({
  LogsPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));
vi.mock("./resource-search", () => ({ trustedSearchSender: mocks.trusted }));
vi.mock("./power-logs-worker", () => ({
  sweepPowerLogsStorage: vi.fn(),
  PowerLogsWorker: class {
    call = mocks.call;
    close = mocks.close;
    isClosed = false;
  },
}));

import { startPowerLogs } from "./power-logs-ipc";

const partition = { clusterId: "cluster-example", contextId: "context-example" };
function invoke(input: unknown) {
  return mocks.handler!({ sender: {} }, input);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.preferences.enabled = true;
  mocks.trusted.mockReturnValue(true);
  mocks.read.mockReturnValue(Buffer.from("example configuration"));
  mocks.call.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
});
describe("trusted log IPC lifecycle", () => {
  it("binds stream renewal and closure to the acquiring renderer frame", async () => {
    const stop = startPowerLogs();
    const first = { sender: { id: 1 }, senderFrame: { processId: 1, routingId: 1 } };
    const other = { sender: { id: 1 }, senderFrame: { processId: 1, routingId: 2 } };
    const streamId = "stream-example";
    try {
      await expect(
        mocks.handler!(first, { ...partition, operation: "stream-open", streamId, follow: false }),
      ).resolves.toBe(true);
      await expect(mocks.handler!(other, { ...partition, operation: "stream-close", streamId })).rejects.toThrow(
        "unavailable",
      );
      await expect(mocks.handler!(other, { ...partition, operation: "stream-renew", streamId })).rejects.toThrow(
        "unavailable",
      );
      await expect(mocks.handler!(first, { ...partition, operation: "stream-renew", streamId })).resolves.toBe(true);
      await expect(mocks.handler!(first, { ...partition, operation: "stream-close", streamId })).resolves.toBe(true);
      expect(mocks.call).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it("shares permit waits across requests and cancels them on disable", async () => {
    vi.useFakeTimers();
    const stop = startPowerLogs();
    try {
      await invoke({ ...partition, operation: "permit", lane: "start" });
      let ready = false;
      const pending = invoke({ ...partition, operation: "permit", lane: "start" }).then(() => {
        ready = true;
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(ready).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      const disabled = expect(
        invoke({ ...partition, operation: "permit", lane: "bytes", bytes: 1024 * 1024 }),
      ).resolves.toBe(true);
      await disabled;
      const canceled = expect(
        invoke({ ...partition, operation: "permit", lane: "bytes", bytes: 1024 }),
      ).rejects.toThrow("unavailable");
      mocks.preferences.enabled = false;
      mocks.preferenceChanged!({ enabled: false });
      await canceled;
      expect(mocks.call).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it("revalidates context after waiting for a permit", async () => {
    vi.useFakeTimers();
    const stop = startPowerLogs();
    try {
      await invoke({ ...partition, operation: "permit", lane: "start" });
      const changed = expect(invoke({ ...partition, operation: "permit", lane: "start" })).rejects.toThrow(
        "unavailable",
      );
      mocks.read.mockReturnValue(Buffer.from("updated configuration"));
      await vi.advanceTimersByTimeAsync(500);
      await changed;
    } finally {
      stop();
    }
  });
  it("refuses untrusted origins and disabled settings before starting storage", async () => {
    const stop = startPowerLogs();
    try {
      mocks.trusted.mockReturnValue(false);
      await expect(invoke({ ...partition, operation: "list" })).rejects.toThrow("unavailable");
      mocks.trusted.mockReturnValue(true);
      mocks.preferences.enabled = false;
      await expect(invoke({ ...partition, operation: "list" })).rejects.toThrow("unavailable");
      expect(mocks.call).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it("rejects results if the cluster configuration changes during a request", async () => {
    const stop = startPowerLogs();
    let resolve!: (value: unknown) => void;
    mocks.call.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    try {
      const pending = invoke({ ...partition, operation: "list" });
      mocks.read.mockReturnValue(Buffer.from("updated configuration"));
      resolve([]);
      await expect(pending).rejects.toThrow("unavailable");
    } finally {
      stop();
    }
  });
  it("rechecks settings after the export dialog and purges the active worker on disable", async () => {
    const stop = startPowerLogs();
    try {
      await invoke({ ...partition, operation: "list" });
      let resolve!: (value: unknown) => void;
      mocks.showSaveDialog.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const pending = invoke({ ...partition, operation: "export", captureId: "capture-example" });
      mocks.preferences.enabled = false;
      mocks.preferenceChanged!({ enabled: false });
      resolve({ canceled: false, filePath: "selected-export.ndjson" });
      await expect(pending).rejects.toThrow("unavailable");
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(mocks.call).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });
});

it("applies enabled and trusted-renderer guards to SQL draft storage without using query execution", async () => {
  const stop = startPowerLogs();
  const request = { ...partition, operation: "save-sql", captureId: "capture-example", sql: "SELECT '" };
  try {
    mocks.preferences.enabled = false;
    await expect(invoke(request)).rejects.toThrow("unavailable");
    mocks.preferences.enabled = true;
    mocks.trusted.mockReturnValue(false);
    await expect(invoke(request)).rejects.toThrow("unavailable");
    expect(mocks.call).not.toHaveBeenCalled();
    mocks.trusted.mockReturnValue(true);
    mocks.call.mockResolvedValue({ id: "capture-example", lastSql: request.sql });
    await expect(invoke(request)).resolves.toEqual({ id: "capture-example", lastSql: request.sql });
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith({ ...request, contextId: expect.any(String) }, undefined);
  } finally {
    stop();
  }
  await expect(invoke(request)).rejects.toThrow("unavailable");
  expect(mocks.call).toHaveBeenCalledTimes(1);
});

it("restricts global storage operations to the trusted settings main frame and enabled extension", async () => {
  const stop = startPowerLogs();
  const frame = { url: "https://renderer.freelens.app/preferences" };
  const sender = { mainFrame: frame, getURL: () => frame.url };
  const event = { sender, senderFrame: frame };
  const handler = mocks.handlers.get("freelens-power:logs-storage")!;
  try {
    for (const untrusted of [
      { sender, senderFrame: { ...frame } },
      { sender: { ...sender, getURL: () => "https://example.invalid/" }, senderFrame: frame },
      (() => {
        const other = { url: "https://cluster-example.renderer.freelens.app/" };
        return {
          sender: { mainFrame: other, getURL: () => other.url },
          senderFrame: other,
        };
      })(),
    ])
      await expect(handler(untrusted, { operation: "clear" })).rejects.toThrow("unavailable");
    expect(mocks.call).not.toHaveBeenCalled();
    await expect(handler(event, { operation: "query" })).rejects.toThrow("unavailable");
    await handler(event, { operation: "status" });
    expect(mocks.call).toHaveBeenLastCalledWith({
      clusterId: "settings",
      contextId: "settings",
      operation: "storage-status",
    });
    await handler(event, { operation: "clear" });
    expect(mocks.call).toHaveBeenLastCalledWith({
      clusterId: "settings",
      contextId: "settings",
      operation: "clear-storage",
    });
    mocks.preferences.enabled = false;
    await expect(handler(event, { operation: "clear" })).rejects.toThrow("unavailable");
    mocks.preferences.enabled = true;
    stop();
    await expect(handler(event, { operation: "clear" })).rejects.toThrow("unavailable");
  } finally {
    stop();
  }
});
