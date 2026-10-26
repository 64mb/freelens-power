import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AI_CHAT_CHANNEL, AI_PROGRESS_CHANNEL, AI_READ_ACTIVITY_CHANNEL } from "../common/ai";
import { AI_CANCEL_CHANNEL } from "../common/ai-extras";
import { startAiIpc } from "./ai-ipc";

const mocks = vi.hoisted(() => {
  const text = vi.fn().mockResolvedValue("ERROR EXAMPLE_KEY=example-sensitive");
  const json = vi.fn(() => {
    throw new Error("Plain log text must not be parsed as JSON");
  });
  const getResponse = vi.fn().mockResolvedValue({ ok: true, text, json });
  const get = vi.fn().mockResolvedValue({ items: [] });
  const factory = vi.fn(() => ({ getResponse, get }));
  const forCluster = new Proxy(
    {},
    {
      get(_target, property) {
        const value = Reflect.get(factory, property);
        return typeof value === "function" ? value.bind(factory) : value;
      },
    },
  );
  return {
    get,
    permit: vi.fn().mockResolvedValue(undefined),
    text,
    json,
    getResponse,
    factory,
    forCluster,
    handle: vi.fn(),
    removeHandler: vi.fn(),
    runAiChat: vi.fn(),
    getClusterById: vi.fn(() => ({ id: "example-cluster" })),
    stopReaction: vi.fn(),
    onEnabledChange: undefined as undefined | ((enabled: boolean) => void),
    preferences: {
      enabled: true,
      provider: "codex",
      claudeModel: "sonnet",
      model: "example-model",
      speed: "default",
      reasoningEffort: "low",
      systemPrompt: "",
      clusterPrompt: "",
    },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
  ipcMain: { handle: mocks.handle, removeHandler: mocks.removeHandler },
}));
vi.mock("mobx", () => ({
  reaction: (_read: unknown, onChange: (enabled: boolean) => void) => {
    mocks.onEnabledChange = onChange;
    return mocks.stopReaction;
  },
}));
vi.mock("@freelensapp/extensions", () => ({
  Common: { logger: { warn: vi.fn() } },
  Main: {
    Catalog: { getClusterById: mocks.getClusterById },
    K8sApi: { KubeJsonApi: { forCluster: mocks.forCluster } },
  },
}));
vi.mock("../common/store/ai-preferences-store", () => ({
  AiPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));
vi.mock("./ai", () => ({ runAiChat: mocks.runAiChat, aiFailureCode: () => "UNAVAILABLE" }));
vi.mock("./power-logs-budget", () => ({
  requestPowerLogPermit: mocks.permit,
  acquirePowerLogStream: vi.fn().mockResolvedValue(undefined),
  releasePowerLogStream: vi.fn(),
  renewPowerLogStream: vi.fn(),
}));

describe("AI IPC native logs compatibility", () => {
  it("does not start a log request if its sender is destroyed while acquiring a stream lease", async () => {
    vi.clearAllMocks();
    const sender = Object.assign(new EventEmitter(), { id: 73 });
    mocks.runAiChat.mockImplementation(async (_request, resolveCluster, signal) => {
      const read = resolveCluster("example-cluster").readLogs(
        {
          path: "/api/v1/namespaces/default/pods/example-pod/log",
          query: { tailLines: 100, limitBytes: 65536, follow: false, timestamps: false },
        },
        signal,
      );
      sender.emit("destroyed");
      await expect(read).rejects.toThrow("canceled");
      return { text: "Canceled" };
    });
    const stop = startAiIpc();
    try {
      const handler = mocks.handle.mock.calls[0][1];
      await expect(
        handler(
          { sender, senderFrame: { url: "https://renderer.freelens.app/" } },
          { messages: [{ role: "user", text: "Inspect counters" }], context: { clusterId: "example-cluster" } },
        ),
      ).rejects.toThrow("FREELENS_AI_");
      expect(mocks.getResponse).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it("invokes the non-callable host factory through call and reads response text in the selected cluster", async () => {
    vi.clearAllMocks();
    const query = {
      path: "/api/v1/namespaces/default/pods/example-pod/log",
      query: { tailLines: 100, limitBytes: 65536, follow: false, timestamps: false },
    };
    mocks.runAiChat.mockImplementation(async (_request, resolveCluster, signal) => {
      const connection = resolveCluster("example-cluster");
      const text = await connection.readLogs(query, signal);
      expect(text).toBe("ERROR EXAMPLE_KEY=example-sensitive");
      return { text: "One error", reads: [{ method: "logs", status: "ok" }] };
    });
    const stop = startAiIpc();
    try {
      expect(typeof mocks.forCluster).toBe("object");
      const [channel, handler] = mocks.handle.mock.calls[0];
      expect(channel).toBe(AI_CHAT_CHANNEL);
      const sender = Object.assign(new EventEmitter(), { id: 1 });
      const response = await handler(
        { sender, senderFrame: { url: "https://renderer.freelens.app/" } },
        {
          messages: [{ role: "user", text: "Inspect log counters" }],
          context: { clusterId: "example-cluster" },
        },
      );
      expect(mocks.getClusterById).toHaveBeenCalledExactlyOnceWith("example-cluster");
      expect(mocks.factory).toHaveBeenCalledExactlyOnceWith("example-cluster");
      expect(mocks.getResponse).toHaveBeenCalledExactlyOnceWith(
        query.path,
        { query: query.query },
        { signal: expect.any(AbortSignal), size: 65536 },
      );
      expect(mocks.text).toHaveBeenCalledOnce();
      expect(mocks.permit).toHaveBeenNthCalledWith(1, "example-cluster", undefined, expect.any(AbortSignal));
      expect(mocks.permit).toHaveBeenNthCalledWith(
        2,
        "example-cluster",
        Buffer.byteLength("ERROR EXAMPLE_KEY=example-sensitive"),
        expect.any(AbortSignal),
      );
      expect(mocks.json).not.toHaveBeenCalled();
      expect(response).toEqual({ text: "One error", reads: [{ method: "logs", status: "ok" }] });
      expect(JSON.stringify(response)).not.toContain("example-sensitive");
      expect(sender.listenerCount("destroyed")).toBe(0);
    } finally {
      stop();
    }
    expect(mocks.removeHandler).toHaveBeenCalledWith(AI_CHAT_CHANNEL);
    expect(mocks.removeHandler).toHaveBeenCalledWith(AI_CANCEL_CHANNEL);
  });
  it("sends request-scoped activity only to the originating frame and stops stale events", async () => {
    vi.clearAllMocks();
    const rootSend = vi.fn();
    const frameSend = vi.fn();
    const frame = { url: "https://renderer.freelens.app/", detached: false, send: frameSend };
    let progress: (event: { method: string; status: string }) => void = () => {};
    mocks.runAiChat.mockImplementation(async (_request, _resolve, _signal, onActivity) => {
      progress = onActivity;
      onActivity({ method: "pods", status: "reading" });
      frame.detached = true;
      onActivity({ method: "pods", status: "ok" });
      return { text: "Done" };
    });
    const stop = startAiIpc();
    try {
      const handler = mocks.handle.mock.calls[0][1];
      const sender = Object.assign(new EventEmitter(), { id: 3, send: rootSend });
      await handler({ sender, senderFrame: frame }, { requestId: "example-request", messages: [], context: {} });
      frame.detached = false;
      progress({ method: "logs", status: "reading" });
      expect(frameSend).toHaveBeenCalledExactlyOnceWith(AI_READ_ACTIVITY_CHANNEL, {
        requestId: "example-request",
        method: "pods",
        status: "reading",
      });
      expect(rootSend).not.toHaveBeenCalled();
      await expect(
        handler({ sender, senderFrame: frame }, { requestId: "invalid request", messages: [], context: {} }),
      ).rejects.toThrow("identifier");
      expect(mocks.runAiChat).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it("reads irregular discovered plurals through the pinned native GET API", async () => {
    vi.clearAllMocks();
    mocks.runAiChat.mockImplementation(async (_request, resolveCluster) => {
      const connection = resolveCluster("example-cluster");
      await connection.read({
        apiVersion: "example.com/v1",
        kind: "Widget",
        resource: "widgetrecords",
        namespace: "default",
      });
      return { text: "Done" };
    });
    const stop = startAiIpc();
    try {
      const handler = mocks.handle.mock.calls[0][1];
      await handler(
        {
          sender: Object.assign(new EventEmitter(), { id: 4 }),
          senderFrame: { url: "https://renderer.freelens.app/" },
        },
        { messages: [], context: { clusterId: "example-cluster" } },
      );
      expect(mocks.factory).toHaveBeenCalledExactlyOnceWith("example-cluster");
      expect(mocks.get).toHaveBeenCalledExactlyOnceWith(
        "/apis/example.com/v1/namespaces/default/widgetrecords",
        undefined,
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      stop();
    }
  });

  it("aborts an active request and rejects new requests when AI is disabled", async () => {
    vi.clearAllMocks();
    mocks.preferences.enabled = true;
    mocks.runAiChat.mockImplementation(
      (_request, _resolveCluster, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true }),
        ),
    );
    const stop = startAiIpc();
    try {
      const handler = mocks.handle.mock.calls[0][1];
      const event = {
        sender: Object.assign(new EventEmitter(), { id: 2 }),
        senderFrame: { url: "https://renderer.freelens.app/" },
      };
      const request = { context: { clusterId: "example-cluster" }, messages: [] };
      const pending = handler(event, request);
      const rejected = expect(pending).rejects.toThrow("FREELENS_AI_");
      mocks.preferences.enabled = false;
      mocks.onEnabledChange?.(false);
      await rejected;
      await expect(handler(event, request)).rejects.toThrow("disabled or unavailable");
      expect(mocks.runAiChat).toHaveBeenCalledOnce();
      expect(event.sender.listenerCount("destroyed")).toBe(0);
    } finally {
      stop();
      mocks.preferences.enabled = true;
    }
  });
});

it("uses the persisted provider and its settings instead of forged renderer settings", async () => {
  mocks.handle.mockClear();
  mocks.runAiChat.mockReset().mockResolvedValue({ text: "Ready" });
  mocks.preferences.provider = "claude";
  mocks.preferences.speed = "fast";
  const stop = startAiIpc();
  try {
    const handler = mocks.handle.mock.calls[0][1];
    await handler(
      { sender: Object.assign(new EventEmitter(), { id: 10 }), senderFrame: { url: "https://renderer.freelens.app/" } },
      { provider: "codex", model: "forged", reasoningEffort: "xhigh", speed: "default", messages: [], context: {} },
    );
    expect(mocks.runAiChat.mock.calls[0][0]).toMatchObject({
      provider: "claude",
      model: "sonnet",
      reasoningEffort: "",
      speed: "fast",
    });
  } finally {
    stop();
    mocks.preferences.provider = "codex";
    mocks.preferences.speed = "default";
  }
});

it("cancels only the matching request from its originating sender and frame and rejects late replies", async () => {
  vi.clearAllMocks();
  let finish!: (value: unknown) => void;
  let signal!: AbortSignal;
  mocks.runAiChat.mockImplementation((_request, _resolve, value) => {
    signal = value;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const stop = startAiIpc();
  try {
    const chat = mocks.handle.mock.calls.find(([channel]) => channel === AI_CHAT_CHANNEL)![1];
    const cancel = mocks.handle.mock.calls.find(([channel]) => channel === AI_CANCEL_CHANNEL)![1];
    const event = {
      sender: Object.assign(new EventEmitter(), { id: 40 }),
      senderFrame: { url: "https://renderer.freelens.app/" },
    };
    const pending = chat(event, { requestId: "active-request", messages: [], context: {} });
    const rejected = expect(pending).rejects.toThrow("FREELENS_AI_");
    expect(cancel({ ...event, sender: Object.assign(new EventEmitter(), { id: 41 }) }, "active-request")).toBe(false);
    expect(cancel({ ...event, senderFrame: { ...event.senderFrame } }, "active-request")).toBe(false);
    expect(cancel(event, "old-request")).toBe(false);
    expect(signal.aborted).toBe(false);
    expect(cancel(event, "active-request")).toBe(true);
    expect(signal.aborted).toBe(true);
    finish({ text: "Late answer" });
    await rejected;
    expect(cancel(event, "active-request")).toBe(false);
  } finally {
    stop();
  }
});

it("routes progress only to the active originating frame and forwards read cancellation", async () => {
  vi.clearAllMocks();
  const frame = { url: "https://renderer.freelens.app/", detached: false, send: vi.fn() };
  const event = { sender: Object.assign(new EventEmitter(), { id: 84 }), senderFrame: frame };
  let emit!: (value: unknown) => void;
  let finish!: (value: unknown) => void;
  mocks.runAiChat.mockImplementation(async (_request, resolve, _signal, _activity, progress) => {
    emit = progress;
    const readController = new AbortController();
    await resolve("example-cluster").read(
      { apiVersion: "v1", kind: "Pod", resource: "pods", namespace: "default" },
      readController.signal,
    );
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/namespaces/default/pods", undefined, {
      signal: readController.signal,
    });
    progress({ phase: "model", elapsedMs: 0, round: 0 });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const stop = startAiIpc();
  try {
    const chat = mocks.handle.mock.calls.find(([channel]) => channel === AI_CHAT_CHANNEL)![1];
    const cancel = mocks.handle.mock.calls.find(([channel]) => channel === AI_CANCEL_CHANNEL)![1];
    const pending = chat(event, { requestId: "progress-request", messages: [], context: {} });
    const rejected = expect(pending).rejects.toThrow("FREELENS_AI_");
    await vi.waitFor(() =>
      expect(frame.send).toHaveBeenCalledWith(AI_PROGRESS_CHANNEL, {
        requestId: "progress-request",
        phase: "model",
        elapsedMs: 0,
        round: 0,
      }),
    );
    frame.detached = true;
    emit({ phase: "answer", elapsedMs: 10, round: 0, text: "Hidden" });
    expect(frame.send).toHaveBeenCalledTimes(1);
    frame.detached = false;
    expect(cancel(event, "progress-request")).toBe(true);
    emit({ phase: "answer", elapsedMs: 20, round: 0, text: "Late" });
    expect(frame.send).toHaveBeenCalledTimes(1);
    finish({ text: "Late" });
    await rejected;
  } finally {
    stop();
  }
});
