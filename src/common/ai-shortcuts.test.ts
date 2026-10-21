import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SHORTCUTS, expandAiShortcut, sanitizeAiShortcuts } from "./ai-shortcuts";
import { AiShortcutsStore } from "./store/ai-shortcuts-store";

vi.mock("@freelensapp/extensions", () => ({ Common: { Store: { ExtensionStore: class {} } } }));
const shortcut = { id: "stable", label: "Health", command: "health", prompt: "Inspect health." };

describe("AI shortcuts", () => {
  it("normalizes commands and drops unknown fields and invalid entries", () => {
    expect(
      sanitizeAiShortcuts([
        { ...shortcut, command: " /HEALTH ", tool: "exec", endpoint: "private" },
        null,
        { ...shortcut, id: "other" },
        { ...shortcut, id: "invalid", command: "bad command" },
      ]),
    ).toEqual([shortcut]);
    expect(sanitizeAiShortcuts({ shortcuts: [shortcut] })).toEqual([]);
    expect(sanitizeAiShortcuts([{ ...shortcut, prompt: "x".repeat(10001) }])).toEqual([]);
  });
  it("preserves IDs and order when editing, rejects duplicate commands and persists removal", () => {
    const store = new AiShortcutsStore();
    store.fromStore({ shortcuts: [] });
    expect(store.upsertShortcut(shortcut)).toBe(true);
    expect(store.upsertShortcut({ ...shortcut, id: "second", command: "pods" })).toBe(true);
    expect(store.upsertShortcut({ ...shortcut, label: "New label" })).toBe(true);
    expect(store.upsertShortcut({ ...shortcut, id: "third", command: "/HEALTH" })).toBe(false);
    expect(store.toJSON().shortcuts.map(({ id }) => id)).toEqual(["stable", "second"]);
    store.removeShortcut("stable");
    expect(store.toJSON().shortcuts.map(({ id }) => id)).toEqual(["second"]);
    store.fromStore({ shortcuts: [] });
    expect(store.shortcuts).toEqual([]);
  });
  it("upgrades unchanged built-in prompts while preserving custom edits, order and removals", () => {
    const store = new AiShortcutsStore();
    const original = {
      ...DEFAULT_AI_SHORTCUTS[0],
      prompt:
        "Inspect the current cluster health using read-only queries. Summarize warnings and suggest useful next checks without changing resources.",
    };
    const custom = { ...DEFAULT_AI_SHORTCUTS[1], prompt: "My custom investigation" };
    store.fromStore({ shortcuts: [custom, original] });
    expect(store.shortcuts).toEqual([custom, DEFAULT_AI_SHORTCUTS[0]]);
    store.fromStore({ shortcuts: [{ ...original, label: "My health shortcut" }] });
    expect(store.shortcuts[0].prompt).toBe(original.prompt);
    expect(DEFAULT_AI_SHORTCUTS).toHaveLength(3);
    expect(DEFAULT_AI_SHORTCUTS.every((entry) => !/in Russian/i.test(entry.prompt))).toBe(true);
  });
  it("expands only a complete leading command on explicit send", () => {
    expect(expandAiShortcut("/health", [shortcut])).toBe(shortcut.prompt);
    expect(expandAiShortcut("/HEALTH  focus on pods", [shortcut])).toBe("Inspect health.\n\nfocus on pods");
    for (const text of ["/healthier", "check /health", "/unknown", "/health; exec", " /health"])
      expect(expandAiShortcut(text, [shortcut])).toBe(text);
  });
});
