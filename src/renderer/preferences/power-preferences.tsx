import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { PowerPreferencesStore } from "../../common/store/power-preferences-store";

export const PowerPreferencesToggle = observer(() => {
  const preferences = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  return (
    <div>
      <Renderer.Component.Switch
        checked={preferences.enabled}
        onChange={(enabled) => {
          preferences.enabled = enabled;
        }}
      >
        Enable Freelens Power
      </Renderer.Component.Switch>
      <div className="power-settings-hint">
        Turn off all Power features and restore the native interface. Your settings and conversations are kept.
      </div>
    </div>
  );
});
