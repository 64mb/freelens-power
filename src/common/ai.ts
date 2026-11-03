import type { AiResourceReference } from "./ai-extras";

export type AiProvider = "codex" | "codex-api" | "claude" | "pi";
export type AiApiServiceTier = "default" | "fast" | "ultrafast";

export interface AiReadActivity {
  method: "pods" | "nodes" | "resources" | "logs" | "dashboard";
  status: "ok" | "unavailable";
}

export interface AiChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AiChatRequest {
  provider?: AiProvider;
  apiWebSocket?: boolean;
  apiServiceTier?: AiApiServiceTier;
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
  | "API_AUTHENTICATION"
  | "API_RATE_LIMIT"
  | "API_FAILURE"
  | "API_MODEL_UNAVAILABLE"
  | "API_OPTION_UNSUPPORTED"
  | "API_REASONING_MODE_UNSUPPORTED"
  | "API_REASONING_EFFORT_UNSUPPORTED"
  | "API_VERBOSITY_UNSUPPORTED"
  | "API_TOOLS_UNSUPPORTED"
  | "API_SERVICE_TIER"
  | "API_QUOTA"
  | "API_NETWORK"
  | "API_STREAM_INTERRUPTED"
  | "API_TLS"
  | "API_PERMISSION"
  | "API_REGION_UNSUPPORTED"
  | "API_REQUEST_REJECTED"
  | "API_SERVER_UNAVAILABLE"
  | "API_SESSION_EXPIRED"
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

export interface AiApiKeyStatus {
  configured: boolean;
  available: boolean;
}

export const AI_API_KEY_STATUS_CHANNEL = "freelens-power:ai-api-key-status";
export const AI_API_KEY_SET_CHANNEL = "freelens-power:ai-api-key-set";
