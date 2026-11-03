import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import { runInAction } from "mobx";
import { observer } from "mobx-react";
import { useEffect, useRef, useState } from "react";
import { AI_API_KEY_SET_CHANNEL, AI_API_KEY_STATUS_CHANNEL, type AiApiKeyStatus } from "../../common/ai";
import { AI_MODELS_CHANNEL, type AiModel, CODEX_API_MODELS, piModelLabel } from "../../common/ai-models";
import { AiPreferencesStore } from "../../common/store/ai-preferences-store";
import { AiProviderIcon } from "../ai-provider-icon";
import { AiShortcutsPreferences } from "./ai-shortcuts-preferences";

const { Button, Input, Select, Switch } = Renderer.Component;

type SelectOption = { value: string; label: string };

// keeps a saved value visible while the catalog loads or after the catalog drops it
function withCurrent(options: SelectOption[], value: string, label = value): SelectOption[] {
  return options.some((option) => option.value === value) ? options : [...options, { value, label }];
}

function effortLabel(value: string): string {
  if (value === "off") return "None";
  if (value === "xhigh") return "XHigh";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function effortsFor(models: AiModel[], id: string): string[] {
  return models.find((model) => model.id === id)?.reasoningEfforts ?? [];
}

function CodexApiKeyPreferences({ disabled }: { disabled: boolean }) {
  const [key, setKey] = useState("");
  const mounted = useRef(true);
  const [status, setStatus] = useState<AiApiKeyStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void ipcRenderer
      .invoke(AI_API_KEY_STATUS_CHANNEL)
      .then((value: AiApiKeyStatus) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setError("Unable to check secure key storage.");
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (disabled) setKey("");
  }, [disabled]);
  const save = async (value: string) => {
    setKey("");
    setBusy(true);
    setError("");
    try {
      const saved = await ipcRenderer.invoke(AI_API_KEY_SET_CHANNEL, value);
      if (mounted.current) setStatus(saved);
    } catch {
      if (mounted.current) setError("Unable to update the API key in secure storage.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div>
      <label htmlFor="power-ai-api-key">OpenAI API key</label>
      <div className="power-ai-key-controls">
        <div className="power-ai-key-input">
          <Input
            id="power-ai-api-key"
            aria-label="OpenAI API key"
            type="password"
            theme="round"
            autoComplete="off"
            spellCheck={false}
            value={key}
            disabled={disabled || busy || !status?.available}
            onChange={setKey}
            placeholder="Enter a new API key"
          />
        </div>
        <Button
          type="button"
          className="Button"
          disabled={disabled || busy || !status?.available || !key.trim()}
          onClick={() => {
            void save(key.trim());
          }}
        >
          Save key
        </Button>
        <Button
          type="button"
          className="Button"
          disabled={disabled || busy || !status?.available || !status.configured}
          onClick={() => {
            void save("");
          }}
        >
          Clear key
        </Button>
      </div>
      <div className="power-settings-hint">Requires a restricted API key with write access to Responses API.</div>
      <div className="power-settings-hint" role="status">
        {status
          ? !status.available
            ? "Secure key storage is unavailable. OpenAI API cannot be used."
            : status.configured
              ? "API key configured in secure storage."
              : "No API key configured."
          : "Checking secure key storage…"}
      </div>
      {error && <div role="alert">{error}</div>}
    </div>
  );
}

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
        if (!active || !Array.isArray(value)) return;
        setCatalog({ provider, models: value });
        if (provider === "pi" && preferences.provider === "pi" && value[0]?.id) {
          runInAction(() => {
            const selected =
              value.find((model) => model.id === preferences.piModel) ??
              value.find((model) => piModelLabel(model.id) === piModelLabel(preferences.piModel)) ??
              value[0];
            preferences.piModel = selected.id;
            if (!selected.reasoningEfforts.includes(preferences.piReasoningEffort)) preferences.piReasoningEffort = "";
          });
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [preferences.enabled, preferences.provider]);
  const isApi = preferences.provider === "codex-api";
  const isPi = preferences.provider === "pi";
  const isClaude = preferences.provider === "claude";
  const providerLabel = isApi ? "OpenAI API" : isPi ? "Pi" : isClaude ? "Claude" : "Codex";
  const currentModel = isApi
    ? preferences.codexApiModel || CODEX_API_MODELS[0].id
    : isPi
      ? preferences.piModel
      : isClaude
        ? preferences.claudeModel
        : preferences.model;
  const currentEffort = isApi
    ? preferences.codexApiReasoningEffort
    : isPi
      ? preferences.piReasoningEffort
      : isClaude
        ? preferences.claudeReasoningEffort
        : preferences.reasoningEffort;
  const currentSpeed = isApi ? preferences.codexApiServiceTier : isClaude ? preferences.claudeSpeed : preferences.speed;
  const modelOptions = withCurrent(
    [
      ...(!isPi && !isApi ? [{ value: "", label: `${providerLabel} default` }] : []),
      ...models.map((model) => ({ value: model.id, label: model.label })),
    ],
    currentModel,
    isPi ? (piModelLabel(currentModel) ?? "Select a configured Pi model") : currentModel,
  );
  const effortOptions = withCurrent(
    [
      { value: "", label: "Default" },
      ...effortsFor(models, currentModel).map((effort) => ({
        value: effort,
        label: effortLabel(effort),
      })),
    ],
    currentEffort,
    effortLabel(currentEffort),
  );
  const modelHint = isApi
    ? "Codex model catalog. API access may differ."
    : isPi
      ? currentModel
        ? "Local Pi model catalog."
        : "Configure a Pi model in the CLI, then select it here."
      : isClaude
        ? "Claude model aliases."
        : "Local Codex model catalog.";
  const speedHint = isApi
    ? "Fast and Ultrafast use higher-priced API service tiers; model and account access required."
    : isClaude
      ? "Fast mode for Opus; account access required."
      : "Fast mode depends on model and account.";
  const controlStyle = { width: 220, maxWidth: "100%", flexShrink: 0 };
  const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <style>{`.power-ai-control-hint { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .power-ai-section-title { color: var(--textColorAccent); } .power-ai-prompt { width: 100%; min-height: 90px; max-height: 260px; field-sizing: content; overflow-y: auto; margin-top: 8px; box-sizing: border-box; padding: 12px; border: 1px solid var(--borderFaintColor, #666); border-radius: 8px; background: var(--mainBackground, #242424); color: var(--textColorPrimary, white); font: inherit; resize: none; } .power-ai-prompt:focus { border-color: var(--primary, #5896ff); outline: 1px solid var(--primary, #5896ff); }`}</style>
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
        <label htmlFor="power-ai-cli">Provider</label>
        <div style={controlStyle}>
          <Select
            id="power-ai-cli"
            value={preferences.provider}
            options={[
              { value: "codex", label: "Codex" },
              { value: "claude", label: "Claude" },
              { value: "pi", label: "Pi" },
              { value: "codex-api", label: "OpenAI API" },
            ]}
            formatOptionLabel={(option) => (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <AiProviderIcon
                  provider={
                    option.value === "codex-api"
                      ? "codex-api"
                      : option.value === "pi"
                        ? "pi"
                        : option.value === "claude"
                          ? "claude"
                          : "codex"
                  }
                />
                {option.label}
              </span>
            )}
            onChange={(option) => {
              if (
                option?.value === "codex" ||
                option?.value === "claude" ||
                option?.value === "pi" ||
                option?.value === "codex-api"
              )
                preferences.provider = option.value;
            }}
            isDisabled={!preferences.enabled}
            isClearable={false}
            isSearchable={false}
          />
        </div>
      </div>
      {isApi && <CodexApiKeyPreferences disabled={!preferences.enabled} />}
      <div className="power-settings-row" style={rowStyle}>
        <div style={{ minWidth: 0 }}>
          <label htmlFor="power-ai-model">Model</label>
          <div className="power-settings-hint power-ai-control-hint" title={modelHint}>
            {modelHint}
          </div>
        </div>
        <div style={controlStyle}>
          <Select
            id="power-ai-model"
            value={currentModel}
            options={modelOptions}
            isDisabled={!preferences.enabled}
            isClearable={false}
            isSearchable={true}
            onChange={(option) => {
              if (!option || option.value === currentModel || (isPi && !option.value)) return;
              const effort = effortsFor(models, option.value).includes(currentEffort) ? currentEffort : "";
              if (isApi) {
                preferences.codexApiModel = option.value;
                preferences.codexApiReasoningEffort = effort;
              } else if (isPi) {
                preferences.piModel = option.value;
                preferences.piReasoningEffort = effort;
              } else if (isClaude) {
                preferences.claudeModel = option.value;
                preferences.claudeReasoningEffort = effort;
              } else {
                preferences.model = option.value;
                preferences.reasoningEffort = effort;
              }
            }}
          />
        </div>
      </div>
      <div className="power-settings-row" style={rowStyle}>
        <div style={{ minWidth: 0 }}>
          <label htmlFor="power-ai-effort">Effort</label>
          <div
            className="power-settings-hint power-ai-control-hint"
            title="Controls reasoning depth; higher may take longer."
          >
            Controls reasoning depth; higher may take longer.
          </div>
        </div>
        <div style={controlStyle}>
          <Select
            id="power-ai-effort"
            value={currentEffort}
            options={effortOptions}
            isDisabled={!preferences.enabled}
            isClearable={false}
            isSearchable={false}
            onChange={(option) => {
              if (!option) return;
              if (isApi) preferences.codexApiReasoningEffort = option.value;
              else if (isPi) preferences.piReasoningEffort = option.value;
              else if (isClaude) preferences.claudeReasoningEffort = option.value;
              else preferences.reasoningEffort = option.value;
            }}
          />
        </div>
      </div>
      {!isPi && (
        <div className="power-settings-row" style={rowStyle}>
          <div style={{ minWidth: 0 }}>
            <label htmlFor="power-ai-speed">Speed</label>
            <div className="power-settings-hint power-ai-control-hint" title={speedHint}>
              {speedHint}
            </div>
          </div>
          <div style={controlStyle}>
            <Select
              id="power-ai-speed"
              value={currentSpeed}
              options={[
                { value: "default", label: "Default" },
                { value: "fast", label: "Fast" },
                ...(isApi ? [{ value: "ultrafast" as const, label: "Ultrafast" }] : []),
              ]}
              isDisabled={!preferences.enabled}
              isClearable={false}
              isSearchable={false}
              onChange={(option) => {
                if (!option) return;
                if (isApi && ["default", "fast", "ultrafast"].includes(option.value))
                  preferences.codexApiServiceTier = option.value as "default" | "fast" | "ultrafast";
                else if (isClaude) preferences.claudeSpeed = option.value as "default" | "fast";
                else preferences.speed = option.value as "default" | "fast";
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
