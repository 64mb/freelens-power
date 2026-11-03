import { expect, it, vi } from "vitest";

vi.mock("@freelensapp/extensions", () => ({ Common: { Store: { ExtensionStore: class {} } } }));

import { AiPreferencesStore } from "./ai-preferences-store";

it("retains existing CLI preferences while separately roundtripping the API provider and conversations", () => {
  const store = new AiPreferencesStore();
  store.fromStore({
    provider: "codex-api",
    model: "local-cli-model",
    reasoningEffort: "ultra",
    codexApiModel: "gpt-6.1-sol",
    codexApiReasoningEffort: "max",
    codexApiServiceTier: "ultrafast",
    conversations: { example: [{ role: "assistant", text: "Ready", provider: "codex-api" }] },
  });
  expect(store.toJSON()).toMatchObject({
    provider: "codex-api",
    model: "local-cli-model",
    reasoningEffort: "ultra",
    codexApiModel: "gpt-6.1-sol",
    codexApiReasoningEffort: "max",
    codexApiServiceTier: "ultrafast",
    conversations: { example: [{ role: "assistant", text: "Ready", provider: "codex-api" }] },
  });
  const restored = new AiPreferencesStore();
  restored.fromStore(store.toJSON());
  expect(restored.toJSON()).toEqual(store.toJSON());
});

it("keeps keys outside normal settings and restores API defaults for older preferences", () => {
  const store = new AiPreferencesStore();
  store.fromStore({
    provider: "codex-api",
    codexApiReasoningEffort: "ultra",
    apiKey: "sk-example-not-real-123456789",
  } as any);
  expect(store.codexApiReasoningEffort).toBe("");
  expect(store.codexApiServiceTier).toBe("default");
  expect(JSON.stringify(store.toJSON())).not.toContain("sk-example");
  expect(JSON.stringify(store.toJSON())).not.toContain("apiKey");
  store.fromStore({ model: "local-cli-model" });
  expect(store.provider).toBe("codex");
  expect(store.model).toBe("local-cli-model");
  expect(store.codexApiModel).toBe("");
  expect(store.codexApiReasoningEffort).toBe("");
});
