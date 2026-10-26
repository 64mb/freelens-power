import { observer } from "mobx-react";
import { AiShortcutsStore } from "../common/store/ai-shortcuts-store";
import { AiIcon } from "./ai-icon";
import { NativeTooltip } from "./native-tooltip";

export const AiStarterPrompts = observer(
  ({ onSelect, disabled = false }: { onSelect: (prompt: string) => void; disabled?: boolean }) => {
    const preferences = AiShortcutsStore.getInstanceOrCreate<AiShortcutsStore>();
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
        {preferences.shortcuts.map((shortcut) => (
          <NativeTooltip key={shortcut.id} title={`Insert /${shortcut.command}: ${shortcut.label}`}>
            <button
              type="button"
              className="Button"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                justifyContent: "flex-start",
                padding: "6px 10px",
                minHeight: 32,
              }}
              disabled={disabled}
              onClick={() => onSelect(shortcut.prompt)}
            >
              <AiIcon
                material={
                  ({ health: "favorite_border", pods: "view_module", logs: "subject" } as Record<string, string>)[
                    shortcut.command
                  ] ?? "chat_bubble_outline"
                }
              />
              {shortcut.label}
            </button>
          </NativeTooltip>
        ))}
      </div>
    );
  },
);
