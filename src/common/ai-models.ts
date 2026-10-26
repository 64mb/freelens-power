export const AI_MODELS_CHANNEL = "freelens-power:ai-models";
export const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export interface AiModel {
  id: string;
  label: string;
  defaultReasoningEffort: string;
  reasoningEfforts: string[];
}
