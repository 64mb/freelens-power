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
          Bulk node actions
        </Renderer.Component.Switch>
        <div className="power-settings-hint">
          Show node selection checkboxes and bulk actions. Turning this off restores the native Nodes list.
        </div>
      </div>
      <div>
        <Renderer.Component.Switch
          checked={preferences.podBulkActions}
          onChange={(value) => {
            preferences.podBulkActions = value;
          }}
        >
          Customize Pod bulk actions
        </Renderer.Component.Switch>
        <div className="power-settings-hint">
          Use Power styling and removal confirmation for Pod bulk actions. Turning this off restores native Pod bulk
          actions.
        </div>
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
