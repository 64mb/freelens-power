import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { POWER_LOGS_DEFAULT_LIMITS, type PowerLogsLimits } from "../../common/power-logs";
import { applyPowerLogsLimits } from "../../common/power-logs-limits";
import { LogsPreferencesStore } from "../../common/store/logs-preferences-store";

const MiB = 1024 * 1024;
interface LimitPreset {
  label: string;
  limits: Partial<PowerLogsLimits>;
}
interface LimitSetting {
  key: keyof PowerLogsLimits;
  label: string;
  hint: string;
  presets: LimitPreset[];
  describe(limits: PowerLogsLimits): string;
}
const settings: LimitSetting[] = [
  {
    key: "liveRows",
    label: "Live buffer",
    hint: "Maximum rows and memory kept in the live log view.",
    presets: [1000, 5000, 10000, 50000, 100000].map((liveRows, index) => ({
      label: `${liveRows.toLocaleString("en-US")} rows / ${[2, 8, 16, 80, 160][index]} MiB`,
      limits: { liveRows, liveBytes: [2, 8, 16, 80, 160][index] * MiB },
    })),
    describe: (limits) => `${limits.liveRows.toLocaleString("en-US")} rows / ${limits.liveBytes / MiB} MiB`,
  },
  {
    key: "historyLines",
    label: "History per container",
    hint: "Maximum recent lines and data fetched for each container.",
    presets: [500, 1000, 5000].map((historyLines, index) => ({
      label: `${historyLines.toLocaleString("en-US")} lines / ${[0.5, 1, 5][index]} MiB`,
      limits: { historyLines, historyBytes: [0.5, 1, 5][index] * MiB },
    })),
    describe: (limits) => `${limits.historyLines.toLocaleString("en-US")} lines / ${limits.historyBytes / MiB} MiB`,
  },
  {
    key: "captureBytes",
    label: "Capture size",
    hint: "Maximum data stored in each temporary capture.",
    presets: [64, 128, 256, 512].map((size) => ({
      label: `${size} MiB`,
      limits: { captureBytes: size * MiB },
    })),
    describe: (limits) => `${limits.captureBytes / MiB} MiB`,
  },
  {
    key: "captures",
    label: "Saved captures",
    hint: "Maximum number of temporary captures retained.",
    presets: [1, 3, 5, 10].map((captures) => ({
      label: `${captures} ${captures === 1 ? "capture" : "captures"}`,
      limits: { captures },
    })),
    describe: (limits) => `${limits.captures} captures`,
  },
  {
    key: "ttlMs",
    label: "Retention",
    hint: "How long temporary captures remain available.",
    presets: [30, 60, 360, 1440, 4320].map((minutes) => ({
      label:
        minutes >= 1440
          ? `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`
          : minutes < 60
            ? `${minutes} minutes`
            : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`,
      limits: { ttlMs: minutes * 60000 },
    })),
    describe: (limits) => `${limits.ttlMs / 60000} minutes`,
  },
];

const LogLimitSelect = observer(function LogLimitSelect({
  setting,
  preferences,
}: {
  setting: LimitSetting;
  preferences: LogsPreferencesStore;
}) {
  const selected = setting.presets.findIndex((preset) =>
    Object.entries(preset.limits).every(([key, value]) => preferences.limits[key as keyof PowerLogsLimits] === value),
  );
  const options = setting.presets.map((preset, index) => ({ value: String(index), label: preset.label }));
  if (selected === -1) options.push({ value: "custom", label: `Custom: ${setting.describe(preferences.limits)}` });
  const id = `freelens-power-logs-${setting.key}`;
  return (
    <div
      className="power-settings-row"
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }}
    >
      <div>
        <label id={`${id}-label`} htmlFor={id}>
          {setting.label}
        </label>
        <div className="power-settings-hint">{setting.hint}</div>
      </div>
      <div style={{ width: 260, maxWidth: "100%", flexShrink: 0 }}>
        <Renderer.Component.Select
          id={id}
          aria-labelledby={`${id}-label`}
          options={options}
          value={selected === -1 ? "custom" : String(selected)}
          isSearchable={false}
          isClearable={false}
          onChange={(option) => {
            if (!option || option.value === "custom") return;
            const preset = setting.presets[Number(option.value)];
            if (!preset) return;
            preferences.limits = { ...preferences.limits, ...preset.limits };
            applyPowerLogsLimits(preferences.limits);
          }}
        />
      </div>
    </div>
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
          Temporary captures follow the retention settings below and are deleted when Power Logs stops. Pinned snapshots
          remain until manually deleted.
        </div>
      </div>
      <div className="power-settings-hint">
        Changes apply to new requests, captures and SQL queries. Existing captures retain their capacity and expiry.
      </div>
      {settings.map((setting) => (
        <LogLimitSelect key={setting.key} setting={setting} preferences={preferences} />
      ))}
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
