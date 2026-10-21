// SPDX-License-Identifier: Apache-2.0
import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";

export const DEFAULT_ACCENT_COLOR = "#7060e8";

export const ACCENT_COLOR_OPTIONS = [
  { value: "default", label: "Default", color: "#00a7a0" },
  { value: "#7060e8", label: "Purple", color: "#7060e8" },
  { value: "#0273ee", label: "Blue", color: "#0273ee" },
  { value: "#4caf50", label: "Green", color: "#4caf50" },
  { value: "#edc927", label: "Yellow", color: "#edc927" },
  { value: "#ff9800", label: "Orange", color: "#ff9800" },
  { value: "#e52626", label: "Red", color: "#e52626" },
  { value: "#e91e63", label: "Pink", color: "#e91e63" },
];

export function isAccentSelection(value: unknown): value is string {
  return ACCENT_COLOR_OPTIONS.some((option) => option.value === value);
}

export interface AppearancePreferencesModel {
  enabled: boolean;
  accentColor: string;
  recolorAppIcon: boolean;
}

export class AppearancePreferencesStore extends Common.Store.ExtensionStore<AppearancePreferencesModel> {
  enabled = true;
  accentColor = DEFAULT_ACCENT_COLOR;
  recolorAppIcon = true;

  constructor() {
    super({
      configName: "appearance-preferences",
      defaults: { enabled: true, accentColor: DEFAULT_ACCENT_COLOR, recolorAppIcon: true },
    });
    makeObservable(this, { enabled: observable, accentColor: observable, recolorAppIcon: observable });
  }

  fromStore(data: Partial<AppearancePreferencesModel>): void {
    this.enabled = typeof data.enabled === "boolean" ? data.enabled : true;
    this.recolorAppIcon = typeof data.recolorAppIcon === "boolean" ? data.recolorAppIcon : true;
    const legacyColors: Record<string, string> = {
      "#7868f4": "#7060e8",
      "#027bfe": "#0273ee",
      "#ffc107": "#edc927",
      "#009688": "default",
    };
    const color =
      typeof data.accentColor === "string" ? (legacyColors[data.accentColor] ?? data.accentColor) : data.accentColor;
    this.accentColor = isAccentSelection(color) ? color : DEFAULT_ACCENT_COLOR;
  }

  toJSON(): AppearancePreferencesModel {
    return { enabled: this.enabled, accentColor: this.accentColor, recolorAppIcon: this.recolorAppIcon };
  }
}
