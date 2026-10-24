import { randomUUID } from "node:crypto";
import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import { POWER_LOGS_CHANNEL, POWER_LOGS_LIMITS } from "../common/power-logs";
import { searchContextId } from "./resource-search-client";

import type { PowerLogsTransport } from "./power-logs-collector";
export function createPowerLogsTransport(clusterId: string): PowerLogsTransport {
  const host = window.location.host;
  if (
    window.location.protocol !== "https:" ||
    window.location.hostname !== `${clusterId}.renderer.freelens.app` ||
    Renderer.Catalog.activeCluster.get()?.metadata.uid !== clusterId
  )
    throw new Error("Log requests require the active cluster frame");
  const api = Renderer.K8sApi.KubeJsonApi.forCluster.call(undefined, clusterId);
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
    const streamId = path.endsWith("/log") ? randomUUID() : undefined;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let body: { destroy(): void } | null | undefined;
    const abort = () => {
      controller.abort();
      body?.destroy();
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
      const response = await api.getResponse(
        path,
        { query },
        { signal: controller.signal, headers: { Host: host }, size: 8 * 1048576 },
      );
      body = response.body;
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
      if (response.body)
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
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
      body?.destroy();
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    stream,
    async get<T>(path, query, signal): Promise<T> {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream(path, query ?? {}, signal)) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 8 * 1048576) throw new Error("Resource page exceeded the response budget");
        chunks.push(buffer);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
      } catch {
        throw new Error("Resource response could not be parsed");
      }
    },
  };
}
