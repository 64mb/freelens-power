import { Common } from "@freelensapp/extensions";
import { action, makeObservable, observable } from "mobx";
import { type AiShortcut, DEFAULT_AI_SHORTCUTS, sanitizeAiShortcuts, upgradeDefaultAiShortcuts } from "../ai-shortcuts";

export interface AiShortcutsModel {
  shortcuts: AiShortcut[];
}

export class AiShortcutsStore extends Common.Store.ExtensionStore<AiShortcutsModel> {
  shortcuts = DEFAULT_AI_SHORTCUTS.map((entry) => ({ ...entry }));

  constructor() {
    super({ configName: "ai-shortcuts", defaults: { shortcuts: DEFAULT_AI_SHORTCUTS } });
    makeObservable(this, { shortcuts: observable, fromStore: action, upsertShortcut: action, removeShortcut: action });
  }

  fromStore(data: Partial<AiShortcutsModel>): void {
    this.shortcuts =
      data?.shortcuts === undefined
        ? DEFAULT_AI_SHORTCUTS.map((entry) => ({ ...entry }))
        : upgradeDefaultAiShortcuts(sanitizeAiShortcuts(data.shortcuts));
  }

  upsertShortcut(shortcut: AiShortcut): boolean {
    const normalized = sanitizeAiShortcuts([shortcut])[0];
    if (
      !normalized ||
      this.shortcuts.some((entry) => entry.id !== normalized.id && entry.command === normalized.command)
    )
      return false;
    const index = this.shortcuts.findIndex((entry) => entry.id === normalized.id);
    if (index < 0) this.shortcuts.push(normalized);
    else this.shortcuts[index] = normalized;
    return true;
  }

  removeShortcut(id: string): void {
    this.shortcuts = this.shortcuts.filter((entry) => entry.id !== id);
  }

  toJSON(): AiShortcutsModel {
    return { shortcuts: sanitizeAiShortcuts(this.shortcuts) };
  }
}
