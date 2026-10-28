export const AI_MODELS_CHANNEL = "freelens-power:ai-models";
export const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const PI_REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface AiModel {
  id: string;
  label: string;
  defaultReasoningEffort: string;
  reasoningEfforts: string[];
}

export function piModelLabel(id: string): string | undefined {
  const model = id.split("/").at(-1);
  if (model === "glm-5-3") return "GLM 5.3";
  if (model === "deepseek-v4-flash") return "DeepSeek V4 Flash";
  return undefined;
}

export function piModelEfforts(id: string): string[] {
  if (piModelLabel(id) === "DeepSeek V4 Flash") return ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (piModelLabel(id) === "GLM 5.3") return ["low", "high", "max"];
  return [];
}
