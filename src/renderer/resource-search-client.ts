import { createHash } from "node:crypto";
import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import {
  RESOURCE_SEARCH_CHANNEL,
  type SearchDocument,
  type SearchIndexStatus,
  type SearchQueryResult,
} from "../common/resource-search";

import type { SearchTransport } from "./resource-search-discovery";
import type { SearchSink } from "./resource-search-sync";

export function createResourceSearchTransport(
  clusterId: string,
  signal?: AbortSignal,
  options: { timeoutMs?: number } = {},
): SearchTransport {
  const frameHost = window.location.host;
  if (
    window.location.protocol !== "https:" ||
    window.location.hostname !== `${clusterId}.renderer.freelens.app` ||
    Renderer.Catalog.activeCluster.get()?.metadata.uid !== clusterId
  )
    throw new Error("Resource requests require the active cluster frame");
  const api = Renderer.K8sApi.KubeJsonApi.forCluster.call(undefined, clusterId);
  return {
    get: async <T>(path: string, query?: Record<string, string | number>, headers?: Record<string, string>) => {
      if (signal?.aborted) throw new Error("Resource request canceled");
      await ipcRenderer.invoke(RESOURCE_SEARCH_CHANNEL, {
        operation: "permit",
        clusterId,
        contextId: searchContextId(),
      });
      if (signal?.aborted) throw new Error("Resource request canceled");
      const requestHeaders = {
        ...Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== "host")),
        Host: frameHost,
      };
      const controller = new AbortController();
      let timedOut = false;
      let responseBody: { destroy(): void } | null | undefined;
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      let rejectAbort!: (error: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () => {
        responseBody?.destroy();
        rejectAbort(
          timedOut
            ? Object.assign(new Error("Resource request timed out"), { timedOut: true })
            : new Error("Resource request canceled"),
        );
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? 30000);
      const request = async (): Promise<T> => {
        const response = await api.getResponse(
          path,
          { query },
          { signal: controller.signal, headers: requestHeaders, ...{ size: 4 * 1024 * 1024 } },
        );
        if (controller.signal.aborted) {
          response.body?.destroy();
          throw new Error("Resource request canceled");
        }
        responseBody = response.body;
        if (!response.ok) {
          const error = Object.assign(new Error(`Resource API returned ${response.status}`), {
            status: response.status,
            retryAfter: response.headers.get("retry-after"),
          });
          response.body?.destroy();
          throw error;
        }
        try {
          return JSON.parse(await response.text()) as T;
        } catch (error) {
          if ((error as { type?: string }).type === "max-size")
            throw Object.assign(new Error("Resource page exceeded the response budget"), { oversized: true });
          throw new Error("Resource response could not be parsed");
        }
      };
      try {
        return await Promise.race([request(), aborted]);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
export function searchContextId(): string {
  const cluster = Renderer.Catalog.activeCluster.get();
  return createHash("sha256")
    .update(JSON.stringify([cluster?.metadata.uid, cluster?.spec?.kubeconfigContext]))
    .digest("hex");
}
export function createResourceSearchClient(
  clusterId: string,
  contextId: string,
): SearchSink & {
  query(query: string, limit?: number, filters?: { kind?: string; namespace?: string }): Promise<SearchQueryResult>;
  clear(): Promise<unknown>;
  status(): Promise<SearchIndexStatus>;
} {
  const invoke = (operation: string, data: object = {}) =>
    ipcRenderer.invoke(RESOURCE_SEARCH_CHANNEL, { clusterId, contextId, operation, ...data });
  return {
    begin: (scope, scanId) => invoke("begin", { scope, scanId }),
    append: (scope, scanId, documents: SearchDocument[]) => invoke("append", { scope, scanId, documents }),
    complete: (scope, scanId) => invoke("complete", { scope, scanId }),
    invalidate: (scope) => invoke("invalidate", { scope }),
    reconcile: (resources) => invoke("reconcile", { resources }),
    query: (query, limit = 100, filters = {}) => invoke("query", { query, limit, ...filters }),
    clear: () => invoke("clear"),
    status: () => invoke("status"),
  };
}
