import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { observable, runInAction } from "mobx";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  remove: vi.fn(),
  trusted: vi.fn(() => true),
  cluster: vi.fn(),
  response: vi.fn(),
  exec: vi.fn(),
  readOnly: { enabled: false },
  config: "neutral-config",
  power: { enabled: true },
  helm: { enabled: true },
}));
vi.mock("@freelensapp/extensions", () => ({
  Main: {
    Catalog: { getClusterById: mocks.cluster },
    K8sApi: { KubeJsonApi: { forCluster: () => ({ getResponse: mocks.response }) } },
  },
}));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle, removeHandler: mocks.remove } }));
vi.mock("node:fs", () => ({ readFileSync: () => Buffer.from(mocks.config) }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("./resource-search", () => ({ trustedSearchSender: mocks.trusted }));
vi.mock("../common/store/helm-preferences-store", () => ({
  HelmPreferencesStore: { getInstanceOrCreate: () => mocks.helm },
}));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => mocks.power },
}));
vi.mock("../common/store/read-only-preferences-store", () => ({
  ReadOnlyPreferencesStore: { getInstanceOrCreate: () => mocks.readOnly },
}));

import { executeHelmRead, executeHelmRollback, startPowerHelm, validateHelmRequest } from "./helm-ipc";
import * as helmValues from "./helm-values";

const request = { requestId: "request", clusterId: "cluster", namespace: "default", operation: "list" };
function event(processId = 1, routingId = 1, sender = Object.assign(new EventEmitter(), { id: 1 })) {
  return { sender, senderFrame: { processId, routingId } };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.trusted.mockReturnValue(true);
  mocks.readOnly.enabled = false;
  mocks.power.enabled = true;
  mocks.helm = observable({ enabled: true });
  mocks.config = "neutral-config";
  mocks.cluster.mockReturnValue({ contextName: "neutral", kubeConfigPath: "/neutral/config" });
});
describe("Helm IPC", () => {
  it("rejects untrusted senders before accessing the cluster", async () => {
    const stop = startPowerHelm();
    mocks.trusted.mockReturnValue(false);
    const result = await mocks.handle.mock.calls[0][1](event(), request);
    expect(result.ok).toBe(false);
    expect(mocks.cluster).not.toHaveBeenCalled();
    stop();
  });
  it("rejects untrusted values requests before parsing YAML", async () => {
    const validate = vi.spyOn(helmValues, "validateHelmValues");
    const stop = startPowerHelm();
    try {
      mocks.trusted.mockReturnValue(false);
      expect(
        await mocks.handle.mock.calls[0][1](event(), {
          ...request,
          operation: "upgrade-values",
          uid: "release-one",
          name: "example",
          revision: 1,
          values: "a: [invalid",
          chart: "stable/example",
          confirmed: true,
        }),
      ).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(validate).not.toHaveBeenCalled();
    } finally {
      stop();
      validate.mockRestore();
    }
  });
  it("rejects requests while Helm is disabled before accessing the cluster", async () => {
    const stop = startPowerHelm();
    runInAction(() => {
      mocks.helm.enabled = false;
    });
    const result = await mocks.handle.mock.calls[0][1](event(), request);
    expect(result.ok).toBe(false);
    expect(mocks.cluster).not.toHaveBeenCalled();
    expect(mocks.response).not.toHaveBeenCalled();
    stop();
  });
  it("aborts active requests when Helm is disabled", async () => {
    const stop = startPowerHelm();
    let pendingSignal!: AbortSignal;
    mocks.response.mockImplementation(
      (_path, _query, init) =>
        new Promise((_resolve, reject) => {
          pendingSignal = init.signal;
          pendingSignal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = mocks.handle.mock.calls[0][1](event(), request);
    await vi.waitFor(() => expect(pendingSignal).toBeDefined());
    runInAction(() => {
      mocks.helm.enabled = false;
    });
    expect(pendingSignal.aborted).toBe(true);
    expect(await pending).toMatchObject({ ok: false });
    stop();
  });
  it("scopes cancellation to the calling frame", async () => {
    const stop = startPowerHelm();
    const invoke = mocks.handle.mock.calls[0][1];
    let pendingSignal!: AbortSignal;
    mocks.response.mockImplementation(
      (_path, _query, init) =>
        new Promise((_resolve, reject) => {
          pendingSignal = init.signal;
          pendingSignal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const sender = Object.assign(new EventEmitter(), { id: 1 });
    const pending = invoke(event(1, 1, sender), request);
    await vi.waitFor(() => expect(pendingSignal).toBeDefined());
    await invoke(event(1, 2, sender), { ...request, operation: "cancel" });
    expect(pendingSignal.aborted).toBe(false);
    await invoke(event(1, 1, sender), { ...request, operation: "cancel" });
    expect(pendingSignal.aborted).toBe(true);
    await pending;
    stop();
  });
  it("opens details with exactly one selected Secret read and no metadata relist", async () => {
    const stop = startPowerHelm();
    const invoke = mocks.handle.mock.calls[0][1];
    const metadata = {
      metadata: {
        uid: "release-one",
        name: "sh.helm.release.v1.example.v1",
        namespace: "default",
        labels: { owner: "helm", name: "example", version: "1", status: "deployed" },
      },
    };
    const response = (body: unknown) => ({ ok: true, headers: new Map(), body: Readable.from([JSON.stringify(body)]) });
    const release = {
      name: "example",
      namespace: "default",
      version: 1,
      info: { status: "deployed" },
      config: { replicas: 2 },
    };
    mocks.response
      .mockResolvedValueOnce(
        response({ kind: "PartialObjectMetadataList", apiVersion: "meta.k8s.io/v1", items: [metadata] }),
      )
      .mockResolvedValueOnce(
        response({
          ...metadata,
          type: "helm.sh/release.v1",
          data: {
            release: Buffer.from(gzipSync(Buffer.from(JSON.stringify(release))).toString("base64")).toString("base64"),
          },
        }),
      );
    expect((await invoke(event(), request)).ok).toBe(true);
    const details = await invoke(event(), {
      ...request,
      requestId: "detail",
      operation: "details",
      name: "example",
      revision: 1,
      section: "values",
    });
    expect(details).toMatchObject({ ok: true, detail: { content: "replicas: 2\n" } });
    expect(mocks.response).toHaveBeenCalledTimes(2);
    expect(mocks.response.mock.calls[1][0]).toBe("/api/v1/namespaces/default/secrets/sh.helm.release.v1.example.v1");
    await invoke(event(), {
      ...request,
      requestId: "cached-detail",
      operation: "details",
      name: "example",
      revision: 1,
      section: "values",
    });
    expect(mocks.response).toHaveBeenCalledTimes(2);
    mocks.response.mockResolvedValueOnce(
      response({
        ...metadata,
        type: "helm.sh/release.v1",
        data: {
          release: Buffer.from(
            gzipSync(Buffer.from(JSON.stringify({ ...release, config: { replicas: 3 } }))).toString("base64"),
          ).toString("base64"),
        },
      }),
    );
    const refreshed = await invoke(event(), {
      ...request,
      requestId: "refresh-detail",
      operation: "details",
      name: "example",
      revision: 1,
      section: "values",
      refresh: true,
    });
    expect(refreshed).toMatchObject({ ok: true, detail: { content: "replicas: 3\n" } });
    expect(mocks.response).toHaveBeenCalledTimes(3);
    expect(mocks.response.mock.calls[2][0]).toBe("/api/v1/namespaces/default/secrets/sh.helm.release.v1.example.v1");
    stop();
  });
  it("loads app versions without relisting and leaves an API permit for foreground details", async () => {
    const stop = startPowerHelm();
    const invoke = mocks.handle.mock.calls[0][1];
    mocks.response.mockImplementation(async () => ({
      ok: true,
      headers: new Map(),
      body: Readable.from([
        JSON.stringify({ kind: "PartialObjectMetadataList", apiVersion: "meta.k8s.io/v1", items: [] }),
      ]),
    }));
    const listed = await invoke(event(), request);
    mocks.response.mockClear();
    const response = (revision: number) => {
      const release = {
        name: "example",
        namespace: "default",
        version: revision,
        chart: { metadata: { name: "example", version: "1.0.0", appVersion: `2.0.${revision}` } },
      };
      const secret = {
        metadata: {
          name: `sh.helm.release.v1.example.v${revision}`,
          namespace: "default",
          labels: { owner: "helm", name: "example", version: String(revision), status: "deployed" },
        },
        type: "helm.sh/release.v1",
        data: {
          release: Buffer.from(gzipSync(Buffer.from(JSON.stringify(release))).toString("base64")).toString("base64"),
        },
      };
      return { ok: true, headers: new Map(), body: Readable.from([JSON.stringify(secret)]) };
    };
    let releaseFirst!: () => void;
    mocks.response.mockImplementation((path) => {
      const revision = Number(/v(\d+)$/.exec(path)![1]);
      if (revision === 1)
        return new Promise((resolve) => {
          releaseFirst = () => resolve(response(1));
        });
      return Promise.resolve(response(revision));
    });
    try {
      const base = { ...request, contextId: listed.contextId, name: "example" };
      mocks.readOnly.enabled = true;
      const first = invoke(event(), { ...base, requestId: "version-one", operation: "app-version", revision: 1 });
      await vi.waitFor(() => expect(releaseFirst).toBeDefined());
      const second = invoke(event(), { ...base, requestId: "version-two", operation: "app-version", revision: 2 });
      expect(
        await invoke(event(), {
          ...base,
          requestId: "foreground",
          operation: "details",
          revision: 3,
          section: "overview",
        }),
      ).toMatchObject({ ok: true });
      expect(mocks.response).toHaveBeenCalledTimes(2);
      releaseFirst();
      expect(await first).toMatchObject({ ok: true, appVersion: "2.0.1", chartVersion: "1.0.0" });
      expect(await second).toMatchObject({ ok: true, appVersion: "2.0.2" });
      expect(mocks.response).toHaveBeenCalledTimes(3);
      expect(
        await invoke(event(), { ...base, requestId: "cached-version", operation: "app-version", revision: 1 }),
      ).toMatchObject({ ok: true, appVersion: "2.0.1" });
      expect(mocks.response).toHaveBeenCalledTimes(3);
      expect(mocks.response.mock.calls.every((call) => /\/secrets\/sh\.helm\.release/.test(call[0]))).toBe(true);
      expect(mocks.exec).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it.each([
    "cancel",
    "did-start-navigation",
    "destroyed",
    "shutdown",
  ])("keeps rollback preflight and logs after %s", async (action) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10);
    const stop = startPowerHelm();
    const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", { value: "/neutral/resources", configurable: true });
    const invoke = mocks.handle.mock.calls[0][1];
    const sender = Object.assign(new EventEmitter(), { id: 1 });
    const source = event(1, 1, sender);
    const context = await invoke(source, { ...request, operation: "operations", namespace: "" });
    let releaseRead!: () => void;
    let readSignal!: AbortSignal;
    const response = () => ({
      ok: true,
      headers: new Map(),
      body: Readable.from([
        JSON.stringify({
          kind: "PartialObjectMetadataList",
          apiVersion: "meta.k8s.io/v1",
          items: [
            {
              metadata: {
                uid: "release-one",
                name: "sh.helm.release.v1.example.v1",
                namespace: "default",
                labels: { owner: "helm", name: "example", version: "1", status: "deployed" },
              },
            },
          ],
        }),
      ]),
    });
    mocks.response
      .mockImplementationOnce((_path, _query, init) => {
        readSignal = init.signal;
        return new Promise((resolve) => {
          releaseRead = () => resolve(response());
        });
      })
      .mockImplementation(async () => response());
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const kill = vi.fn();
    let finish!: (error: Error | null, stdout?: string, stderr?: string) => void;
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
      finish = callback;
      return { kill, stdout, stderr };
    });
    try {
      const rollback = {
        ...request,
        operation: "rollback",
        requestId: "background-rollback",
        contextId: context.contextId,
        name: "example",
        revision: 1,
        uid: "release-one",
        confirmed: true,
      };
      const pending = invoke(source, rollback);
      await vi.waitFor(() => expect(releaseRead).toBeDefined());
      if (action === "cancel") await invoke(source, { ...request, requestId: rollback.requestId, operation: "cancel" });
      else if (action !== "shutdown") sender.emit(action);
      expect(readSignal.aborted).toBe(false);
      const early = await invoke(event(), { ...request, operation: "operations" });
      expect(early.operations).toMatchObject([
        {
          requestId: rollback.requestId,
          status: "running",
          phase: "preparing",
          stages: { preparing: { startedAt: 10 } },
        },
      ]);
      for (const operation of ["rollback", "uninstall", "upgrade-values"]) {
        expect(
          await invoke(event(), {
            ...rollback,
            operation,
            requestId: `conflict-${operation}`,
            values: "replicas: 1",
            chart: "stable/example",
          }),
        ).toMatchObject({ ok: false, error: { code: "operation-running" } });
      }
      releaseRead();
      await vi.waitFor(() => expect(finish).toBeDefined());
      expect(mocks.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(["--debug", "--wait", "--timeout", "5m", "--history-max", "0"]),
      );
      expect(mocks.exec.mock.calls[0][2].timeout).toBe(330_000);
      mocks.trusted.mockReturnValue(false);
      expect(await invoke(event(), { ...request, operation: "operations" })).toMatchObject({ ok: false });
      clock.mockReturnValue(20);
      if (action !== "cancel") stderr.emit("data", "[debug] performing rollback with private-value\n");
      clock.mockReturnValue(30);
      stderr.emit("data", "[debug] preparing rollback\n");
      clock.mockReturnValue(40);
      for (let i = 0; i < 120; i++) {
        stdout.emit(
          "data",
          "[debug] waiting for resources private-value\n[debug] Patch Secret in namespace private-value\n",
        );
      }
      clock.mockReturnValue(50);
      stderr.emit("data", "[debug] waiting for resources\n");
      clock.mockReturnValue(60);
      stderr.emit("data", "[debug] performing rollback\n[debug] preparing rollback\n");
      stderr.emit("data", "apiVersion: v1\ndata: private-value\nhttps://private.invalid\n");
      mocks.trusted.mockReturnValue(true);
      const running = await invoke(event(), { ...request, operation: "operations" });
      expect(running.operations[0].phase).toBe("waiting");
      const expectedStages = {
        preparing: { startedAt: 10, finishedAt: action === "cancel" ? 40 : 20 },
        ...(action === "cancel" ? {} : { applying: { startedAt: 20, finishedAt: 40 } }),
        waiting: { startedAt: 40 },
      };
      expect(running.operations[0].stages).toEqual(expectedStages);
      expect(early.operations[0].stages).toEqual({ preparing: { startedAt: 10 } });
      running.operations[0].stages.waiting.startedAt = 999;
      expect(
        (await invoke(event(), { ...request, operation: "operations" })).operations[0].stages.waiting.startedAt,
      ).toBe(40);
      clock.mockReturnValue(90);
      expect(running.operations[0].logs).toHaveLength(100);
      expect(JSON.stringify(running)).not.toContain("private");
      if (action === "shutdown") {
        stop();
        expect(kill).toHaveBeenCalledWith("SIGKILL");
        finish(new Error("stopped"));
        expect(await pending).toMatchObject({
          ok: false,
          error: { code: "rollback-unknown" },
          operations: [{ stages: { ...expectedStages, waiting: { startedAt: 40, finishedAt: 90 } } }],
        });
        return;
      }
      finish(null);
      mocks.trusted.mockReturnValue(false);
      expect(await pending).toMatchObject({
        ok: true,
        operations: [{ stages: { ...expectedStages, waiting: { startedAt: 40, finishedAt: 90 } } }],
      });
      expect(kill).not.toHaveBeenCalled();
      mocks.trusted.mockReturnValue(true);
      clock.mockReturnValue(120);
      const completed = await invoke(event(), { ...request, operation: "operations" });
      expect(completed.operations[0]).toMatchObject({
        status: "succeeded",
        phase: "completed",
        finishedAt: 90,
        stages: { ...expectedStages, waiting: { startedAt: 40, finishedAt: 90 } },
      });
      const otherCluster = await invoke(event(), { ...request, clusterId: "other-cluster", operation: "operations" });
      expect(otherCluster.operations).toEqual([]);
      mocks.config = "different-context";
      expect((await invoke(event(), { ...request, operation: "operations" })).operations).toEqual([]);
    } finally {
      stop();
      clock.mockRestore();
      if (resources) Object.defineProperty(process, "resourcesPath", resources);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  });
  it("retains the most recently finished rollback after many newer requests finish first", async () => {
    const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", { value: "/neutral/resources", configurable: true });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1);
    const stop = startPowerHelm();
    const invoke = mocks.handle.mock.calls[0][1];
    mocks.response.mockImplementation(async () => ({
      ok: true,
      headers: new Map(),
      body: Readable.from([
        JSON.stringify({
          kind: "PartialObjectMetadataList",
          apiVersion: "meta.k8s.io/v1",
          items: [
            {
              metadata: {
                uid: "release-one",
                name: "sh.helm.release.v1.example.v1",
                namespace: "default",
                labels: { owner: "helm", name: "example", version: "1", status: "deployed" },
              },
            },
          ],
        }),
      ]),
    }));
    let finish!: (error: Error | null) => void;
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
      finish = callback;
      return { kill: vi.fn() };
    });
    try {
      const context = await invoke(event(), { ...request, operation: "operations" });
      const rollback = {
        ...request,
        contextId: context.contextId,
        operation: "rollback",
        name: "example",
        revision: 1,
        uid: "release-one",
        confirmed: true,
      };
      const first = invoke(event(), { ...rollback, requestId: "long-running" });
      await vi.waitFor(() => expect(finish).toBeDefined());
      for (let i = 0; i < 51; i++) {
        clock.mockReturnValue(i + 2);
        expect(await invoke(event(), { ...rollback, name: `missing-${i}`, requestId: `newer-${i}` })).toMatchObject({
          ok: false,
          error: { code: "not-found" },
        });
      }
      const running = await invoke(event(), { ...request, operation: "operations" });
      expect(running.operations).toHaveLength(51);
      expect(running.operations).toContainEqual(
        expect.objectContaining({ requestId: "long-running", status: "running" }),
      );
      clock.mockReturnValue(1000);
      finish(null);
      expect(await first).toMatchObject({ ok: true });
      const completed = await invoke(event(), { ...request, operation: "operations" });
      expect(completed.operations).toHaveLength(50);
      expect(completed.operations).toContainEqual(
        expect.objectContaining({ requestId: "long-running", status: "succeeded", finishedAt: 1000 }),
      );
      expect(completed.operations.some((entry: { requestId: string }) => entry.requestId === "newer-1")).toBe(false);
      expect(completed.operations).toContainEqual(expect.objectContaining({ requestId: "newer-50" }));
    } finally {
      stop();
      clock.mockRestore();
      if (resources) Object.defineProperty(process, "resourcesPath", resources);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  });
  it("blocks confirmed rollback in read-only mode", async () => {
    const stop = startPowerHelm();
    mocks.readOnly.enabled = true;
    const metadata = {
      metadata: {
        uid: "release-one",
        name: "sh.helm.release.v1.example.v1",
        namespace: "default",
        labels: { owner: "helm", name: "example", version: "1", status: "deployed" },
      },
    };
    mocks.response.mockResolvedValue({
      ok: true,
      headers: new Map(),
      body: Readable.from([
        JSON.stringify({ kind: "PartialObjectMetadataList", apiVersion: "meta.k8s.io/v1", items: [metadata] }),
      ]),
    });
    const listed = await mocks.handle.mock.calls[0][1](event(), request);
    const result = await mocks.handle.mock.calls[0][1](event(), {
      ...request,
      contextId: listed.contextId,
      operation: "rollback",
      uid: "release-one",
      name: "example",
      revision: 1,
      confirmed: true,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "read-only" } });
    expect(mocks.exec).not.toHaveBeenCalled();
    stop();
  });
  it("requires the displayed history context before starting rollback", async () => {
    const stop = startPowerHelm();
    const invoke = mocks.handle.mock.calls[0][1];
    const metadata = {
      metadata: {
        uid: "release-one",
        name: "sh.helm.release.v1.example.v1",
        namespace: "default",
        labels: { owner: "helm", name: "example", version: "1", status: "deployed" },
      },
    };
    mocks.response.mockImplementation(async () => ({
      ok: true,
      headers: new Map(),
      body: Readable.from([
        JSON.stringify({ kind: "PartialObjectMetadataList", apiVersion: "meta.k8s.io/v1", items: [metadata] }),
      ]),
    }));
    const old = await invoke(event(), request);
    mocks.config = "changed-config";
    const rollback = {
      ...request,
      operation: "rollback",
      uid: "release-one",
      name: "example",
      revision: 1,
      confirmed: true,
    };
    expect(await invoke(event(), { ...rollback, contextId: old.contextId })).toMatchObject({
      ok: false,
      error: { code: "context-changed" },
    });
    expect(await invoke(event(), rollback)).toMatchObject({ ok: false, error: { code: "context-changed" } });
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.response).toHaveBeenCalledTimes(1);
    const fresh = await invoke(event(), { ...request, operation: "history", name: "example" });
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
      queueMicrotask(() => callback(null));
      return { kill: vi.fn() };
    });
    const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", { value: "/neutral/resources", configurable: true });
    try {
      expect(await invoke(event(), { ...rollback, contextId: fresh.contextId })).toMatchObject({ ok: true });
      expect(mocks.exec).toHaveBeenCalledTimes(1);
      const rollbackArgs = mocks.exec.mock.calls[0][1] as string[];
      expect(
        rollbackArgs.slice(rollbackArgs.indexOf("--history-max"), rollbackArgs.indexOf("--history-max") + 2),
      ).toEqual(["--history-max", "0"]);
      mocks.response.mockImplementation(async () => ({
        ok: true,
        headers: new Map(),
        body: Readable.from([
          JSON.stringify({
            kind: "PartialObjectMetadataList",
            apiVersion: "meta.k8s.io/v1",
            items: [{ ...metadata, metadata: { ...metadata.metadata, uid: "reinstalled-release" } }],
          }),
        ]),
      }));
      expect(await invoke(event(), { ...rollback, contextId: fresh.contextId })).toMatchObject({
        ok: false,
        error: { code: "stale-revision" },
      });
      expect(mocks.exec).toHaveBeenCalledTimes(1);
    } finally {
      if (resources) Object.defineProperty(process, "resourcesPath", resources);
      else Reflect.deleteProperty(process, "resourcesPath");
      stop();
    }
  });
  it("blocks queued and repeated rollbacks after an unknown outcome until fresh history is observed", async () => {
    const stop = startPowerHelm();
    const invoke = mocks.handle.mock.calls[0][1];
    mocks.response.mockImplementation(async () => ({
      ok: true,
      headers: new Map(),
      body: Readable.from([
        JSON.stringify({
          kind: "PartialObjectMetadataList",
          apiVersion: "meta.k8s.io/v1",
          items: [
            {
              metadata: {
                uid: "release-one",
                name: "sh.helm.release.v1.example.v1",
                namespace: "default",
                labels: { owner: "helm", name: "example", version: "1", status: "deployed" },
              },
            },
          ],
        }),
      ]),
    }));
    const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", { value: "/neutral/resources", configurable: true });
    const callbacks: ((error: Error | null) => void)[] = [];
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
      callbacks.push(callback);
      return { kill: vi.fn() };
    });
    try {
      const history = { ...request, operation: "history", name: "example" };
      const listed = await invoke(event(), history);
      const rollback = {
        ...history,
        contextId: listed.contextId,
        operation: "rollback",
        uid: "release-one",
        revision: 1,
        confirmed: true,
      };
      const first = invoke(event(), { ...rollback, requestId: "first-rollback" });
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      const queued = invoke(event(), { ...rollback, requestId: "queued-rollback" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(callbacks).toHaveLength(1);
      callbacks[0](new Error("unknown outcome"));
      expect(await first).toMatchObject({ ok: false, error: { code: "rollback-unknown" } });
      expect((await invoke(event(), { ...request, operation: "operations" })).operations).toMatchObject([
        { requestId: "first-rollback", status: "failed", phase: "failed", error: { code: "rollback-unknown" } },
      ]);
      expect(await queued).toMatchObject({ ok: false, error: { code: "operation-running" } });
      expect(callbacks).toHaveLength(1);
      await invoke(event(), { ...history, requestId: "cached-history" });
      expect(await invoke(event(), { ...rollback, requestId: "blocked-rollback" })).toMatchObject({
        ok: false,
        error: { code: "rollback-unknown" },
      });
      expect(callbacks).toHaveLength(1);
      await invoke(event(), { ...history, refresh: true, requestId: "fresh-history" });
      const retry = invoke(event(), { ...rollback, requestId: "observed-rollback" });
      await vi.waitFor(() => expect(callbacks).toHaveLength(2));
      callbacks[1](null);
      expect(await retry).toMatchObject({ ok: true });
    } finally {
      stop();
      if (resources) Object.defineProperty(process, "resourcesPath", resources);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  });
  describe("historical revision deletion", () => {
    const revisionMetadata = (
      revision: number,
      status: string,
      uid = `release-${revision}`,
      resourceVersion: string | undefined = `rv-${revision}`,
    ) => ({
      metadata: {
        uid,
        resourceVersion,
        name: `sh.helm.release.v1.example.v${revision}`,
        namespace: "default",
        labels: { owner: "helm", name: "example", version: String(revision), status },
      },
    });
    const response = (items: unknown[]) => ({
      ok: true,
      headers: new Map(),
      body: Readable.from([
        JSON.stringify({
          kind: "PartialObjectMetadataList",
          apiVersion: "meta.k8s.io/v1",
          items,
        }),
      ]),
    });
    const deletion = {
      ...request,
      operation: "delete-revision",
      name: "example",
      revision: 1,
      uid: "release-1",
      confirmed: true,
    };
    it.each([
      "superseded",
      "failed",
      "uninstalled",
    ])("deletes only the selected older %s Secret using UID and resource version preconditions", async (status) => {
      const stop = startPowerHelm();
      const invoke = mocks.handle.mock.calls[0][1];
      const items = [revisionMetadata(1, status), revisionMetadata(2, "deployed")];
      mocks.response.mockImplementation(async (_path, _query, init) =>
        init.method === "DELETE"
          ? { ok: true, status: 200, body: Readable.from(["ignored response"]) }
          : response(items),
      );
      try {
        const history = await invoke(event(), { ...request, operation: "history", name: "example" });
        expect(await invoke(event(), { ...deletion, contextId: history.contextId })).toMatchObject({ ok: true });
        const deletes = mocks.response.mock.calls.filter((call) => call[2].method === "DELETE");
        expect(deletes).toHaveLength(1);
        expect(
          mocks.response.mock.calls.some((call) => call[1].query?.fieldSelector === "type=helm.sh/release.v1"),
        ).toBe(true);
        expect(deletes[0][0]).toBe("/api/v1/namespaces/default/secrets/sh.helm.release.v1.example.v1");
        expect(JSON.parse(deletes[0][2].body)).toEqual({
          apiVersion: "v1",
          kind: "DeleteOptions",
          propagationPolicy: "Orphan",
          preconditions: { uid: "release-1", resourceVersion: "rv-1" },
        });
        expect(mocks.exec).not.toHaveBeenCalled();
        await invoke(event(), { ...request, operation: "history", name: "example" });
        expect(mocks.response.mock.calls.filter((call) => call[2].method !== "DELETE")).toHaveLength(3);
      } finally {
        stop();
      }
    });
    it("refuses a non-Helm Secret with matching name and labels using metadata-only type selection", async () => {
      const stop = startPowerHelm();
      const invoke = mocks.handle.mock.calls[0][1];
      mocks.response.mockImplementation(async (_path, params) =>
        response(
          params.query?.fieldSelector === "type=helm.sh/release.v1"
            ? [revisionMetadata(2, "deployed")]
            : [revisionMetadata(1, "superseded"), revisionMetadata(2, "deployed")],
        ),
      );
      try {
        const history = await invoke(event(), { ...request, operation: "history", name: "example" });
        expect(await invoke(event(), { ...deletion, contextId: history.contextId })).toMatchObject({
          ok: false,
          error: { code: "stale-revision" },
        });
        expect(mocks.response.mock.calls[1][1].query).toMatchObject({
          fieldSelector: "type=helm.sh/release.v1",
          labelSelector: "owner=helm,name=example",
        });
        expect(
          mocks.response.mock.calls.every((call) => call[0].endsWith("/secrets") && call[2].method !== "DELETE"),
        ).toBe(true);
      } finally {
        stop();
      }
    });
    it.each([
      ["deployed", 1, "release-1", "rv-1", "active-revision"],
      ["pending-rollback", 1, "release-1", "rv-1", "active-revision"],
      ["unknown", 1, "release-1", "rv-1", "active-revision"],
      ["superseded", 2, "release-2", "rv-2", "active-revision"],
      ["superseded", 1, "replacement", "rv-1", "stale-revision"],
      ["superseded", 1, "release-1", "", "stale-revision"],
    ])("rejects unsafe target status=%s revision=%s", async (status, revision, uid, resourceVersion, code) => {
      const stop = startPowerHelm();
      const invoke = mocks.handle.mock.calls[0][1];
      mocks.response.mockImplementation(async () =>
        response([
          revisionMetadata(
            1,
            revision === 1 ? status! : "superseded",
            revision === 1 ? uid : "release-1",
            resourceVersion,
          ),
          revisionMetadata(2, revision === 2 ? status! : "deployed"),
        ]),
      );
      try {
        const context = await invoke(event(), { ...request, operation: "operations" });
        expect(
          await invoke(event(), {
            ...deletion,
            revision,
            uid: revision === 2 ? "release-2" : "release-1",
            contextId: context.contextId,
          }),
        ).toMatchObject({ ok: false, error: { code } });
        expect(mocks.response.mock.calls.some((call) => call[2].method === "DELETE")).toBe(false);
        expect(mocks.exec).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    });
    it.each([
      "read-only",
      "context",
      "confirmation",
      "pending-latest",
    ])("rechecks %s before deleting history", async (guard) => {
      const stop = startPowerHelm();
      const invoke = mocks.handle.mock.calls[0][1];
      mocks.response.mockImplementation(async () => {
        if (guard === "read-only") mocks.readOnly.enabled = true;
        if (guard === "context") mocks.config = "changed-config";
        return response([
          revisionMetadata(1, "superseded"),
          revisionMetadata(2, guard === "pending-latest" ? "pending-upgrade" : "deployed"),
        ]);
      });
      try {
        const context = await invoke(event(), { ...request, operation: "operations" });
        expect(
          await invoke(event(), { ...deletion, confirmed: guard !== "confirmation", contextId: context.contextId }),
        ).toMatchObject({ ok: false });
        expect(mocks.response.mock.calls.some((call) => call[2].method === "DELETE")).toBe(false);
      } finally {
        stop();
      }
    });
    it("rejects replacement races using preconditions and reserves the release while deletion is pending", async () => {
      const stop = startPowerHelm();
      const invoke = mocks.handle.mock.calls[0][1];
      let finish!: (response: unknown) => void;
      mocks.response.mockImplementation(async (_path, _query, init) =>
        init.method === "DELETE"
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : response([revisionMetadata(1, "superseded"), revisionMetadata(2, "deployed")]),
      );
      try {
        const context = await invoke(event(), { ...request, operation: "operations" });
        const target = { ...deletion, contextId: context.contextId };
        const pending = invoke(event(), { ...target, requestId: "delete-first" });
        await vi.waitFor(() => expect(finish).toBeDefined());
        for (const operation of ["rollback", "uninstall", "upgrade-values", "delete-revision"])
          expect(
            await invoke(event(), {
              ...target,
              operation,
              requestId: `conflict-${operation}`,
              values: "replicas: 1",
              chart: "stable/example",
            }),
          ).toMatchObject({ ok: false, error: { code: "operation-running" } });
        const call = mocks.response.mock.calls.find((entry) => entry[2].method === "DELETE")!;
        expect(JSON.parse(call[2].body).preconditions).toEqual({ uid: "release-1", resourceVersion: "rv-1" });
        finish({ ok: false, status: 409 });
        expect(await pending).toMatchObject({ ok: false, error: { code: "stale-revision" } });
        mocks.response.mockImplementation(async (_path, _query, init) =>
          init.method === "DELETE"
            ? { ok: true, status: 200 }
            : response([revisionMetadata(1, "superseded"), revisionMetadata(2, "deployed")]),
        );
        expect(await invoke(event(), target)).toMatchObject({ ok: true });
        expect(mocks.exec).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    });
    it("sanitizes an uncertain deletion failure and requires refreshed history before retrying", async () => {
      const stop = startPowerHelm();
      const invoke = mocks.handle.mock.calls[0][1];
      mocks.response.mockImplementation(async (_path, _query, init) => {
        if (init.method === "DELETE") throw new Error("private endpoint and credential");
        return response([revisionMetadata(1, "superseded"), revisionMetadata(2, "deployed")]);
      });
      try {
        const context = await invoke(event(), { ...request, operation: "operations" });
        const target = { ...deletion, contextId: context.contextId };
        const failed = await invoke(event(), target);
        expect(failed).toMatchObject({ ok: false, error: { code: "delete-revision-unknown" } });
        expect(JSON.stringify(failed)).not.toContain("private");
        expect(await invoke(event(), target)).toMatchObject({ ok: false, error: { code: "delete-revision-unknown" } });
        expect(mocks.response.mock.calls.filter((call) => call[2].method === "DELETE")).toHaveLength(1);
        await invoke(event(), { ...request, operation: "history", name: "example", refresh: true });
        mocks.response.mockImplementation(async (_path, _query, init) =>
          init.method === "DELETE"
            ? { ok: true, status: 200 }
            : response([revisionMetadata(1, "superseded"), revisionMetadata(2, "deployed")]),
        );
        expect(await invoke(event(), target)).toMatchObject({ ok: true });
      } finally {
        stop();
      }
    });
  });
  it("uninstalls only a confirmed current release and requires refresh after an unknown outcome", async () => {
    const stop = startPowerHelm();
    const invoke = mocks.handle.mock.calls[0][1];
    let uid = "release-one";
    let revision = 1;
    mocks.response.mockImplementation(async () => ({
      ok: true,
      headers: new Map(),
      body: Readable.from([
        JSON.stringify({
          kind: "PartialObjectMetadataList",
          apiVersion: "meta.k8s.io/v1",
          items: [
            {
              metadata: {
                uid,
                name: `sh.helm.release.v1.example.v${revision}`,
                namespace: "default",
                labels: { owner: "helm", name: "example", version: String(revision), status: "deployed" },
              },
            },
          ],
        }),
      ]),
    }));
    const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", { value: "/neutral/resources", configurable: true });
    try {
      const listed = await invoke(event(), request);
      expect(listed).toMatchObject({ ok: true, uninstallAllowed: true });
      const deletion = {
        ...request,
        operation: "uninstall",
        name: "example",
        uid,
        revision,
        contextId: listed.contextId,
        confirmed: true,
        confirmationName: "example",
      };
      for (const patch of [{ uid: undefined }, { revision: 0 }, { namespace: "" }]) {
        expect(await invoke(event(), { ...deletion, ...patch })).toMatchObject({
          ok: false,
          error: { code: "invalid-request" },
        });
      }
      expect(await invoke(event(), { ...deletion, contextId: undefined })).toMatchObject({
        ok: false,
        error: { code: "context-changed" },
      });
      expect(await invoke(event(), { ...deletion, confirmed: false })).toMatchObject({
        ok: false,
        error: { code: "confirmation-required" },
      });
      const readsBeforeConfirmation = mocks.response.mock.calls.length;
      for (const confirmationName of [undefined, "", "Example", "example ", " example", "other-release"])
        expect(await invoke(event(), { ...deletion, confirmationName })).toMatchObject({
          ok: false,
          error: { code: "confirmation-required" },
        });
      expect(mocks.response.mock.calls).toHaveLength(readsBeforeConfirmation);
      expect(mocks.exec).not.toHaveBeenCalled();
      mocks.readOnly.enabled = true;
      expect(await invoke(event(), deletion)).toMatchObject({ ok: false, error: { code: "read-only" } });
      mocks.readOnly.enabled = false;
      uid = "replacement";
      expect(await invoke(event(), deletion)).toMatchObject({ ok: false, error: { code: "stale-revision" } });
      uid = "release-one";
      revision = 2;
      expect(await invoke(event(), deletion)).toMatchObject({ ok: false, error: { code: "stale-revision" } });
      revision = 1;
      expect(mocks.exec).not.toHaveBeenCalled();
      mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
        queueMicrotask(() => callback(null));
        return { kill: vi.fn() };
      });
      expect(await invoke(event(), deletion)).toMatchObject({ ok: true });
      expect(mocks.exec.mock.calls[0][1]).toEqual([
        "uninstall",
        "example",
        "--namespace",
        "default",
        "--kubeconfig",
        "/neutral/config",
        "--kube-context",
        "neutral",
        "--timeout",
        "60s",
      ]);
      let complete!: (error: Error) => void;
      const kill = vi.fn(() => queueMicrotask(() => complete(new Error("aborted"))));
      mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
        complete = callback;
        return { kill };
      });
      const senderEvent = event();
      const pending = invoke(senderEvent, deletion);
      await vi.waitFor(() => expect(complete).toBeDefined());
      await invoke(senderEvent, { ...request, operation: "cancel" });
      expect(await pending).toMatchObject({ ok: false, error: { code: "uninstall-unknown" } });
      expect(kill).toHaveBeenCalledOnce();
      const calls = mocks.exec.mock.calls.length;
      expect(await invoke(event(), deletion)).toMatchObject({ ok: false, error: { code: "uninstall-unknown" } });
      expect(mocks.exec).toHaveBeenCalledTimes(calls);
      await invoke(event(), { ...request, operation: "history", name: "example", refresh: true });
      mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
        queueMicrotask(() => callback(null));
        return { kill: vi.fn() };
      });
      expect(await invoke(event(), deletion)).toMatchObject({ ok: true });
    } finally {
      if (resources) Object.defineProperty(process, "resourcesPath", resources);
      else Reflect.deleteProperty(process, "resourcesPath");
      stop();
    }
  });
  it("blocks values editing across target and storage namespaces before launching Helm", async () => {
    const stop = startPowerHelm();
    const invoke = mocks.handle.mock.calls[0][1];
    const metadata = {
      metadata: {
        uid: "release-one",
        name: "sh.helm.release.v1.example.v1",
        namespace: "default",
        labels: { owner: "helm", name: "example", version: "1", status: "deployed" },
      },
    };
    const release = {
      name: "example",
      namespace: "application",
      version: 1,
      chart: { metadata: { name: "example", version: "1.2.3" } },
    };
    mocks.response.mockImplementation(async (path) => {
      const body = path.endsWith("/secrets")
        ? { kind: "PartialObjectMetadataList", apiVersion: "meta.k8s.io/v1", items: [metadata] }
        : {
            ...metadata,
            type: "helm.sh/release.v1",
            data: {
              release: Buffer.from(gzipSync(Buffer.from(JSON.stringify(release))).toString("base64")).toString(
                "base64",
              ),
            },
          };
      return { ok: true, headers: new Map(), body: Readable.from([JSON.stringify(body)]) };
    });
    try {
      const history = await invoke(event(), { ...request, operation: "history", name: "example" });
      const edit = { ...request, contextId: history.contextId, name: "example", revision: 1, uid: "release-one" };
      expect(await invoke(event(), { ...edit, operation: "details", section: "overview" })).toMatchObject({
        ok: true,
        detail: { overview: { namespace: "application" } },
      });
      expect(await invoke(event(), { ...edit, operation: "edit-options" })).toMatchObject({
        ok: false,
        error: { code: "unsupported-release-namespace" },
      });
      for (const chart of ["@installed", "stable/example"])
        expect(
          await invoke(event(), {
            ...edit,
            operation: "upgrade-values",
            values: "replicas: 2",
            chart,
            confirmed: true,
          }),
        ).toMatchObject({ ok: false, error: { code: "unsupported-release-namespace" } });
      expect(mocks.exec).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it("uses the complete installed chart without repository access and retains stale UID guards", async () => {
    const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", { value: "/neutral/resources", configurable: true });
    const stop = startPowerHelm();
    const invoke = mocks.handle.mock.calls[0][1];
    let uid = "release-one";
    let replaceAfterSecret = false;
    const paths: string[] = [];
    const metadata = () => ({
      metadata: {
        uid,
        name: "sh.helm.release.v1.example.v1",
        namespace: "default",
        labels: { owner: "helm", name: "example", version: "1", status: "deployed" },
      },
    });
    mocks.response.mockImplementation(async (path) => {
      const release = {
        name: "example",
        namespace: "default",
        version: 1,
        chart: {
          metadata: { apiVersion: "v2", name: "example", version: "1.2.3" },
          values: { replicas: 1 },
          templates: [
            {
              name: "templates/deployment.yaml",
              data: Buffer.from("replicas: {{ .Values.replicas }}").toString("base64"),
            },
          ],
          schema: Buffer.from('{"type":"object"}').toString("base64"),
        },
        config: { replicas: 2 },
      };
      const body = path.endsWith("/secrets")
        ? { kind: "PartialObjectMetadataList", apiVersion: "meta.k8s.io/v1", items: [metadata()] }
        : {
            ...metadata(),
            type: "helm.sh/release.v1",
            data: {
              release: Buffer.from(gzipSync(Buffer.from(JSON.stringify(release))).toString("base64")).toString(
                "base64",
              ),
            },
          };
      if (!path.endsWith("/secrets") && replaceAfterSecret) uid = "replacement";
      return { ok: true, headers: new Map(), body: Readable.from([JSON.stringify(body)]) };
    });
    mocks.exec.mockImplementation((_binary, args, _options, callback) => {
      paths.push(args[2]);
      queueMicrotask(() => callback(null));
      return { kill: vi.fn() };
    });
    try {
      const history = await invoke(event(), { ...request, operation: "history", name: "example" });
      const edit = {
        ...request,
        contextId: history.contextId,
        operation: "edit-options",
        name: "example",
        revision: 1,
        uid: "release-one",
      };
      expect(await invoke(event(), edit)).toMatchObject({
        ok: true,
        chartChoices: [{ ref: "@installed", version: "1.2.3" }],
      });
      expect(mocks.exec).not.toHaveBeenCalled();
      const upgrade = {
        ...edit,
        operation: "upgrade-values",
        values: "replicas: 3",
        chart: "@installed",
        confirmed: true,
      };
      mocks.exec.mockImplementation((_binary, args, _options, callback) => {
        paths.push(args[2]);
        void readFile(args[2])
          .then((archive) => {
            const contents = gunzipSync(archive).toString();
            expect(contents).toContain("replicas: 1\n");
            expect(contents).toContain('{"type":"object"}');
            callback(null);
          })
          .catch((error) => callback(error));
        return { kill: vi.fn() };
      });
      expect(await invoke(event(), upgrade)).toMatchObject({ ok: true });
      expect(mocks.exec).toHaveBeenCalledTimes(1);
      expect(mocks.exec.mock.calls[0][1]).toEqual(
        expect.arrayContaining(["upgrade", "--version", "1.2.3", "--reset-values", "--history-max", "0"]),
      );
      await expect(access(paths[0])).rejects.toThrow();
      replaceAfterSecret = true;
      expect(await invoke(event(), upgrade)).toMatchObject({ ok: false, error: { code: "stale-revision" } });
      expect(mocks.exec).toHaveBeenCalledTimes(1);
      expect(await invoke(event(), upgrade)).toMatchObject({ ok: false, error: { code: "stale-revision" } });
    } finally {
      stop();
      if (resources) Object.defineProperty(process, "resourcesPath", resources);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  });
  it("upgrades only the current chart version and blocks retries after unknown outcomes", async () => {
    const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", { value: "/neutral/resources", configurable: true });
    const stop = startPowerHelm();
    const invoke = mocks.handle.mock.calls[0][1];
    let revision = 1;
    let uid = "release-one";
    let failUpgrade = false;
    const metadata = () => ({
      metadata: {
        uid,
        name: `sh.helm.release.v1.example.v${revision}`,
        namespace: "default",
        labels: { owner: "helm", name: "example", version: String(revision), status: "deployed" },
      },
    });
    mocks.response.mockImplementation(async (path) => {
      const release = {
        name: "example",
        namespace: "default",
        version: revision,
        chart: { metadata: { name: "example", version: "1.2.3" } },
        config: { replicas: 1 },
      };
      const result = path.endsWith("/secrets")
        ? { kind: "PartialObjectMetadataList", apiVersion: "meta.k8s.io/v1", items: [metadata()] }
        : {
            ...metadata(),
            type: "helm.sh/release.v1",
            data: {
              release: Buffer.from(gzipSync(Buffer.from(JSON.stringify(release))).toString("base64")).toString(
                "base64",
              ),
            },
          };
      return { ok: true, headers: new Map(), body: Readable.from([JSON.stringify(result)]) };
    });
    mocks.exec.mockImplementation((_binary, args, _options, callback) => {
      queueMicrotask(() =>
        callback(
          args[0] === "upgrade" && failUpgrade ? new Error("failure") : null,
          args[0] === "search" ? JSON.stringify([{ name: "stable/example", version: "1.2.3" }]) : "",
        ),
      );
      return { kill: vi.fn() };
    });
    try {
      const history = await invoke(event(), { ...request, operation: "history", name: "example" });
      const edit = { ...request, contextId: history.contextId, name: "example", revision: 1 };
      expect(await invoke(event(), { ...edit, operation: "edit-options" })).toMatchObject({
        ok: true,
        upgradeAllowed: true,
        chartChoices: [{ ref: "stable/example", version: "1.2.3" }],
      });
      const upgrade = {
        ...edit,
        operation: "upgrade-values",
        uid: "release-one",
        values: "replicas: 2",
        chart: "stable/example",
        confirmed: true,
      };
      mocks.readOnly.enabled = true;
      mocks.exec.mockClear();
      expect(await invoke(event(), { ...edit, operation: "edit-options" })).toMatchObject({
        ok: true,
        upgradeAllowed: false,
      });
      expect(await invoke(event(), upgrade)).toMatchObject({ ok: false, error: { code: "read-only" } });
      expect(mocks.exec).not.toHaveBeenCalled();
      mocks.readOnly.enabled = false;
      expect(await invoke(event(), { ...upgrade, chart: "other/example" })).toMatchObject({
        ok: false,
        error: { code: "chart-unavailable" },
      });
      mocks.exec.mockImplementationOnce((_binary, _args, _options, callback) => {
        queueMicrotask(() => {
          uid = "replaced-before-launch";
          callback(null, JSON.stringify([{ name: "stable/example", version: "1.2.3" }]));
        });
        return { kill: vi.fn() };
      });
      expect(await invoke(event(), upgrade)).toMatchObject({ ok: false, error: { code: "stale-revision" } });
      expect(mocks.exec.mock.calls.some((call) => call[1][0] === "upgrade")).toBe(false);
      uid = "release-one";
      expect(await invoke(event(), upgrade)).toMatchObject({ ok: true });
      const args = mocks.exec.mock.calls.find((call) => call[1][0] === "upgrade")![1];
      expect(args).toEqual([
        "upgrade",
        "example",
        "stable/example",
        "--version",
        "1.2.3",
        "--values",
        expect.any(String),
        "--reset-values",
        "--history-max",
        "0",
        "--namespace",
        "default",
        "--kubeconfig",
        "/neutral/config",
        "--kube-context",
        "neutral",
        "--timeout",
        "60s",
      ]);
      const deferred: Array<(error: Error | null) => void> = [];
      mocks.exec.mockImplementation((_binary, args, _options, callback) => {
        if (args[0] === "upgrade") deferred.push(callback);
        else queueMicrotask(() => callback(null, JSON.stringify([{ name: "stable/example", version: "1.2.3" }])));
        return { kill: vi.fn() };
      });
      const olderDraft = invoke(event(), { ...upgrade, requestId: "current-draft" });
      await vi.waitFor(() => expect(deferred).toHaveLength(1));
      const staleDraft = invoke(event(), { ...upgrade, requestId: "stale-draft" });
      revision = 2;
      deferred[0](null);
      expect(await olderDraft).toMatchObject({ ok: true });
      expect(await staleDraft).toMatchObject({ ok: false, error: { code: "operation-running" } });
      expect(deferred).toHaveLength(1);
      revision = 1;
      deferred.length = 0;
      const otherHistory = await invoke(event(), {
        ...edit,
        operation: "history",
        clusterId: "other-cluster",
        contextId: undefined,
      });
      const first = invoke(event(), { ...upgrade, requestId: "first" });
      await vi.waitFor(() => expect(deferred).toHaveLength(1));
      const second = invoke(event(), {
        ...upgrade,
        requestId: "second",
        clusterId: "other-cluster",
        contextId: otherHistory.contextId,
      });
      await vi.waitFor(() => expect(deferred).toHaveLength(2));
      let finishOldHistory!: () => void;
      mocks.response.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldHistory = () =>
              resolve({
                ok: true,
                headers: new Map(),
                body: Readable.from([
                  JSON.stringify({
                    kind: "PartialObjectMetadataList",
                    apiVersion: "meta.k8s.io/v1",
                    items: [metadata()],
                  }),
                ]),
              });
          }),
      );
      const oldHistory = invoke(event(), { ...edit, operation: "history", refresh: true, requestId: "old-history" });
      await vi.waitFor(() => expect(finishOldHistory).toBeDefined());
      const queued = invoke(event(), { ...upgrade, requestId: "queued" });
      const readsBeforeFailure = mocks.response.mock.calls.length;
      deferred[0](new Error("unknown outcome"));
      expect(await first).toMatchObject({ ok: false, error: { code: "upgrade-unknown" } });
      expect(await queued).toMatchObject({ ok: false, error: { code: "operation-running" } });
      expect(deferred).toHaveLength(2);
      expect(mocks.response).toHaveBeenCalledTimes(readsBeforeFailure);
      finishOldHistory();
      expect(await oldHistory).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await invoke(event(), { ...upgrade, requestId: "after-old-history" })).toMatchObject({
        ok: false,
        error: { code: "upgrade-unknown" },
      });
      expect(deferred).toHaveLength(2);
      deferred[1](null);
      expect(await second).toMatchObject({ ok: true });
      await invoke(event(), { ...edit, operation: "history", refresh: true });
      mocks.exec.mockImplementation((_binary, args, _options, callback) => {
        queueMicrotask(() =>
          callback(
            args[0] === "upgrade" && failUpgrade ? new Error("failure") : null,
            args[0] === "search" ? JSON.stringify([{ name: "stable/example", version: "1.2.3" }]) : "",
          ),
        );
        return { kill: vi.fn() };
      });
      failUpgrade = true;
      expect(await invoke(event(), upgrade)).toMatchObject({ ok: false, error: { code: "upgrade-unknown" } });
      mocks.exec.mockClear();
      expect(await invoke(event(), upgrade)).toMatchObject({ ok: false, error: { code: "upgrade-unknown" } });
      expect(mocks.exec).not.toHaveBeenCalled();
      await invoke(event(), { ...edit, operation: "history", refresh: true });
      uid = "release-reinstalled";
      expect(await invoke(event(), upgrade)).toMatchObject({ ok: false, error: { code: "stale-revision" } });
      expect(mocks.exec).not.toHaveBeenCalled();
      revision = 2;
      expect(await invoke(event(), upgrade)).toMatchObject({ ok: false, error: { code: "stale-revision" } });
      expect(mocks.exec).not.toHaveBeenCalled();
    } finally {
      stop();
      if (resources) Object.defineProperty(process, "resourcesPath", resources);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  });
  it("rejects option injection and invalid rollback revisions", () => {
    expect(() => validateHelmRequest({ ...request, operation: "rollback", name: "example", revision: 1 })).toThrow();
    expect(() =>
      validateHelmRequest({
        ...request,
        operation: "upgrade-values",
        name: "example",
        revision: 1,
        chart: "stable/example",
        values: "{}",
        confirmed: true,
      }),
    ).toThrow();
    expect(() =>
      validateHelmRequest({ ...request, operation: "rollback", uid: "release-one", name: "--help", revision: 1 }),
    ).toThrow();
    expect(() =>
      validateHelmRequest({ ...request, operation: "rollback", uid: "release-one", name: "example", revision: 0 }),
    ).toThrow();
  });
  it("rechecks write authorization synchronously after asynchronous preparation", async () => {
    const launchGuard = vi.fn(() => {
      if (mocks.readOnly.enabled) throw new Error("read-only");
    });
    const pending = executeHelmRollback(
      "neutral",
      ["upgrade"],
      new AbortController().signal,
      "upgrade",
      async () => {
        queueMicrotask(() => {
          mocks.readOnly.enabled = true;
        });
      },
      launchGuard,
    );
    await expect(pending).rejects.toThrow("read-only");
    expect(launchGuard).toHaveBeenCalledOnce();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it.each([
    ["Error: no repositories configured", {}, "No Helm repositories are configured"],
    ["Error: no cached repo found for example", {}, "Helm repository indexes are unavailable"],
    ["", { killed: true }, "Helm repository search timed out"],
    ["", { code: "ENOENT" }, "The Freelens Helm executable is unavailable"],
    ["private diagnostic https://user:secret@example.invalid", {}, "Check repository configuration"],
  ])("explains repository search failures without exposing process diagnostics", async (stderr, details, message) => {
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
      queueMicrotask(() => callback(Object.assign(new Error("process failed"), details), "", stderr));
      return { kill: vi.fn() };
    });
    const result = executeHelmRead("neutral", ["search"], new AbortController().signal);
    await expect(result).rejects.toMatchObject({
      code: "chart-unavailable",
      message: expect.stringContaining(message),
    });
    await expect(result).rejects.not.toThrow("secret");
  });
  it("reports a cancelled running repository search separately from repository failures", async () => {
    let finish!: (error: Error, stdout: string, stderr: string) => void;
    const controller = new AbortController();
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
      finish = callback;
      return { kill: () => finish(new Error("killed"), "", "no repositories configured") };
    });
    const result = executeHelmRead("neutral", ["search"], controller.signal);
    await vi.waitFor(() => expect(finish).toBeDefined());
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
  });
  it.each(["legacy", "structured"])("streams fixed safe stages from chunked %s Helm debug output", async (format) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let finish!: (error: Error | null) => void;
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
      finish = callback;
      return { kill: vi.fn(), stdout, stderr };
    });
    const progress = vi.fn();
    const pending = executeHelmRollback(
      "neutral",
      ["rollback"],
      new AbortController().signal,
      "rollback",
      undefined,
      undefined,
      progress,
    );
    try {
      await vi.waitFor(() => expect(finish).toBeDefined());
      const line = (message: string) =>
        format === "legacy"
          ? `rollback.go:120: [debug] ${message} private-value\n`
          : `time=2026-01-01T00:00:00Z level=DEBUG msg="${message}" release=private-value endpoint=https://private.invalid\n`;
      const send = (stream: EventEmitter, message: string) => {
        const output = line(message);
        for (let offset = 0; offset < output.length; offset += 7) stream.emit("data", output.slice(offset, offset + 7));
      };
      send(stderr, "preparing rollback");
      send(stdout, "performing rollback");
      send(stderr, "beginning wait for resources");
      send(stdout, "unknown private chart manifest contents");
      stdout.emit(
        "data",
        'level=INFO msg="performing rollback" private-value\napiVersion: v1\nkind: Secret\ndata: private-value\n',
      );
      expect(progress.mock.calls).toEqual([
        ["preparing", "Helm is preparing the rollback"],
        ["applying", "Helm is applying release changes"],
        ["waiting", "Helm is waiting for resources to become ready"],
      ]);
      expect(JSON.stringify(progress.mock.calls)).not.toContain("private");
    } finally {
      finish(null);
      await pending;
    }
  });
  it("shares two process permits across reads and writes and cancels queued commands", async () => {
    const callbacks: Array<(error: Error | null, stdout?: string) => void> = [];
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
      callbacks.push(callback);
      return { kill: vi.fn() };
    });
    const signal = new AbortController().signal;
    const read = executeHelmRead("neutral", ["search"], signal);
    const write = executeHelmRollback("neutral", ["upgrade"], signal, "upgrade");
    const cancelled = new AbortController();
    const queued = executeHelmRead("neutral", ["search"], cancelled.signal);
    const queuedResult = expect(queued).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalledTimes(2));
    cancelled.abort();
    await queuedResult;
    callbacks[0](null, "[]");
    await read;
    expect(mocks.exec).toHaveBeenCalledTimes(2);
    const next = executeHelmRead("neutral", ["search"], signal);
    await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalledTimes(3));
    callbacks[1](null);
    callbacks[2](null, "[]");
    await Promise.all([write, next]);
  });
  it.each([
    ["ENOENT", "Helm executable or one of its required programs is unavailable"],
    ["EACCES", "could not start"],
    ["ENOEXEC", "could not start"],
  ])("distinguishes a command launch failure from an unknown mutation: %s", async (code, message) => {
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
      queueMicrotask(() =>
        callback(Object.assign(new Error("private local path"), { code }), "", "private credentials"),
      );
      return { kill: vi.fn() };
    });
    const result = executeHelmRollback("neutral", ["rollback"], new AbortController().signal);
    await expect(result).rejects.toMatchObject({ code: "helm-unavailable", message: expect.stringContaining(message) });
    await expect(result).rejects.not.toThrow("private");
  });
  it.each([
    ["Error: secrets is forbidden: cannot patch resource", "Kubernetes denied access"],
    [
      "Error: Kubernetes cluster unreachable: the server has asked for the client to provide credentials",
      "authentication failed",
    ],
    ["Error: getting credentials: exec: executable example not found", "authentication failed"],
    ["Error: x509: certificate signed by unknown authority", "TLS verification failed"],
    ["Error: Kubernetes cluster unreachable: dial tcp: connection refused", "could not be reached"],
    ["Error: conflict with field manager", "resource conflict"],
    ["Error: post-rollback hooks failed: timed out waiting", "Helm hook or resource operation failed"],
    ["Error: unknown flag: --unsupported", "incompatible with this Helm version"],
    ["sensitive https://user:secret@example.invalid private-path", "Review release history and Kubernetes events"],
  ])("explains a failed started command without exposing diagnostics: %s", async (diagnostic, message) => {
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
      queueMicrotask(() =>
        callback(Object.assign(new Error("secret command details"), { code: 1 }), "secret stdout", diagnostic),
      );
      return { kill: vi.fn() };
    });
    const result = executeHelmRollback("neutral", ["rollback"], new AbortController().signal);
    await expect(result).rejects.toMatchObject({ code: "rollback-unknown", message: expect.stringContaining(message) });
    await expect(result).rejects.toThrow("refresh release history before retrying");
    await expect(result).rejects.not.toThrow("secret");
    await expect(result).rejects.not.toThrow("example.invalid");
  });
  it.each([
    "rollback",
    "upgrade",
    "uninstall",
  ] as const)("keeps the uncertainty code for a timed out %s", async (operation) => {
    mocks.exec.mockImplementation((_binary, _args, _options, callback) => {
      queueMicrotask(() => callback(Object.assign(new Error("timeout"), { killed: true, signal: "SIGKILL" }), "", ""));
      return { kill: vi.fn() };
    });
    await expect(
      executeHelmRollback("neutral", [operation], new AbortController().signal, operation),
    ).rejects.toMatchObject({
      code: `${operation}-unknown`,
      message: expect.stringContaining("exceeded its time limit"),
    });
  });
  it("kills a started rollback on abort and reports unknown outcome", async () => {
    let callback!: (error: Error) => void;
    const kill = vi.fn(() => {
      callback(new Error("killed"));
      return true;
    });
    mocks.exec.mockImplementation((_file, _args, _options, done) => {
      callback = done;
      return { kill };
    });
    const c = new AbortController();
    const pending = executeHelmRollback("neutral", [], c.signal);
    await vi.waitFor(() => expect(callback).toBeDefined());
    c.abort();
    await expect(pending).rejects.toMatchObject({ code: "rollback-unknown" });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });
});
