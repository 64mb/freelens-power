import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Main } from "@freelensapp/extensions";
import { app, BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import { reaction } from "mobx";
import {
  projectSearchDocuments,
  RESOURCE_SEARCH_CHANNEL,
  type SearchIndexRequest,
  validSearchPartition,
} from "../common/resource-search";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";
import { ResourceSearchWorker } from "./resource-search-worker";

export function trustedSearchSender(event: IpcMainInvokeEvent, clusterId: string): boolean {
  const window = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  if (!window || window.isDestroyed() || !frame) return false;
  try {
    const url = new URL(frame.url);
    const root = new URL(event.sender.getURL());
    if (
      url.protocol !== "https:" ||
      root.protocol !== "https:" ||
      url.username ||
      url.password ||
      root.username ||
      root.password
    )
      return false;
    if (url.hostname !== `${clusterId}.renderer.freelens.app` || root.port !== url.port) return false;
    if (frame === event.sender.mainFrame) return root.origin === url.origin;
    return (
      root.hostname === "renderer.freelens.app" &&
      frame.parent === event.sender.mainFrame &&
      frame.top === event.sender.mainFrame
    );
  } catch {
    return false;
  }
}

export function validateSearchRequest(input: unknown): SearchIndexRequest {
  if (!validSearchPartition(input)) throw new Error("Invalid search partition");
  const request = input as SearchIndexRequest;
  const partition = { clusterId: request.clusterId, contextId: request.contextId };
  if (request.operation === "reconcile") {
    if (
      !Array.isArray(request.resources) ||
      request.resources.length > 10000 ||
      request.resources.some(
        (resource) => typeof resource !== "string" || !/^[a-zA-Z0-9_.-]{0,253}\/[a-zA-Z0-9_.-]{1,253}$/.test(resource),
      )
    )
      throw new Error("Invalid search resource catalog");
    return { ...partition, operation: "reconcile", resources: [...new Set(request.resources)] };
  }
  if (["begin", "append", "complete", "invalidate"].includes(request.operation)) {
    const scoped = request as Extract<SearchIndexRequest, { scope: string }>;
    if (
      typeof scoped.scope !== "string" ||
      !scoped.scope.length ||
      scoped.scope.length > 512 ||
      /[\x00-\x1f]/.test(scoped.scope)
    )
      throw new Error("Invalid search scope");
    if (
      scoped.operation !== "invalidate" &&
      (typeof scoped.scanId !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(scoped.scanId))
    )
      throw new Error("Invalid search scan");
    if (scoped.operation === "invalidate") return { ...partition, operation: "invalidate", scope: scoped.scope };
    const scan = { ...partition, scope: scoped.scope, scanId: scoped.scanId };
    return scoped.operation === "append"
      ? { ...scan, operation: "append", documents: projectSearchDocuments(scoped.documents) }
      : { ...scan, operation: scoped.operation };
  }
  if (request.operation === "query") {
    if (
      typeof request.query !== "string" ||
      request.query.length > 300 ||
      (request.limit !== undefined &&
        (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1000)) ||
      (request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0)) ||
      (request.kind !== undefined && !/^[a-zA-Z0-9_.:-]{1,253}$/.test(request.kind)) ||
      (request.namespace !== undefined && !/^[a-zA-Z0-9_.:-]{0,253}$/.test(request.namespace))
    )
      throw new Error("Invalid search query");
    return {
      ...partition,
      operation: "query",
      query: request.query,
      limit: request.limit,
      offset: request.offset,
      kind: request.kind,
      namespace: request.namespace,
    };
  }
  if (request.operation !== "status" && request.operation !== "clear" && request.operation !== "permit")
    throw new Error("Invalid search operation");
  return { ...partition, operation: request.operation };
}

export function startResourceSearchIndex(): () => void {
  let active = true;
  let worker: ResourceSearchWorker | undefined;
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  const stopPreference = reaction(
    () => preferences.resourceSearchEnabled,
    (enabled) => {
      if (!enabled) {
        worker?.close();
        worker = undefined;
      }
    },
  );
  const nextRequest = new Map<string, number>();
  const waits = new Map<ReturnType<typeof setTimeout>, () => void>();
  const contextFingerprint = (request: SearchIndexRequest) => {
    const cluster = Main.Catalog.getClusterById(request.clusterId);
    if (!cluster) throw new Error("Unknown search cluster");
    // only a digest of the local configuration reaches the database partition key
    return createHash("sha256")
      .update(request.contextId)
      .update("\0")
      .update(cluster.contextName)
      .update("\0")
      .update(cluster.kubeConfigPath)
      .update("\0")
      .update(readFileSync(cluster.kubeConfigPath))
      .digest("hex");
  };
  ipcMain.handle(RESOURCE_SEARCH_CHANNEL, async (event, input: unknown) => {
    const request = validateSearchRequest(input);
    if (!active || !trustedSearchSender(event, request.clusterId)) throw new Error("Search index unavailable");
    const contextId = contextFingerprint(request);
    if (request.operation === "permit") {
      const start = Math.max(Date.now(), nextRequest.get(request.clusterId) ?? 0);
      nextRequest.set(request.clusterId, start + 500);
      if (start > Date.now())
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waits.delete(timer);
            resolve();
          }, start - Date.now());
          waits.set(timer, resolve);
        });
      if (!active || !trustedSearchSender(event, request.clusterId) || contextFingerprint(request) !== contextId)
        throw new Error("Search context changed");
      return true;
    }
    if (!preferences.resourceSearchEnabled) throw new Error("Resource search is disabled");
    if (!worker) {
      const directory = join(app.getPath("userData"), "freelens-power-search");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      worker = new ResourceSearchWorker(join(directory, "resources.sqlite"));
    }
    const result = await worker.call({ ...request, contextId });
    if (
      !active ||
      !preferences.resourceSearchEnabled ||
      !trustedSearchSender(event, request.clusterId) ||
      contextFingerprint(request) !== contextId
    )
      throw new Error("Search context changed");
    return result;
  });
  return () => {
    active = false;
    stopPreference();
    ipcMain.removeHandler(RESOURCE_SEARCH_CHANNEL);
    for (const [timer, resolve] of waits) {
      clearTimeout(timer);
      resolve();
    }
    waits.clear();
    nextRequest.clear();
    worker?.close();
    worker = undefined;
  };
}
