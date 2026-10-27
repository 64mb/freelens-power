import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
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
      expect(await staleDraft).toMatchObject({ ok: false, error: { code: "stale-revision" } });
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
      expect(await queued).toMatchObject({ ok: false, error: { code: "upgrade-unknown" } });
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
