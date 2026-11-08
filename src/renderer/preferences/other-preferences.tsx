import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { AppearancePreferencesStore } from "../../common/store/appearance-preferences-store";
import { MonitoringPreferencesStore } from "../../common/store/monitoring-preferences-store";
import { PowerPreferencesStore } from "../../common/store/power-preferences-store";

export const OtherPreferences = observer(() => {
  const preferences = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  const monitoring = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  const appearance = AppearancePreferencesStore.getInstanceOrCreate<AppearancePreferencesStore>();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <Renderer.Component.Switch
          checked={appearance.clusterDiagnostics}
          onChange={(value) => {
            appearance.clusterDiagnostics = value;
          }}
        >
          Cluster overview diagnostics
        </Renderer.Component.Switch>
        <div className="power-settings-hint">
          Replace the events panel with workload diagnostics on the Cluster overview.
        </div>
      </div>
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
          checked={preferences.hotbarShortcuts}
          onChange={(value) => {
            preferences.hotbarShortcuts = value;
          }}
        >
          Hotbar keyboard shortcuts
        </Renderer.Component.Switch>
        <div className="power-settings-hint">Switch panels with Cmd+1-9 on macOS or Ctrl+1-9 on Windows and Linux.</div>
      </div>
      <div>
        <Renderer.Component.Switch
          checked={preferences.hotbarItemShortcuts}
          onChange={(value) => {
            preferences.hotbarItemShortcuts = value;
          }}
        >
          Hotbar item shortcuts
        </Renderer.Component.Switch>
        <div className="power-settings-hint">
          Show number badges and open hotbar items with 1-9 or the last item with 0 outside input fields.
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
