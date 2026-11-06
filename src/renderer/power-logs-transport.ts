import { Renderer } from "@freelensapp/extensions";
import { POWER_LOGS_CHANNEL, POWER_LOGS_LIMITS } from "../common/power-logs";
import { ipcRenderer } from "./ipc";
import { searchContextId } from "./resource-search-client";

import type { LogQuery, PowerLogsTransport } from "./power-logs-collector";
export function createPowerLogsTransport(clusterId: string): PowerLogsTransport {
  if (
    window.location.protocol !== "https:" ||
    window.location.hostname !== `${clusterId}.renderer.freelens.app` ||
    Renderer.Catalog.activeCluster.get()?.metadata.uid !== clusterId
  )
    throw new Error("Log requests require the active cluster frame");
  const api = Renderer.K8sApi.KubeJsonApi.forCluster(clusterId);
  const contextId = searchContextId();
  const invoke = (fields: object) => ipcRenderer.invoke(POWER_LOGS_CHANNEL, { ...fields, clusterId, contextId });
  const controlled = async (fields: object, signal: AbortSignal) => {
    if (signal.aborted) throw new Error("Log request canceled");
    let abort!: () => void;
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Log request canceled"));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([invoke(fields), canceled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  const stream: PowerLogsTransport["stream"] = async function* (path, query, signal, onOpen) {
    if (signal?.aborted) throw new Error("Log request canceled");
    const controller = new AbortController();
    const streamId = path.endsWith("/log") ? globalThis.crypto.randomUUID() : undefined;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let body: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => {
      controller.abort();
      void body?.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, query.follow ? 60 * 60 * 1000 : 30000);
    try {
      if (streamId) {
        await controlled({ operation: "stream-open", streamId, follow: query.follow === true }, controller.signal);
        renewal = setInterval(() => {
          void invoke({ operation: "stream-renew", streamId }).catch(abort);
        }, 10000);
      }
      await controlled({ operation: "permit", lane: "start" }, controller.signal);
      if (
        controller.signal.aborted ||
        searchContextId() !== contextId ||
        Renderer.Catalog.activeCluster.get()?.metadata.uid !== clusterId
      )
        throw new Error("Log context changed");
      const response = await api.getResponse(path, { query }, { signal: controller.signal });
      body = response.body?.getReader();
      if (signal?.aborted) {
        abort();
        throw new Error("Log request canceled");
      }
      if (!response.ok)
        throw Object.assign(new Error("Log API request failed"), {
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
        });
      onOpen?.();
      if (body)
        for (;;) {
          const next = await body.read();
          if (next.done) break;
          const chunk = next.value;
          if (signal?.aborted) throw new Error("Log request canceled");
          for (let offset = 0; offset < chunk.byteLength; offset += POWER_LOGS_LIMITS.batchBytes) {
            const part = chunk.subarray(offset, offset + POWER_LOGS_LIMITS.batchBytes);
            await controlled({ operation: "permit", lane: "bytes", bytes: part.byteLength }, controller.signal);
            if (
              controller.signal.aborted ||
              searchContextId() !== contextId ||
              Renderer.Catalog.activeCluster.get()?.metadata.uid !== clusterId
            )
              throw new Error("Log context changed");
            yield part;
          }
        }
    } finally {
      clearTimeout(timeout);
      clearInterval(renewal);
      if (streamId) void invoke({ operation: "stream-close", streamId }).catch(() => {});
      void body?.cancel().catch(() => {});
      body?.releaseLock();
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    stream,
    async get<T>(path: string, query?: LogQuery, signal?: AbortSignal): Promise<T> {
      const decoder = new TextDecoder();
      let text = "";
      let size = 0;
      for await (const chunk of stream(path, query ?? {}, signal)) {
        size += typeof chunk === "string" ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength;
        if (size > 8 * 1048576) throw new Error("Resource page exceeded the response budget");
        text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      }
      try {
        return JSON.parse(text + decoder.decode()) as T;
      } catch {
        throw new Error("Resource response could not be parsed");
      }
    },
  };
}
