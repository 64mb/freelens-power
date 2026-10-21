import { Common } from "@freelensapp/extensions";
import { action, makeObservable, observable } from "mobx";
import { DEFAULT_AI_CLUSTER_PROMPT, DEFAULT_AI_SYSTEM_PROMPT } from "../ai-prompts";

export interface AiMessage {
  role: "user" | "assistant";
  text: string;
}
export interface AiPreferencesModel {
  enabled: boolean;
  systemPrompt: string;
  clusterPrompt: string;
  model: string;
  reasoningEffort: string;
  speed: "default" | "fast";
  chatFontSize: number;
  conversations: Record<string, AiMessage[]>;
}

export class AiPreferencesStore extends Common.Store.ExtensionStore<AiPreferencesModel> {
  enabled = false;
  systemPrompt = DEFAULT_AI_SYSTEM_PROMPT;
  clusterPrompt = DEFAULT_AI_CLUSTER_PROMPT;
  model = "";
  reasoningEffort = "";
  speed: "default" | "fast" = "default";
  chatFontSize = 14;
  conversations: Record<string, AiMessage[]> = {};

  constructor() {
    super({
      configName: "ai-preferences",
      defaults: {
        enabled: false,
        systemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
        clusterPrompt: DEFAULT_AI_CLUSTER_PROMPT,
        model: "",
        reasoningEffort: "",
        speed: "default",
        chatFontSize: 14,
        conversations: {},
      },
    });
    makeObservable(this, {
      enabled: observable,
      systemPrompt: observable,
      clusterPrompt: observable,
      model: observable,
      reasoningEffort: observable,
      speed: observable,
      chatFontSize: observable,
      conversations: observable,
      fromStore: action,
      setMessages: action,
    });
  }

  fromStore(data: Partial<AiPreferencesModel>): void {
    this.enabled = data?.enabled === true;
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

  setMessages(key: string, messages: AiMessage[]): void {
    this.conversations = { ...this.conversations, [key]: messages.map(({ role, text }) => ({ role, text })) };
  }

  toJSON(): AiPreferencesModel {
    return {
      enabled: this.enabled,
      systemPrompt: this.systemPrompt,
      clusterPrompt: this.clusterPrompt,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      speed: this.speed,
      chatFontSize: this.chatFontSize,
      conversations: JSON.parse(JSON.stringify(this.conversations)),
    };
  }
}
