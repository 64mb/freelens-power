import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projectSearchDocuments, RESOURCE_SEARCH_CHANNEL } from "../common/resource-search";
import { projectMetadataPage } from "../renderer/resource-search-discovery";
import { startResourceSearchIndex, trustedSearchSender, validateSearchRequest } from "./resource-search";

import type { IpcMainInvokeEvent } from "electron";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  cluster: { id: "cluster-one", kubeConfigPath: "", contextName: "example" },
  destroyed: false,
  call: vi.fn(async (_request: unknown) => ({ count: 1, bytes: 10, available: true })),
  close: vi.fn(),
  preferences: { resourceSearchEnabled: true },
}));
vi.mock("../common/store/monitoring-preferences-store", () => ({
  MonitoringPreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));
vi.mock("@freelensapp/extensions", () => ({
  Main: { Catalog: { getClusterById: (id: string) => (id === mocks.cluster.id ? mocks.cluster : undefined) } },
}));
vi.mock("electron", () => ({
  app: { getPath: () => join(mocks.cluster.kubeConfigPath, "..") },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => mocks.destroyed }) },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler),
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
  },
}));
vi.mock("./resource-search-worker", () => ({
  ResourceSearchWorker: class {
    call = mocks.call;
    close = mocks.close;
  },
}));
let directory: string;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.destroyed = false;
  mocks.preferences = observable({ resourceSearchEnabled: true });
  directory = mkdtempSync(join(tmpdir(), "power-search-ipc-"));
  mocks.cluster.kubeConfigPath = join(directory, "config");
  writeFileSync(mocks.cluster.kubeConfigPath, "neutral-config-one");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function event(frameUrl = "https://cluster-one.renderer.freelens.app:1234/") {
  const root = {};
  const frame = { url: frameUrl, parent: root, top: root };
  return {
    sender: { mainFrame: root, getURL: () => "https://renderer.freelens.app:1234/" },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
}
it("binds search IPC to the exact cluster origin and trusted direct frame", () => {
  expect(trustedSearchSender(event(), "cluster-one")).toBe(true);
  for (const url of [
    "https://cluster-two.renderer.freelens.app:1234/",
    "https://cluster-one.renderer.freelens.app.evil.invalid:1234/",
    "http://cluster-one.renderer.freelens.app:1234/",
    "https://cluster-one.renderer.freelens.app:1235/",
    "https://user@cluster-one.renderer.freelens.app:1234/",
  ])
    expect(trustedSearchSender(event(url), "cluster-one")).toBe(false);
  const nested = event();
  Object.assign(nested.senderFrame!, { parent: {} });
  expect(trustedSearchSender(nested, "cluster-one")).toBe(false);
  mocks.destroyed = true;
  expect(trustedSearchSender(event(), "cluster-one")).toBe(false);
});
it("fingerprints actual configuration changes and shuts down its handler and worker", async () => {
  const stop = startResourceSearchIndex();
  const invoke = mocks.handlers.get(RESOURCE_SEARCH_CHANNEL)!;
  const request = { operation: "status", clusterId: "cluster-one", contextId: "renderer-context" };
  await invoke(event(), request);
  const first = mocks.call.mock.calls[0][0] as unknown as { contextId: string };
  expect(first.contextId).toMatch(/^[a-f0-9]{64}$/);
  expect(first.contextId).not.toContain("neutral-config");
  writeFileSync(mocks.cluster.kubeConfigPath, "neutral-config-two");
  await invoke(event(), request);
  expect(mocks.call.mock.calls[1][0]).not.toEqual(first);
  await expect(invoke(event(), { ...request, clusterId: "cluster-two" })).rejects.toThrow();
  stop();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.handlers.has(RESOURCE_SEARCH_CHANNEL)).toBe(false);
  await expect(invoke(event(), request)).rejects.toThrow("unavailable");
});
it("shares request start budgets across frames and cancels pending permits on disable", async () => {
  vi.useFakeTimers();
  const stop = startResourceSearchIndex();
  const invoke = mocks.handlers.get(RESOURCE_SEARCH_CHANNEL)!;
  const request = { operation: "permit", clusterId: "cluster-one", contextId: "renderer-context" };
  try {
    expect(await invoke(event(), request)).toBe(true);
    let completed = false;
    const second = invoke(event(), request).then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    const waiting = expect(invoke(event(), request)).rejects.toThrow("changed");
    stop();
    await waiting;
    expect(mocks.call).not.toHaveBeenCalled();
  } finally {
    stop();
    vi.useRealTimers();
  }
});
it("disables the index worker while preserving shared Gateway request permits", async () => {
  const stop = startResourceSearchIndex();
  const invoke = mocks.handlers.get(RESOURCE_SEARCH_CHANNEL)!;
  const partition = { clusterId: "cluster-one", contextId: "context-one" };
  try {
    await invoke(event(), { ...partition, operation: "status" });
    runInAction(() => {
      mocks.preferences.resourceSearchEnabled = false;
    });
    expect(mocks.close).toHaveBeenCalledOnce();
    await expect(invoke(event(), { ...partition, operation: "query", query: "" })).rejects.toThrow("disabled");
    await expect(
      invoke(event(), { ...partition, operation: "begin", scope: "/pods/*", scanId: "scan" }),
    ).rejects.toThrow("disabled");
    await expect(invoke(event(), { ...partition, operation: "permit" })).resolves.toBe(true);
    runInAction(() => {
      mocks.preferences.resourceSearchEnabled = true;
    });
    await expect(invoke(event(), { ...partition, operation: "status" })).resolves.toEqual(
      expect.objectContaining({ available: true }),
    );
  } finally {
    stop();
  }
});
it("rejects oversized, malformed and unsupported operations and drops unrelated request fields", () => {
  const base = { clusterId: "cluster-one", contextId: "context-one" };
  for (const request of [
    null,
    {},
    { ...base, operation: "exec" },
    { ...base, operation: "query", query: "x".repeat(301) },
    { ...base, operation: "query", query: "", limit: 1001 },
    { ...base, operation: "query", query: "", offset: -1 },
    { ...base, operation: "query", query: "", offset: 1.5 },
    { ...base, operation: "begin", scope: "pods", scanId: "../bad" },
  ])
    expect(() => validateSearchRequest(request)).toThrow();
  expect(validateSearchRequest({ ...base, operation: "status", data: "private" })).toEqual({
    ...base,
    operation: "status",
  });
});
it.each([
  "system:discovery",
  "user@example.test",
  "team+ops",
  "team-\u03b1",
])("indexes valid encoded RBAC path-segment names: %s", (name) => {
  const projected = projectMetadataPage(
    {
      group: "rbac.authorization.k8s.io",
      version: "v1",
      kind: "ClusterRole",
      resource: "clusterroles",
      namespaced: false,
      aliases: [],
    },
    { items: [{ metadata: { name, uid: "role-uid" } }] },
  );
  expect(projectSearchDocuments(projected)[0].path).toBe(
    `/apis/rbac.authorization.k8s.io/v1/clusterroles/${encodeURIComponent(name)}`,
  );
});
it("keeps custom objects searchable without copying unknown fields or accepting unrelated native paths", () => {
  const object = {
    kind: "Pod",
    name: "example",
    group: "example.test",
    version: "v1",
    resource: "pods",
    path: "/apis/example.test/v1/pods/example",
    labels: {},
    fields: [{ label: "password", text: "private" }],
    spec: { token: "private" },
  };
  expect(projectSearchDocuments([object])).toEqual([expect.objectContaining({ kind: "Pod", fields: [] })]);
  expect(() => projectSearchDocuments([{ ...object, path: "/api/v1/pods/example" }])).toThrow("path");
  expect(() => projectSearchDocuments(Array(501).fill(object))).toThrow("batch");
});
