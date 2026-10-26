import { describe, expect, it, vi } from "vitest";

vi.mock("@freelensapp/extensions", () => ({ Common: { Store: { ExtensionStore: class {} } } }));

import { AiPreferencesStore } from "./store/ai-preferences-store";

describe("AI provider preferences", () => {
  it("keeps existing Codex settings and cluster history when migrating", () => {
    const store = new AiPreferencesStore();
    store.fromStore({
      model: "example-model",
      reasoningEffort: "high",
      speed: "fast",
      conversations: { "cluster-a": [{ role: "assistant", text: "Existing reply" }] },
    });
    expect(store.provider).toBe("codex");
    expect(store.model).toBe("example-model");
    expect(store.claudeReasoningEffort).toBe("");
    expect(store.claudeSpeed).toBe("default");
    store.provider = "claude";
    store.claudeModel = "sonnet";
    store.claudeReasoningEffort = "max";
    store.claudeSpeed = "fast";
    store.setMessages("cluster-b", [{ role: "assistant", text: "New reply", provider: "claude" }]);
    const restored = new AiPreferencesStore();
    restored.fromStore(store.toJSON());
    expect(restored.provider).toBe("claude");
    expect(restored.claudeModel).toBe("sonnet");
    expect(restored.claudeReasoningEffort).toBe("max");
    expect(restored.claudeSpeed).toBe("fast");
    expect(restored.model).toBe("example-model");
    expect(restored.reasoningEffort).toBe("high");
    expect(restored.speed).toBe("fast");
    expect(restored.conversations["cluster-a"]).toEqual([{ role: "assistant", text: "Existing reply" }]);
    expect(restored.conversations["cluster-b"][0].provider).toBe("claude");
  });

  it("preserves legacy Claude Fast without overriding an explicit provider speed", () => {
    const store = new AiPreferencesStore();
    store.fromStore({ provider: "claude", speed: "fast" });
    expect(store.claudeSpeed).toBe("fast");
    const migrated = store.toJSON();
    const restored = new AiPreferencesStore();
    restored.fromStore(migrated);
    expect(restored.claudeSpeed).toBe("fast");
    restored.fromStore({ ...migrated, claudeSpeed: "default" });
    expect(restored.claudeSpeed).toBe("default");
    expect(restored.speed).toBe("fast");
  });

  it("drops unsupported efforts and speeds per provider instead of failing every request", () => {
    const store = new AiPreferencesStore();
    store.fromStore({ reasoningEffort: "ultra", claudeReasoningEffort: "xhigh" });
    expect(store.reasoningEffort).toBe("ultra");
    expect(store.claudeReasoningEffort).toBe("xhigh");
    store.fromStore({
      reasoningEffort: "unknown",
      claudeReasoningEffort: "ultra",
      speed: "bogus",
      claudeSpeed: "bogus",
    } as unknown as Parameters<AiPreferencesStore["fromStore"]>[0]);
    expect(store.reasoningEffort).toBe("");
    expect(store.claudeReasoningEffort).toBe("");
    expect(store.speed).toBe("default");
    expect(store.claudeSpeed).toBe("default");
  });
});

it("restores bounded structural references for assistant history and keeps old history compatible", () => {
  const store = new AiPreferencesStore();
  const reference = {
    apiVersion: "v1",
    kind: "Pod",
    name: "worker",
    namespace: "default",
    url: "https://example.invalid",
  };
  store.fromStore({
    conversations: {
      "cluster-a": [
        { role: "assistant", text: "Existing answer" },
        { role: "assistant", text: "New answer", references: [reference, { ...reference, name: "../invalid" }] },
        { role: "user", text: "Question", references: [reference] },
      ],
    },
  });
  expect(store.toJSON().conversations["cluster-a"]).toEqual([
    { role: "assistant", text: "Existing answer" },
    {
      role: "assistant",
      text: "New answer",
      references: [{ apiVersion: "v1", kind: "Pod", name: "worker", namespace: "default" }],
    },
    { role: "user", text: "Question" },
  ]);
});

it("preserves a local panel width and defaults old or invalid settings safely", () => {
  const store = new AiPreferencesStore();
  store.fromStore({});
  expect(store.chatPanelWidth).toBe(560);
  store.setChatPanelWidth(740);
  const restored = new AiPreferencesStore();
  restored.fromStore(store.toJSON());
  expect(restored.chatPanelWidth).toBe(740);
  restored.fromStore({ chatPanelWidth: Number.NaN });
  expect(restored.chatPanelWidth).toBe(560);
  restored.setChatPanelWidth(20);
  expect(restored.chatPanelWidth).toBe(360);
});

it("persists sanitized attachment receipts only on user messages with copied snapshots", () => {
  const store = new AiPreferencesStore();
  const receipt = {
    kind: "evidence" as const,
    title: "Snapshot",
    text: '{"token":"[REDACTED]","state":"ready"}',
  };
  store.setMessages("cluster-a", [
    { role: "user", text: "Inspect", attachments: [receipt] },
    { role: "assistant", text: "Answer", attachments: [receipt] },
  ]);
  receipt.text = "Changed";
  const restored = new AiPreferencesStore();
  restored.fromStore(store.toJSON());
  const messages = restored.toJSON().conversations["cluster-a"];
  expect(messages[0].attachments?.[0].text).toContain('"state":"ready"');
  expect(messages[0].attachments?.[0].text).not.toContain("sample-sensitive");
  expect(messages[1]).not.toHaveProperty("attachments");
});
