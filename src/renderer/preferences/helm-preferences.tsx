import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { HelmPreferencesStore } from "../../common/store/helm-preferences-store";

export const HelmPreferences = observer(() => {
  const preferences = HelmPreferencesStore.getInstanceOrCreate<HelmPreferencesStore>();
  return (
    <div>
      <Renderer.Component.Switch
        checked={preferences.enabled}
        onChange={(value) => {
          preferences.enabled = value;
        }}
      >
        Enable Helm enhancements
      </Renderer.Component.Switch>
      <div className="power-settings-hint">
        Use cached release metadata and load details on demand. Turn off to restore the native Helm menu.
      </div>
    </div>
  );
});
