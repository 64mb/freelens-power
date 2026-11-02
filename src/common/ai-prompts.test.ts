import { expect, it } from "vitest";
import {
  DEFAULT_AI_CLUSTER_PROMPT,
  DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_AI_CLUSTER_PROMPT,
  LEGACY_AI_SYSTEM_PROMPT,
  PREVIOUS_AI_CLUSTER_PROMPT,
  PREVIOUS_AI_SYSTEM_PROMPT,
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

it("upgrades the previous bundled defaults without replacing custom instructions or other fields", () => {
  expect(upgradeBundledAiPrompt(PREVIOUS_AI_SYSTEM_PROMPT, "systemPrompt")).toBe(DEFAULT_AI_SYSTEM_PROMPT);
  expect(upgradeBundledAiPrompt(PREVIOUS_AI_CLUSTER_PROMPT, "clusterPrompt")).toBe(DEFAULT_AI_CLUSTER_PROMPT);
  for (const [field, previous, current] of [
    ["systemPrompt", PREVIOUS_AI_SYSTEM_PROMPT, DEFAULT_AI_SYSTEM_PROMPT],
    ["clusterPrompt", PREVIOUS_AI_CLUSTER_PROMPT, DEFAULT_AI_CLUSTER_PROMPT],
  ] as const) {
    const customized = `${previous}\nUse my preferred format`;
    expect(upgradeBundledAiPrompt(customized, field)).toBe(customized);
    expect(upgradeBundledAiPrompt(current, field)).toBe(current);
  }
  expect(upgradeBundledAiPrompt(PREVIOUS_AI_SYSTEM_PROMPT, "clusterPrompt")).toBe(PREVIOUS_AI_SYSTEM_PROMPT);
  expect(upgradeBundledAiPrompt(PREVIOUS_AI_CLUSTER_PROMPT, "systemPrompt")).toBe(PREVIOUS_AI_CLUSTER_PROMPT);
});
