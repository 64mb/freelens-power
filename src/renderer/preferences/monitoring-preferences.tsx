import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { useEffect, useState } from "react";
import { type HistoryStatus } from "../../common/monitoring-history";
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
        Show cluster, node and pod CPU/memory charts from metrics-server. Live samples are kept for 30 minutes. Requires
        permission to read the corresponding resource metrics. Requests and capacity use Kubernetes resource data.
      </div>
      <Renderer.Component.Switch
        checked={preferences.historyEnabled}
        onChange={(value) => {
          preferences.historyEnabled = value;
        }}
      >
        Keep local numeric monitoring history
      </Renderer.Component.Switch>
      <div className="power-settings-hint">
        Opt-in local SQLite history. Retained for up to 7 days within 100 MiB. Collection runs while monitoring is
        enabled and the cluster view is active. Track individual pods or workloads in Diagnostics. Resolution: 30
        seconds for 2 hours, 5 minutes for 24 hours, 30 minutes for 7 days. No data is backfilled. Disabling collection
        preserves existing history until cleared.
      </div>
      <div role="status">
        {status?.error ??
          (status
            ? `${(status.bytes / 1024 / 1024).toFixed(2)} MiB, ${status.samples} stored metric buckets`
            : "Checking history storage…")}
      </div>
      <button
        type="button"
        title="Delete locally collected metric history without changing other settings"
        onClick={() => {
          void monitoringHistory
            .clear()
            .then(refresh)
            .catch(() =>
              setStatus({
                available: false,
                enabled: preferences.historyEnabled,
                bytes: 0,
                samples: 0,
                error: "Unable to clear local history",
              }),
            );
        }}
      >
        Clear local history
      </button>
    </div>
  );
});
