import type { AiResourceReference } from "./ai-extras";

export type AiProvider = "codex" | "claude";

export interface AiReadActivity {
  method: "pods" | "nodes" | "resources" | "logs";
  status: "ok" | "unavailable";
}

export interface AiChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AiChatRequest {
  provider?: AiProvider;
  terminalSnapshot?: import("./ai-terminal-context").AiTerminalSnapshot;
  requestId?: string;
  messages: AiChatMessage[];
  context: {
    clusterId?: string;
    screen?: string;
    resource?: { kind?: string; namespace?: string; name?: string };
  };
  systemPrompt?: string;
  reasoningEffort?: string;
  model: string;
  speed: "default" | "fast";
}

export interface AiChatResponse {
  references?: AiResourceReference[];
  provider?: AiProvider;
  text: string;
  reads?: AiReadActivity[];
}

export const AI_CHAT_CHANNEL = "freelens-power:ai-chat";

export type AiFailureCode =
  | "CLI_FAILURE"
  | "INVALID_REPLY"
  | "READ_LIMIT"
  | "TIMEOUT"
  | "CANCELLED"
  | "INPUT_LIMIT"
  | "UNAVAILABLE"
  | "UNSAFE_POLICY";

export interface AiReadActivityEvent {
  requestId: string;
  method: AiReadActivity["method"];
  status: "reading" | "ok" | "unavailable";
}

export const AI_READ_ACTIVITY_CHANNEL = "freelens-power:ai-read-activity";

export interface AiProgressEvent {
  requestId: string;
  phase: "model" | "reading" | "answer";
  elapsedMs: number;
  round: number;
  text?: string;
}

export const AI_PROGRESS_CHANNEL = "freelens-power:ai-progress";

export function validAiRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}
