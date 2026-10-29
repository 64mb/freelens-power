// SPDX-License-Identifier: Apache-2.0
import { reaction } from "mobx";
import { AppearancePreferencesStore, isAccentSelection } from "../common/store/appearance-preferences-store";

export function accentForeground(color: string): "#000000" | "#ffffff" {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}

export function startAppearanceOverride(): () => void {
  const preferences = AppearancePreferencesStore.getInstanceOrCreate<AppearancePreferencesStore>();
  const editorStyle = document.createElement("style");
  editorStyle.dataset.freelensPower = "editor-controls";
  editorStyle.textContent = `
    :root .monaco-editor .monaco-scrollable-element > .scrollbar > .slider {
      box-sizing: border-box;
      background: var(--scrollBarColor) !important;
      background-clip: padding-box !important;
      border: 4px solid transparent;
      border-right-width: 5px;
      border-radius: 16px;
    }
    :root textarea::-webkit-scrollbar { width: 16px; height: 15px; background: transparent; }
    :root textarea::-webkit-scrollbar-thumb {
      background: var(--scrollBarColor);
      background-clip: padding-box;
      border: 4px solid transparent;
      border-right-width: 5px;
      border-radius: 16px;
    }
    :root textarea::-webkit-scrollbar-corner { background: transparent; }
    :root textarea::-webkit-resizer {
      border: 0;
      background: linear-gradient(135deg, transparent 45%, var(--borderColor) 46% 53%, transparent 54% 70%, var(--borderColor) 71% 78%, transparent 79%) center/10px 10px no-repeat;
    }
  `;
  document.head.append(editorStyle);
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
        :root { --freelens-power-accent-foreground: ${accentForeground(color)}; --select-option-focused-color: var(--textColorAccent) !important; --primary: ${color} !important; --buttonPrimaryBackground: ${color} !important; --menuSelectedOptionBgc: ${color} !important; --select-option-focused-bgc: color-mix(in srgb, ${color} 24%, var(--contentColor)) !important; --icon-focus-color: ${color} !important; }
        :root .Checkbox, :root .Drawer .drawer-title, :root .DrawerParamToggler .param-link, :root .Drawer .ResizingAnchor { --blue: var(--primary); }
        :root [role="treeitem"][class*="catalog-tree-module__selected--"] { --blue: var(--primary); }
        :root [class*="main-layout-module__sidebar--"] > .ResizingAnchor { --blue: var(--primary); }
        :root .Dock > .ResizingAnchor { --blue: var(--primary); }
        :root .CatalogAddButton .MuiFab-primary:not(.Mui-disabled) { background-color: var(--primary) !important; color: var(--freelens-power-accent-foreground) !important; }
        :root .CatalogAddButton .MuiFab-primary:not(.Mui-disabled):hover { background-color: color-mix(in srgb, var(--primary) 88%, black) !important; }
        :root .MenuItem:is(.create-terminal-tab, .create-resource-tab) { --bgc-active: var(--primary); }
        :root .Select__option--is-selected { background: var(--primary) !important; color: var(--freelens-power-accent-foreground) !important; }
        :root .Select__option--is-focused:not(.Select__option--is-selected) { color: var(--textColorAccent) !important; }
        :root .Button.primary:not(.plain):not(.outlined):not(.light):not(.remove-button) { color: var(--freelens-power-accent-foreground); }
        :root [data-testid="cluster-sidebar"] { --sidebarActiveColor: var(--freelens-power-accent-foreground); --sidebarSubmenuActiveColor: var(--primary); }
        :root .NamespaceSelectMenu .Select__option--is-selected { background: color-mix(in srgb, var(--primary) 10%, var(--contentColor)) !important; color: var(--textColorAccent) !important; }
        :root .NamespaceSelectMenu .Select__option--is-selected.Select__option--is-focused { background: color-mix(in srgb, var(--primary) 24%, var(--contentColor)) !important; }
        :root .NamespaceSelectMenu .Select__option--is-selected .Icon { color: var(--primary); }
        :root .Select__option:not(.Select__option--is-disabled):active { background: var(--primary) !important; color: var(--freelens-power-accent-foreground) !important; }
        :root .NamespaceSelectMenu .Select__option--is-selected:active .Icon { color: inherit; }
        :root a.link { color: var(--primary); }
        :root [data-testid="download-logs-dropdown"] { --accent-color: var(--primary); }
        :root .Notifications .notification.info { background: var(--primary); color: var(--freelens-power-accent-foreground); }
        ${recolorAppIcon ? '.Welcome [data-testid="no-welcome-banners-icon"] svg path[fill="#23a49c"] { fill: var(--primary); }' : ""}
      `;
      style.textContent = `${accent}
        input[role="switch"] { --track-color-active: var(--primary) !important; }
        :root .Input:not(.invalid):not(.validating) label:focus-within { border-color: var(--primary) !important; }
        :root .Select:not(.Select--is-disabled) .Select__control--is-focused:not(.Select__control--is-disabled) { border-color: var(--primary) !important; box-shadow: 0 0 0 1px var(--primary) !important; }
      `;

      if (!style.isConnected) {
        document.head.append(style);
      }
    },
    { fireImmediately: true },
  );

  return () => {
    stop();
    style.remove();
    editorStyle.remove();
  };
}
