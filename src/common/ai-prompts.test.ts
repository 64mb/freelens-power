import { expect, it } from "vitest";
import {
  DEFAULT_AI_CLUSTER_PROMPT,
  DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_AI_CLUSTER_PROMPT,
  LEGACY_AI_SYSTEM_PROMPT,
  upgradeBundledAiPrompt,
} from "./ai-prompts";

it("upgrades only exact bundled defaults and preserves manual prompt edits", () => {
  expect(upgradeBundledAiPrompt(LEGACY_AI_SYSTEM_PROMPT, "systemPrompt")).toBe(DEFAULT_AI_SYSTEM_PROMPT);
  expect(upgradeBundledAiPrompt(LEGACY_AI_CLUSTER_PROMPT, "clusterPrompt")).toBe(DEFAULT_AI_CLUSTER_PROMPT);
  const customized = `${LEGACY_AI_SYSTEM_PROMPT}\nMy manual instruction`;
  expect(upgradeBundledAiPrompt(customized, "systemPrompt")).toBe(customized);
  expect(upgradeBundledAiPrompt("", "systemPrompt")).toBe("");
});

it("preserves defaults manually copied into a different prompt field", () => {
  expect(upgradeBundledAiPrompt(LEGACY_AI_SYSTEM_PROMPT, "clusterPrompt")).toBe(LEGACY_AI_SYSTEM_PROMPT);
  expect(upgradeBundledAiPrompt(LEGACY_AI_CLUSTER_PROMPT, "systemPrompt")).toBe(LEGACY_AI_CLUSTER_PROMPT);
});
