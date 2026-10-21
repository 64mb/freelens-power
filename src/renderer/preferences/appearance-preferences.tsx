// SPDX-License-Identifier: Apache-2.0
import { Renderer } from "@freelensapp/extensions";
import { observer } from "mobx-react";
import { ACCENT_COLOR_OPTIONS, AppearancePreferencesStore } from "../../common/store/appearance-preferences-store";

const { Select, Switch } = Renderer.Component;

const accentOptions = ACCENT_COLOR_OPTIONS.map((option) => ({
  value: option.value,
  label: (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span
        aria-hidden="true"
        style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: option.color, flexShrink: 0 }}
      />
      {option.label}
    </span>
  ),
}));

export const AppearancePreferences = observer(() => {
  const preferences = AppearancePreferencesStore.getInstanceOrCreate<AppearancePreferencesStore>();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <Switch
          checked={preferences.enabled}
          onChange={(value) => {
            preferences.enabled = value;
          }}
        >
          Override accent color
        </Switch>
        <div className="power-settings-hint">Apply the selected color to accents and primary buttons.</div>
      </div>
      <div>
        <Switch
          checked={preferences.recolorAppIcon}
          onChange={(value) => {
            preferences.recolorAppIcon = value;
          }}
        >
          Match app icon to accent
        </Switch>
        <div className="power-settings-hint">Recolor the macOS Dock icon. Turn off to restore the original icon.</div>
      </div>
      <div
        className="power-settings-row"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }}
      >
        <div>
          <label id="freelens-power-accent-color-label" htmlFor="freelens-power-accent-color">
            Accent color
          </label>
          <div className="power-settings-hint">Default follows the current theme.</div>
        </div>
        <div style={{ width: 220, maxWidth: "100%", flexShrink: 0 }}>
          <Select
            id="freelens-power-accent-color"
            aria-labelledby="freelens-power-accent-color-label"
            options={accentOptions}
            value={preferences.accentColor}
            isDisabled={!preferences.enabled}
            isSearchable={false}
            isClearable={false}
            onChange={(option) => {
              if (option) preferences.accentColor = option.value;
            }}
          />
        </div>
      </div>
    </div>
  );
});
