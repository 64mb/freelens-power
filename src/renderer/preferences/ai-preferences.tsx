import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import { observer } from "mobx-react";
import { useEffect, useState } from "react";
import { AI_MODELS_CHANNEL, type AiModel } from "../../common/ai-models";
import { AiPreferencesStore } from "../../common/store/ai-preferences-store";
import { AiProviderIcon } from "../ai-provider-icon";
import { AiShortcutsPreferences } from "./ai-shortcuts-preferences";

const { Select, Switch } = Renderer.Component;

export const AiPreferences = observer(() => {
  const preferences = AiPreferencesStore.getInstanceOrCreate<AiPreferencesStore>();
  const [catalog, setCatalog] = useState<{ provider: string; models: AiModel[] }>({ provider: "", models: [] });
  const models = catalog.provider === preferences.provider ? catalog.models : [];
  useEffect(() => {
    if (!preferences.enabled) {
      setCatalog({ provider: preferences.provider, models: [] });
      return;
    }
    setCatalog({ provider: preferences.provider, models: [] });
    const provider = preferences.provider;
    let active = true;
    void ipcRenderer
      .invoke(AI_MODELS_CHANNEL, preferences.provider)
      .then((value: AiModel[]) => {
        if (active && Array.isArray(value)) setCatalog({ provider, models: value });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [preferences.enabled, preferences.provider]);
  const isClaude = preferences.provider === "claude";
  const providerLabel = isClaude ? "Claude" : "Codex";
  const currentModel = isClaude ? preferences.claudeModel : preferences.model;
  const selectedModel = JSON.stringify([currentModel, isClaude ? "" : preferences.reasoningEffort]);
  const modelOptions = [
    { value: JSON.stringify(["", ""]), label: `${providerLabel} default` },
    ...models.flatMap((model) => [
      { value: JSON.stringify([model.id, ""]), label: `${model.label} · Default` },
      ...model.reasoningEfforts.map((effort) => ({
        value: JSON.stringify([model.id, effort]),
        label: `${model.label} · ${effort}`,
      })),
    ]),
  ];
  if (!modelOptions.some((option) => option.value === selectedModel)) {
    modelOptions.push({
      value: selectedModel,
      label: `${currentModel || `${providerLabel} default`} · ${isClaude ? "Default" : preferences.reasoningEffort || "Default"}`,
    });
  }
  const controlStyle = { width: 220, maxWidth: "100%", flexShrink: 0 };
  const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <style>{`.power-ai-section-title { color: var(--textColorAccent); } .power-ai-prompt { width: 100%; min-height: 90px; max-height: 260px; field-sizing: content; overflow-y: auto; margin-top: 8px; box-sizing: border-box; padding: 12px; border: 1px solid var(--borderFaintColor, #666); border-radius: 8px; background: var(--mainBackground, #242424); color: var(--textColorPrimary, white); font: inherit; resize: none; } .power-ai-prompt:focus { border-color: var(--primary, #5896ff); outline: 1px solid var(--primary, #5896ff); }`}</style>
      <div>
        <Switch
          checked={preferences.enabled}
          onChange={(value) => {
            preferences.enabled = value;
          }}
        >
          Enable AI features
        </Switch>
        <div className="power-settings-hint">
          Turn off to hide the chat, AI button and Ask about cluster, and stop active requests. Settings and
          conversations are kept.
        </div>
      </div>
      <div className="power-settings-row" style={rowStyle}>
        <label htmlFor="power-ai-cli">CLI</label>
        <div style={controlStyle}>
          <Select
            id="power-ai-cli"
            value={preferences.provider}
            options={[
              { value: "codex", label: "Codex" },
              { value: "claude", label: "Claude" },
            ]}
            formatOptionLabel={(option) => (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <AiProviderIcon provider={option.value === "claude" ? "claude" : "codex"} />
                {option.label}
              </span>
            )}
            onChange={(option) => {
              if (option?.value === "codex" || option?.value === "claude") preferences.provider = option.value;
            }}
            isDisabled={!preferences.enabled}
            isClearable={false}
            isSearchable={false}
          />
        </div>
      </div>
      <div className="power-settings-row" style={rowStyle}>
        <div>
          <label htmlFor="power-ai-model">Model</label>
          <div className="power-settings-hint">
            {isClaude
              ? "Native Claude model aliases. Availability depends on your CLI account."
              : "Models and reasoning effort from the local Codex catalog."}
          </div>
        </div>
        <div style={controlStyle}>
          <Select
            id="power-ai-model"
            value={selectedModel}
            options={modelOptions}
            isDisabled={!preferences.enabled}
            isClearable={false}
            isSearchable={true}
            onChange={(option) => {
              if (!option) return;
              const [model, effort] = JSON.parse(option.value);
              if (isClaude) preferences.claudeModel = model;
              else {
                preferences.model = model;
                preferences.reasoningEffort = effort;
              }
            }}
          />
        </div>
      </div>
      {!isClaude && (
        <div className="power-settings-row" style={rowStyle}>
          <label htmlFor="power-ai-speed">Speed</label>
          <div style={controlStyle}>
            <Select
              id="power-ai-speed"
              value={preferences.speed}
              options={[
                { value: "default", label: "Default" },
                { value: "fast", label: "Fast" },
              ]}
              isDisabled={!preferences.enabled}
              isClearable={false}
              isSearchable={false}
              onChange={(option) => {
                if (option) preferences.speed = option.value as "default" | "fast";
              }}
            />
          </div>
        </div>
      )}
      <div className="power-settings-row" style={rowStyle}>
        <div>
          <label htmlFor="power-ai-font-size">Chat font size</label>
          <div className="power-settings-hint">Messages and input, in pixels (10–24).</div>
        </div>
        <div style={controlStyle}>
          <Select
            id="power-ai-font-size"
            value={preferences.chatFontSize}
            options={Array.from({ length: 15 }, (_, index) => ({ value: index + 10, label: `${index + 10} px` }))}
            isDisabled={!preferences.enabled}
            isSearchable={false}
            isClearable={false}
            onChange={(option) => {
              if (option) preferences.chatFontSize = option.value;
            }}
          />
        </div>
      </div>
      <div>
        <label className="power-ai-section-title" htmlFor="power-ai-system-prompt">
          System prompt
        </label>
        <textarea
          id="power-ai-system-prompt"
          className="power-ai-prompt"
          disabled={!preferences.enabled}
          value={preferences.systemPrompt}
          onChange={(event) => {
            preferences.systemPrompt = event.target.value;
          }}
        />
      </div>
      <div>
        <label className="power-ai-section-title" htmlFor="power-ai-cluster-prompt">
          Cluster prompt
        </label>
        <div className="power-settings-hint">Additional instructions attached to cluster conversations.</div>
        <textarea
          id="power-ai-cluster-prompt"
          className="power-ai-prompt"
          disabled={!preferences.enabled}
          value={preferences.clusterPrompt}
          onChange={(event) => {
            preferences.clusterPrompt = event.target.value;
          }}
        />
      </div>
      <AiShortcutsPreferences disabled={!preferences.enabled} />
    </div>
  );
});
