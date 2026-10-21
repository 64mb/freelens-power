export const AI_MODELS_CHANNEL = "freelens-power:ai-models";

export interface AiModel {
  id: string;
  label: string;
  defaultReasoningEffort: string;
  reasoningEfforts: string[];
}
