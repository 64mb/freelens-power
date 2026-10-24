import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { useEffect, useState } from "react";
import { POWER_LOGS_DEFAULT_LIMITS } from "../../common/power-logs";
import {
  applyPowerLogsLimits,
  LOG_LIMIT_FIELDS,
  type LogLimitField,
  normalizePowerLogsLimits,
} from "../../common/power-logs-limits";
import { LogsPreferencesStore } from "../../common/store/logs-preferences-store";

const LogLimitInput = observer(function LogLimitInput({
  field,
  preferences,
}: {
  field: LogLimitField;
  preferences: LogsPreferencesStore;
}) {
  const scale = field.scale ?? 1;
  const value = preferences.limits[field.key];
  const [draft, setDraft] = useState(String(value / scale));
  useEffect(() => setDraft(String(value / scale)), [value, scale]);
  const commit = () => {
    const next = draft.trim() === "" ? value : Number(draft) * scale;
    preferences.limits = normalizePowerLogsLimits({
      ...preferences.limits,
      [field.key]: Number.isFinite(next) ? next : value,
    });
    applyPowerLogsLimits(preferences.limits);
    setDraft(String(preferences.limits[field.key] / scale));
  };
  return (
    <label className="power-log-limit">
      <span>{field.label}</span>
      <span className="power-log-limit-value">
        <Renderer.Component.Input
          aria-label={`${field.group}: ${field.label}`}
          type="number"
          value={draft}
          min={field.min / scale}
          max={field.max / scale}
          step="any"
          onChange={setDraft}
          onBlur={commit}
          onSubmit={commit}
        />
        <span>{field.unit}</span>
      </span>
    </label>
  );
});

export const LogsPreferences = observer(() => {
  const preferences = LogsPreferencesStore.getInstanceOrCreate<LogsPreferencesStore>();
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <Renderer.Component.Switch
          checked={preferences.enabled}
          onChange={(value) => {
            preferences.enabled = value;
          }}
        >
          Use Power Logs
        </Renderer.Component.Switch>
        <div className="power-settings-hint">
          Colored workload logs and temporary SQLite captures for SQL analysis. Native logs return when disabled.
          Temporary captures follow the retention settings below and are deleted when Power Logs stops.
        </div>
      </div>
      <style>{`.power-log-limit-groups{display:grid;gap:20px}.power-log-limit-groups fieldset{min-width:0;border:1px solid var(--borderFaintColor);border-radius:6px;padding:16px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 20px}.power-log-limit-groups legend{padding:0 6px;color:var(--textColorAccent)}.power-log-limit{display:flex;flex-direction:column;gap:6px;min-width:0}.power-log-limit-value{display:flex;align-items:center;gap:8px;color:var(--textColorSecondary);font-size:12px}.power-log-limit-value .Input{min-width:0;flex:1}.power-log-limit-value input{width:100%;min-width:0}@container power-preferences(max-width:480px){.power-log-limit-groups fieldset{grid-template-columns:1fr}}`}</style>
      <div className="power-settings-hint">
        Changes apply to new requests, captures and SQL queries. Existing captures retain their capacity and expiry.
      </div>
      <div className="power-log-limit-groups">
        {[...new Set(LOG_LIMIT_FIELDS.map((field) => field.group))].map((group) => (
          <fieldset key={group}>
            <legend>{group}</legend>
            {LOG_LIMIT_FIELDS.filter((field) => field.group === group).map((field) => (
              <LogLimitInput key={field.key} field={field} preferences={preferences} />
            ))}
          </fieldset>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Renderer.Component.Button
          onClick={() => {
            preferences.limits = { ...POWER_LOGS_DEFAULT_LIMITS };
            applyPowerLogsLimits(preferences.limits);
          }}
        >
          <Renderer.Component.Icon material="restore" size={16} /> Reset log limits
        </Renderer.Component.Button>
      </div>
    </div>
  );
});
