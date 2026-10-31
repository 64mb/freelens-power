import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { useEffect, useState } from "react";
import { type LogStorageStatus, POWER_LOGS_STORAGE_MAX_BYTES, type PowerLogsLimits } from "../../common/power-logs";
import { applyPowerLogsLimits } from "../../common/power-logs-limits";
import { LogsPreferencesStore } from "../../common/store/logs-preferences-store";
import { powerLogsStorage } from "../power-logs-storage";

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
      <LogsStorage enabled={preferences.enabled} />
    </div>
  );
});

function LogsStorage({ enabled }: { enabled: boolean }) {
  const [status, setStatus] = useState<LogStorageStatus>();
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    let active = true;
    setStatus(undefined);
    setError("");
    if (!enabled) return;
    const refresh = () => {
      void powerLogsStorage.status().then(
        (value) => {
          if (active) {
            setStatus(value);
            setError("");
          }
        },
        () => {
          if (active) setError("Log storage unavailable. Try again.");
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled]);
  const clear = () => {
    if (clearing) return;
    setClearing(true);
    void powerLogsStorage
      .clear()
      .then(() => powerLogsStorage.status())
      .then(
        (value) => {
          setStatus(value);
          setError("");
        },
        () => setError("Unable to clear log storage. Try again."),
      )
      .finally(() => setClearing(false));
  };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }} role="status">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <span>Local storage</span>
          <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--textColorSecondary)" }}>
            {status
              ? `${(status.bytes / MiB).toFixed(2)} / ${status.maxBytes / MiB} MiB`
              : `— / ${POWER_LOGS_STORAGE_MAX_BYTES / MiB} MiB`}
          </span>
        </div>
        {status && (
          <div
            role="progressbar"
            aria-label="Local log storage"
            aria-valuemin={0}
            aria-valuemax={status.maxBytes}
            aria-valuenow={Math.min(status.bytes, status.maxBytes)}
            aria-valuetext={`${(status.bytes / MiB).toFixed(2)} of ${status.maxBytes / MiB} MiB`}
            style={{ height: 4, marginTop: 8, borderRadius: 2, overflow: "hidden", background: "var(--borderColor)" }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, Math.max(0, (status.bytes / status.maxBytes) * 100))}%`,
                background: "var(--primary)",
                transition: "width 180ms ease",
              }}
            />
          </div>
        )}
        <div className="power-settings-hint" style={{ marginTop: 6 }}>
          {error ||
            (!enabled
              ? "Enable Power Logs to manage stored captures."
              : status
                ? `${status.captures} captures · ${status.collecting} collecting`
                : "Checking log storage…")}
        </div>
      </div>
      <Renderer.Component.Button
        disabled={!enabled || !status || clearing || status.captures === status.collecting}
        onClick={() =>
          Renderer.Component.ConfirmDialog.open({
            message:
              "Delete all completed log captures, including pinned snapshots, from all clusters? Active captures are preserved. This cannot be undone.",
            labelOk: "Clear log storage",
            ok: clear,
          })
        }
        style={{
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          height: 30,
          padding: "0 10px",
          fontSize: 12,
          lineHeight: "16px",
          border: "1px solid var(--borderFaintColor)",
          borderRadius: 6,
          background: "var(--contentColor)",
          color: "var(--textColorSecondary)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <Renderer.Component.Icon material="delete_outline" size={14} aria-hidden="true" />
          <span>Clear</span>
        </span>
      </Renderer.Component.Button>
    </div>
  );
}
