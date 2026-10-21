import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MONITORING_HISTORY_CHANNEL } from "../common/monitoring-history";
import { startMonitoringHistory } from "./monitoring-history";

const state = vi.hoisted(() => ({
  preferences: { enabled: true, historyEnabled: true },
  handle: vi.fn(),
  removeHandler: vi.fn(),
  call: vi.fn(),
  close: vi.fn(),
  mkdir: vi.fn(),
  exists: vi.fn(),
  registered: vi.fn(),
  window: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/neutral-history-test" },
  BrowserWindow: { fromWebContents: state.window },
  ipcMain: { handle: state.handle, removeHandler: state.removeHandler },
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  mkdirSync: state.mkdir,
  existsSync: state.exists,
}));
vi.mock("@freelensapp/extensions", () => ({ Main: { Catalog: { getClusterById: state.registered } } }));
vi.mock("../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => state.preferences },
}));
vi.mock("./monitoring-history-worker", () => ({
  MonitoringHistoryWorker: class {
    call = state.call;
    close = state.close;
  },
}));
function event(url = "https://renderer.freelens.app/") {
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: frame, getURL: () => url } };
}
let dispose: (() => void) | undefined;
function start() {
  dispose = startMonitoringHistory({} as any);
  expect(state.handle).toHaveBeenCalledWith(MONITORING_HISTORY_CHANNEL, expect.any(Function));
  return state.handle.mock.calls[0][1] as (event: any, request: any) => Promise<any>;
}
const sample = () => ({
  clusterId: "cluster-id",
  scope: "pod",
  uid: "pod-uid",
  time: Date.now(),
  values: { cpu: 3, memory: 1024 },
});
beforeEach(() => {
  vi.clearAllMocks();
  state.preferences.enabled = true;
  state.preferences.historyEnabled = true;
  state.window.mockReturnValue({ isDestroyed: () => false });
  state.exists.mockReturnValue(false);
  state.registered.mockReturnValue({});
  state.call.mockResolvedValue({ bytes: 0, samples: 0 });
  state.close.mockImplementation(() => {});
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
});
describe("monitoring history IPC security", () => {
  it("accepts only live trusted root renderer frames with matching sender origins", async () => {
    const invoke = start();
    await expect(invoke(event(), { operation: "status" })).resolves.toEqual(
      expect.objectContaining({ available: true }),
    );
    await expect(
      invoke(event("https://cluster.renderer.freelens.app/"), { operation: "status" }),
    ).resolves.toBeDefined();
    const child = event();
    child.senderFrame = { url: child.senderFrame.url };
    const foreignSender = event();
    foreignSender.sender.getURL = () => "https://example.invalid/";
    for (const candidate of [
      child,
      foreignSender,
      event("https://renderer.freelens.app.example.invalid/"),
      event("http://renderer.freelens.app/"),
      event("file:///renderer.freelens.app"),
    ]) {
      state.call.mockClear();
      await expect(invoke(candidate, { operation: "status" })).rejects.toThrow("History unavailable");
      expect(state.call).not.toHaveBeenCalled();
    }
    state.window.mockReturnValue({ isDestroyed: () => true });
    await expect(invoke(event(), { operation: "status" })).rejects.toThrow("History unavailable");
    state.window.mockReturnValue(null);
    await expect(invoke(event(), { operation: "status" })).rejects.toThrow("History unavailable");
  });
  it("allows registered direct cluster frames while rejecting foreign and nested frames", async () => {
    const invoke = start();
    const root = event();
    const clusterFrame = {
      url: "https://cluster-id.renderer.freelens.app/",
      parent: root.sender.mainFrame,
      top: root.sender.mainFrame,
    };
    const child = { ...root, senderFrame: clusterFrame };
    await expect(invoke(child, { operation: "status" })).resolves.toEqual(expect.objectContaining({ available: true }));
    await expect(invoke(child, { operation: "append", samples: [sample()] })).resolves.toBe(true);
    await expect(
      invoke(child, { operation: "query", query: { ...sample(), from: Date.now() - 30_000, to: Date.now() } }),
    ).resolves.toBeDefined();
    for (const frame of [
      { ...clusterFrame, parent: {} },
      { ...clusterFrame, top: {} },
      { ...clusterFrame, url: "https://example.invalid/" },
      { ...clusterFrame, url: "https://cluster-id.renderer.freelens.app:8443/" },
      { ...clusterFrame, url: "https://nested.cluster-id.renderer.freelens.app/" },
    ])
      await expect(invoke({ ...root, senderFrame: frame }, { operation: "status" })).rejects.toThrow(
        "History unavailable",
      );
    const portRoot = event("https://renderer.freelens.app:54321/");
    await expect(invoke(portRoot, { operation: "status" })).resolves.toBeDefined();
    await expect(
      invoke(
        {
          ...portRoot,
          senderFrame: {
            url: "https://cluster-id.renderer.freelens.app:54321/",
            parent: portRoot.sender.mainFrame,
            top: portRoot.sender.mainFrame,
          },
        },
        { operation: "status" },
      ),
    ).resolves.toBeDefined();
    state.registered.mockReturnValue(undefined);
    await expect(invoke(child, { operation: "status" })).rejects.toThrow("History unavailable");
  });
  it("rejects unregistered clusters for writes and reads before worker access", async () => {
    const invoke = start();
    state.registered.mockReturnValue(undefined);
    await expect(invoke(event(), { operation: "append", samples: [sample()] })).rejects.toThrow("Unknown cluster");
    await expect(
      invoke(event(), { operation: "query", query: { ...sample(), from: Date.now() - 30_000, to: Date.now() } }),
    ).rejects.toThrow("Invalid history query");
    expect(state.call).not.toHaveBeenCalled();
  });
  it("blocks writes when either history consent or monitoring is disabled", async () => {
    const invoke = start();
    state.preferences.historyEnabled = false;
    await expect(invoke(event(), { operation: "append", samples: [sample()] })).resolves.toBe(false);
    await expect(invoke(event(), { operation: "query", query: {} })).resolves.toEqual([]);
    state.preferences.historyEnabled = true;
    state.preferences.enabled = false;
    await expect(invoke(event(), { operation: "append", samples: [sample()] })).resolves.toBe(false);
    expect(state.call).not.toHaveBeenCalled();
  });
  it("projects only numeric metrics and identities, rejecting invalid numbers and oversized batches", async () => {
    const invoke = start();
    const numeric = sample();
    await expect(
      invoke(event(), {
        operation: "append",
        samples: [
          {
            ...numeric,
            environment: { key: "private" },
            spec: { payload: "private" },
            values: { ...numeric.values, token: "private" },
          },
        ],
      }),
    ).resolves.toBe(true);
    expect(state.call).toHaveBeenLastCalledWith("append", [numeric]);
    state.call.mockClear();
    for (const samples of [
      [{ ...numeric, values: { cpu: Infinity } }],
      [{ ...numeric, values: { cpu: -1 } }],
      Array.from({ length: 513 }, () => numeric),
    ])
      await expect(invoke(event(), { operation: "append", samples })).rejects.toThrow();
    expect(state.call).not.toHaveBeenCalled();
  });
  it("closes pending worker operations and rejects retained handlers after disposal", async () => {
    const invoke = start();
    let rejectPending: (error: Error) => void = () => {};
    state.call.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPending = reject;
        }),
    );
    state.close.mockImplementation(() => rejectPending(new Error("History closed")));
    const result = expect(invoke(event(), { operation: "append", samples: [sample()] })).rejects.toThrow(
      "History closed",
    );
    dispose?.();
    dispose = undefined;
    await result;
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.removeHandler).toHaveBeenCalledWith(MONITORING_HISTORY_CHANNEL);
    await expect(invoke(event(), { operation: "clear" })).rejects.toThrow("History unavailable");
  });
});
