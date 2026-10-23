import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { useEffect, useState } from "react";
import { HISTORY_MAX_BYTES, type HistoryStatus } from "../../common/monitoring-history";
import { MonitoringPreferencesStore } from "../../common/store/monitoring-preferences-store";
import { monitoringHistory } from "../monitoring-history";

export const MonitoringPreferences = observer(() => {
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  const [status, setStatus] = useState<HistoryStatus>();
  const refresh = () => {
    void monitoringHistory
      .status()
      .then(setStatus)
      .catch(() =>
        setStatus({
          available: false,
          enabled: preferences.historyEnabled,
          bytes: 0,
          samples: 0,
          error: "History service unavailable",
        }),
      );
  };
  useEffect(refresh, [preferences.historyEnabled]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <Renderer.Component.Switch
          checked={preferences.diagnosticsVisible}
          onChange={(value) => {
            preferences.diagnosticsVisible = value;
          }}
        >
          Show Diagnostics in sidebar
        </Renderer.Component.Switch>
        <div className="power-settings-hint">Resource consumers, application events and Pending diagnostics.</div>
      </div>
      <div>
        <Renderer.Component.Switch
          checked={preferences.relationshipsVisible}
          onChange={(value) => {
            preferences.relationshipsVisible = value;
          }}
        >
          Show Relationships in sidebar
        </Renderer.Component.Switch>
        <div className="power-settings-hint">
          Focused resource connections from API evidence, with links to related objects.
        </div>
      </div>
      <div>
        <Renderer.Component.Switch
          checked={preferences.enabled}
          onChange={(value) => {
            preferences.enabled = value;
          }}
        >
          Metrics-server monitoring
        </Renderer.Component.Switch>
        <div className="power-settings-hint">
          CPU/RAM charts for clusters, nodes and pods. Keeps 30 minutes of live samples.
        </div>
      </div>
      <div>
        <Renderer.Component.Switch
          checked={preferences.historyEnabled}
          onChange={(value) => {
            preferences.historyEnabled = value;
          }}
        >
          Keep local history
        </Renderer.Component.Switch>
        <div
          className="power-settings-hint"
          title="SQLite storage. Collects while the cluster view is active. Resolution: 30 seconds for 2 hours, 5 minutes for 24 hours, 30 minutes for 7 days. Disabling preserves saved history."
        >
          Up to 7 days, limited to 100 MiB.
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }} role="status">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <span>Local storage</span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--textColorSecondary)" }}>
              {status?.available
                ? `${(status.bytes / 1024 / 1024).toFixed(2)} / ${HISTORY_MAX_BYTES / 1024 / 1024} MiB`
                : "— / 100 MiB"}
            </span>
          </div>
          {status?.available && (
            <div
              role="progressbar"
              aria-label="Local history storage"
              aria-valuemin={0}
              aria-valuemax={HISTORY_MAX_BYTES}
              aria-valuenow={status.bytes}
              aria-valuetext={`${(status.bytes / 1024 / 1024).toFixed(2)} of 100 MiB`}
              style={{ height: 4, marginTop: 8, borderRadius: 2, overflow: "hidden", background: "var(--borderColor)" }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(100, Math.max(0, (status.bytes / HISTORY_MAX_BYTES) * 100))}%`,
                  background: "var(--primary)",
                  transition: "width 180ms ease",
                }}
              />
            </div>
          )}
          <div className="power-settings-hint" style={{ marginTop: 6 }}>
            {status?.error ??
              (status?.available
                ? `${status.samples.toLocaleString()} metric buckets · 7-day retention`
                : "Checking history storage…")}
          </div>
        </div>
        <Renderer.Component.Button
          style={{
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            height: 30,
            padding: "0 10px",
            fontSize: 12,
            lineHeight: "16px",
            border: "1px solid var(--borderFaintColor)",
            borderRadius: 6,
            background: "var(--contentColor)",
            color: "var(--textColorSecondary)",
          }}
          title="Delete locally collected metric history without changing other settings"
          onClick={() => {
            void monitoringHistory
              .clear()
              .then(refresh)
              .catch(() =>
                setStatus((previous) => ({
                  available: previous?.available ?? false,
                  enabled: preferences.historyEnabled,
                  bytes: previous?.bytes ?? 0,
                  samples: previous?.samples ?? 0,
                  error: "Unable to clear local history. Try again.",
                })),
              );
          }}
        >
          <Renderer.Component.Icon material="delete_outline" size={14} />
          <span>Clear</span>
        </Renderer.Component.Button>
      </div>
    </div>
  );
});
