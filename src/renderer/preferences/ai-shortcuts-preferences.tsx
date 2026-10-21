import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { useState } from "react";
import { AiShortcutsStore } from "../../common/store/ai-shortcuts-store";
import { SettingsIconAction } from "./settings-icon-action";
import { SettingsField, SettingsModal } from "./settings-modal";

import type { AiShortcut } from "../../common/ai-shortcuts";

const { Button, Input } = Renderer.Component;

export const AiShortcutsPreferences = observer(({ disabled = false }: { disabled?: boolean }) => {
  const preferences = AiShortcutsStore.getInstanceOrCreate<AiShortcutsStore>();
  const [editing, setEditing] = useState<AiShortcut | null>(null);
  const [error, setError] = useState("");
  const edit = (shortcut: AiShortcut) => {
    setEditing({ ...shortcut });
    setError("");
  };
  const close = () => {
    setEditing(null);
    setError("");
  };
  return (
    <div>
      <div className="power-ai-section-title">Prompt shortcuts</div>
      <div className="power-settings-hint">Launch a prompt from a new chat or type /command before sending.</div>
      {preferences.shortcuts.map((shortcut) => (
        <div key={shortcut.id} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            <div>{shortcut.label}</div>
            <div className="power-settings-hint" style={{ marginTop: 3, fontSize: 11 }}>
              /{shortcut.command}
            </div>
          </div>
          <SettingsIconAction
            material="edit"
            disabled={disabled}
            label={`Edit ${shortcut.label}`}
            onClick={() => edit(shortcut)}
          />
          <SettingsIconAction
            material="delete_outline"
            disabled={disabled}
            label={`Remove ${shortcut.label}`}
            onClick={() => preferences.removeShortcut(shortcut.id)}
          />
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <Button
          primary
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          disabled={disabled}
          onClick={() => edit({ id: globalThis.crypto.randomUUID(), label: "", command: "", prompt: "" })}
        >
          <Renderer.Component.Icon material="add" size={16} />
          <span>Add shortcut</span>
        </Button>
      </div>
      {editing && !disabled && (
        <SettingsModal
          id="power-ai-shortcut-editor"
          title={
            preferences.shortcuts.some((shortcut) => shortcut.id === editing.id) ? "Edit shortcut" : "Add a shortcut"
          }
          onClose={close}
        >
          <SettingsField id="power-ai-shortcut-label" label="Label">
            <Input
              autoFocus
              id="power-ai-shortcut-label"
              aria-label="Shortcut label"
              placeholder="Label"
              value={editing.label}
              maxLength={80}
              onChange={(label) => setEditing({ ...editing, label })}
            />
          </SettingsField>
          <SettingsField id="power-ai-shortcut-command" label="Command">
            <Input
              id="power-ai-shortcut-command"
              aria-label="Shortcut command"
              placeholder="/command"
              value={editing.command}
              maxLength={33}
              onChange={(command) => setEditing({ ...editing, command })}
            />
          </SettingsField>
          <div>
            <label htmlFor="power-ai-shortcut-prompt">Prompt</label>
            <textarea
              id="power-ai-shortcut-prompt"
              aria-label="Shortcut prompt"
              className="power-ai-prompt"
              placeholder="Prompt"
              value={editing.prompt}
              maxLength={10000}
              onChange={(event) => setEditing({ ...editing, prompt: event.target.value })}
              style={{ marginTop: 8 }}
            />
          </div>
          {error && <div role="alert">{error}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
            <Button label="Cancel" onClick={close} />
            <Button
              primary
              label="Save shortcut"
              onClick={() => {
                if (preferences.upsertShortcut(editing)) close();
                else
                  setError(
                    "Enter a label, prompt and unique command using 1–32 letters, numbers, hyphens or underscores.",
                  );
              }}
            />
          </div>
        </SettingsModal>
      )}
    </div>
  );
});
