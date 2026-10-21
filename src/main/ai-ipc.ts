import { Common, Main } from "@freelensapp/extensions";
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import { reaction } from "mobx";
import { AI_CHAT_CHANNEL, AI_READ_ACTIVITY_CHANNEL, type AiChatRequest, validAiRequestId } from "../common/ai";
import { AI_CANCEL_CHANNEL } from "../common/ai-extras";
import { AiPreferencesStore } from "../common/store/ai-preferences-store";
import { aiFailureCode, runAiChat } from "./ai";
import { discoverAiResources } from "./ai-discovery";
import { aiReadPath } from "./ai-resources";

function trusted(event: IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) return false;
  try {
    const url = new URL(event.senderFrame?.url ?? "");
    return (
      url.protocol === "https:" &&
      (url.hostname === "renderer.freelens.app" || url.hostname.endsWith(".renderer.freelens.app"))
    );
  } catch {
    return false;
  }
}

export function startAiIpc(): () => void {
  const pending = new Map<number, AbortController>();
  const origins = new Map<number, { requestId?: string; frame: IpcMainInvokeEvent["senderFrame"]; url?: string }>();
  const abortAll = () => {
    for (const controller of pending.values()) controller.abort();
  };
  const stop = reaction(
    () => AiPreferencesStore.getInstanceOrCreate<AiPreferencesStore>().enabled,
    (enabled) => {
      if (!enabled) abortAll();
    },
  );
  ipcMain.handle(AI_CHAT_CHANNEL, async (event, request: AiChatRequest) => {
    const preferences = AiPreferencesStore.getInstanceOrCreate<AiPreferencesStore>();
    if (!trusted(event) || !preferences.enabled) throw new Error("AI assistant is disabled or unavailable");
    if (request?.requestId !== undefined && !validAiRequestId(request.requestId))
      throw new Error("Invalid AI request identifier");
    const frame = event.senderFrame;
    const frameUrl = frame?.url;
    if (pending.has(event.sender.id)) throw new Error("An AI request is already running");
    const controller = new AbortController();
    pending.set(event.sender.id, controller);
    origins.set(event.sender.id, { requestId: request.requestId, frame, url: frameUrl });
    const abort = () => controller.abort();
    event.sender.once("destroyed", abort);
    try {
      const response = await runAiChat(
        {
          ...request,
          provider: preferences.provider ?? "codex",
          model: preferences.provider === "claude" ? preferences.claudeModel : preferences.model,
          speed: preferences.provider === "claude" ? "default" : preferences.speed,
          reasoningEffort: preferences.provider === "claude" ? "" : preferences.reasoningEffort,
          systemPrompt: [preferences.systemPrompt, request?.context?.clusterId ? preferences.clusterPrompt : ""]
            .filter(Boolean)
            .join("\n\n"),
        },
        (id) => {
          const cluster = Main.Catalog.getClusterById(id);
          if (!cluster) throw new Error("Select a registered cluster first");
          return {
            discover: async (signal) => {
              const api = Main.K8sApi.KubeJsonApi.forCluster.call(undefined, id);
              return discoverAiResources((path) => api.get(path, undefined, { signal }), signal);
            },
            readLogs: async (query, signal) => {
              // the host exposes [forCluster] through a non-callable legacy proxy whose methods remain callable
              const response = await Main.K8sApi.KubeJsonApi.forCluster
                .call(undefined, id)
                .getResponse(query.path, { query: query.query }, { signal });
              if (!response.ok) throw new Error("Log summary is unavailable");
              return response.text();
            },
            read: async (query) => {
              if (controller.signal.aborted) throw new Error("AI request canceled");
              if (query.resource) {
                const api = Main.K8sApi.KubeJsonApi.forCluster.call(undefined, id);
                return api.get(aiReadPath(query), undefined, { signal: controller.signal });
              }
              return query.name
                ? Main.K8s.getResource(id, { ...query, name: query.name })
                : { items: await Main.K8s.queryCluster(id, query) };
            },
          };
        },
        controller.signal,
        (activity) => {
          if (
            !request.requestId ||
            controller.signal.aborted ||
            pending.get(event.sender.id) !== controller ||
            !preferences.enabled ||
            !frame ||
            frame.detached ||
            frame.url !== frameUrl ||
            !trusted(event)
          )
            return;
          try {
            frame.send(AI_READ_ACTIVITY_CHANNEL, { requestId: request.requestId, ...activity });
          } catch {
            /* the originating frame may have closed */
          }
        },
      );
      controller.signal.throwIfAborted();
      return response;
    } catch (failure) {
      const code = aiFailureCode(failure);
      Common.logger.warn("[Freelens Power AI] request failed", { code });
      throw new Error(`FREELENS_AI_${code}`);
    } finally {
      event.sender.removeListener("destroyed", abort);
      pending.delete(event.sender.id);
      origins.delete(event.sender.id);
    }
  });
  ipcMain.handle(AI_CANCEL_CHANNEL, (event, requestId: unknown) => {
    if (!trusted(event) || !validAiRequestId(requestId)) return false;
    const origin = origins.get(event.sender.id);
    if (
      !origin ||
      origin.requestId !== requestId ||
      origin.frame !== event.senderFrame ||
      !origin.frame ||
      origin.frame.detached ||
      origin.frame.url !== origin.url
    )
      return false;
    pending.get(event.sender.id)?.abort();
    return true;
  });
  return () => {
    stop();
    abortAll();
    ipcMain.removeHandler(AI_CHAT_CHANNEL);
    ipcMain.removeHandler(AI_CANCEL_CHANNEL);
  };
}
