// SPDX-License-Identifier: Apache-2.0
import { reaction } from "mobx";
import { AppearancePreferencesStore, isAccentSelection } from "../common/store/appearance-preferences-store";

export function startAppearanceOverride(): () => void {
  const preferences = AppearancePreferencesStore.getInstanceOrCreate<AppearancePreferencesStore>();
  const style = document.createElement("style");
  style.dataset.freelensPower = "accent-color";

  const stop = reaction(
    () => [preferences.enabled, preferences.accentColor, preferences.recolorAppIcon] as const,
    ([enabled, color, recolorAppIcon]) => {
      if (!enabled || !isAccentSelection(color)) {
        style.remove();
        return;
      }

      // [!important] takes precedence over the host theme's inline variables
      const accent =
        color === "default"
          ? ""
          : `
        :root { --primary: ${color} !important; --buttonPrimaryBackground: ${color} !important; --menuSelectedOptionBgc: ${color} !important; --select-option-focused-bgc: color-mix(in srgb, ${color} 24%, var(--contentColor)) !important; --icon-focus-color: ${color} !important; }
        :root .Checkbox, :root .Drawer .drawer-title, :root .DrawerParamToggler .param-link, :root .Drawer .ResizingAnchor { --blue: var(--primary); }
        :root [role="treeitem"][class*="catalog-tree-module__selected--"] { --blue: var(--primary); }
        :root .Select:not(.Select--is-disabled) .Select__control--is-focused:not(.Select__control--is-disabled) { border-color: ${color} !important; box-shadow: 0 0 0 1px ${color} !important; }
        :root .Select__option--is-selected { background: var(--primary) !important; color: var(--textColorAccent) !important; }
        :root .NamespaceSelectMenu .Select__option { margin-block: 2px; }
        :root .NamespaceSelectMenu .Select__option--is-selected { background: color-mix(in srgb, var(--primary) 10%, var(--contentColor)) !important; color: var(--textColorAccent) !important; }
        :root .NamespaceSelectMenu .Select__option--is-selected.Select__option--is-focused { background: color-mix(in srgb, var(--primary) 24%, var(--contentColor)) !important; }
        :root .NamespaceSelectMenu .Select__option--is-selected .Icon { color: var(--primary); }
        :root a.link { color: var(--primary); }
        ${recolorAppIcon ? '.Welcome [data-testid="no-welcome-banners-icon"] svg path[fill="#23a49c"] { fill: var(--primary); }' : ""}
      `;
      style.textContent = `${accent}\ninput[role="switch"] { --track-color-active: var(--primary) !important; }`;

      if (!style.isConnected) {
        document.head.append(style);
      }
    },
    { fireImmediately: true },
  );

  return () => {
    stop();
    style.remove();
  };
}
