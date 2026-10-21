import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { ReadOnlyPreferencesStore } from "../../common/store/read-only-preferences-store";

const { Switch } = Renderer.Component;

export const ReadOnlyPreferences = observer(() => {
  const preferences = ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>();
  return (
    <div>
      <Switch
        checked={preferences.enabled}
        onChange={(value) => {
          preferences.enabled = value;
        }}
      >
        Read-only mode
      </Switch>
      <div className="power-settings-hint">
        Hide common create, edit and delete actions for resources, nodes and clusters. This only changes the interface;
        permissions remain unchanged.
      </div>
    </div>
  );
});
