import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { MonitoringPreferencesStore } from "../../common/store/monitoring-preferences-store";
import { PowerPreferencesStore } from "../../common/store/power-preferences-store";

export const OtherPreferences = observer(() => {
  const preferences = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  const monitoring = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <Renderer.Component.Switch
          checked={preferences.nodeBulkActions}
          onChange={(value) => {
            preferences.nodeBulkActions = value;
          }}
        >
          Bulk resource actions
        </Renderer.Component.Switch>
        <div className="power-settings-hint">Bulk actions and clearer resource dialogs.</div>
      </div>
      <div>
        <Renderer.Component.Switch
          checked={monitoring.resourceSearchEnabled}
          onChange={(value) => {
            monitoring.resourceSearchEnabled = value;
          }}
        >
          Enable resource search (Shift-Shift)
        </Renderer.Component.Switch>
        <div className="power-settings-hint">
          Search resources with Shift-Shift. Turning this off stops keyboard search and background indexing.
        </div>
      </div>
    </div>
  );
});
