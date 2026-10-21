import { Common } from "@freelensapp/extensions";
import { action, makeObservable, observable } from "mobx";
import { type AiResourceReference, normalizeAiReferences } from "../ai-extras";
import { DEFAULT_AI_CLUSTER_PROMPT, DEFAULT_AI_SYSTEM_PROMPT } from "../ai-prompts";

import type { AiProvider } from "../ai";

export interface AiMessage {
  references?: AiResourceReference[];
  role: "user" | "assistant";
  text: string;
  provider?: AiProvider;
}
export interface AiPreferencesModel {
  enabled: boolean;
  provider: AiProvider;
  claudeModel: string;
  systemPrompt: string;
  clusterPrompt: string;
  model: string;
  reasoningEffort: string;
  speed: "default" | "fast";
  chatFontSize: number;
  chatPanelWidth: number;
  conversations: Record<string, AiMessage[]>;
}

export class AiPreferencesStore extends Common.Store.ExtensionStore<AiPreferencesModel> {
  enabled = false;
  provider: AiProvider = "codex";
  claudeModel = "";
  systemPrompt = DEFAULT_AI_SYSTEM_PROMPT;
  clusterPrompt = DEFAULT_AI_CLUSTER_PROMPT;
  model = "";
  reasoningEffort = "";
  speed: "default" | "fast" = "default";
  chatFontSize = 14;
  chatPanelWidth = 560;
  conversations: Record<string, AiMessage[]> = {};

  constructor() {
    super({
      configName: "ai-preferences",
      defaults: {
        enabled: false,
        provider: "codex",
        claudeModel: "",
        systemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
        clusterPrompt: DEFAULT_AI_CLUSTER_PROMPT,
        model: "",
        reasoningEffort: "",
        speed: "default",
        chatFontSize: 14,
        chatPanelWidth: 560,
        conversations: {},
      },
    });
    makeObservable(this, {
      enabled: observable,
      provider: observable,
      claudeModel: observable,
      systemPrompt: observable,
      clusterPrompt: observable,
      model: observable,
      reasoningEffort: observable,
      speed: observable,
      chatFontSize: observable,
      chatPanelWidth: observable,
      setChatPanelWidth: action,
      conversations: observable,
      fromStore: action,
      setMessages: action,
    });
  }

  fromStore(data: Partial<AiPreferencesModel>): void {
    this.enabled = data?.enabled === true;
    this.provider = data?.provider === "claude" ? "claude" : "codex";
    this.claudeModel = typeof data?.claudeModel === "string" ? data.claudeModel : "";
    if (typeof data?.systemPrompt === "string") this.systemPrompt = data.systemPrompt;
    if (typeof data?.clusterPrompt === "string") this.clusterPrompt = data.clusterPrompt;
    this.model = typeof data?.model === "string" ? data.model : "";
    this.reasoningEffort = typeof data?.reasoningEffort === "string" ? data.reasoningEffort : "";
    this.speed = data?.speed === "fast" ? "fast" : "default";
    this.chatFontSize =
      typeof data?.chatFontSize === "number" &&
      Number.isInteger(data.chatFontSize) &&
      data.chatFontSize >= 10 &&
      data.chatFontSize <= 24
        ? data.chatFontSize
        : 14;
    this.chatPanelWidth =
      typeof data?.chatPanelWidth === "number" && Number.isFinite(data.chatPanelWidth)
        ? Math.min(10000, Math.max(360, Math.round(data.chatPanelWidth)))
        : 560;
    this.conversations = {};
    if (data?.conversations && typeof data.conversations === "object") {
      for (const [key, messages] of Object.entries(data.conversations)) {
        if (Array.isArray(messages))
          this.setMessages(
            key,
            messages.filter(
              (message) =>
                message &&
                (message.role === "user" || message.role === "assistant") &&
                typeof message.text === "string",
            ),
          );
      }
    }
  }

  setChatPanelWidth(width: number): void {
    this.chatPanelWidth = Number.isFinite(width) ? Math.min(10000, Math.max(360, Math.round(width))) : 560;
  }

  setMessages(key: string, messages: AiMessage[]): void {
    this.conversations = {
      ...this.conversations,
      [key]: messages.map(({ role, text, provider, references }) => ({
        role,
        text,
        ...(provider === "claude" ? { provider } : {}),
        ...(role === "assistant" && normalizeAiReferences(references).length
          ? { references: normalizeAiReferences(references) }
          : {}),
      })),
    };
  }

  toJSON(): AiPreferencesModel {
    return {
      enabled: this.enabled,
      provider: this.provider,
      claudeModel: this.claudeModel,
      systemPrompt: this.systemPrompt,
      clusterPrompt: this.clusterPrompt,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      speed: this.speed,
      chatFontSize: this.chatFontSize,
      chatPanelWidth: this.chatPanelWidth,
      conversations: JSON.parse(JSON.stringify(this.conversations)),
    };
  }
}
