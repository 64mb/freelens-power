import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { MonitoringPreferencesStore } from "../../common/store/monitoring-preferences-store";

export const MonitoringPreferences = observer(() => {
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  return (
    <div>
      <Renderer.Component.Switch
        checked={preferences.enabled}
        onChange={(value) => {
          preferences.enabled = value;
        }}
      >
        Metrics-server overview
      </Renderer.Component.Switch>
      <div className="power-settings-hint">
        Show CPU and memory usage from metrics-server. Samples are kept in memory while this overview is visible, for up
        to 30 minutes. Requires permission to read node metrics. No historical data is available before collection.
      </div>
    </div>
  );
});
