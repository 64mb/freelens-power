import { Main } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { EXTENSION_DISPLAY_NAME, EXTENSION_ID } from "../common/extension-info";
import { AiPreferencesStore } from "../common/store/ai-preferences-store";
import { AiShortcutsStore } from "../common/store/ai-shortcuts-store";
import { AppearancePreferencesStore } from "../common/store/appearance-preferences-store";
import { DashboardPreferencesStore } from "../common/store/dashboard-preferences-store";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";
import { NodeShellPreferencesStore } from "../common/store/node-shell-preferences-store";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { startAiIpc } from "./ai-ipc";
import { startAiModels } from "./ai-models";
import { registerDashboardCatalog } from "./dashboard-catalog";
import { startDashboardPicker } from "./dashboard-picker";
import { startDashboardViews } from "./dashboard-views";
import { startDockIconOverride } from "./dock-icon";
import { startSettingsExport } from "./settings-export";

export default class FreelensPowerMain extends Main.LensExtension {
  private stopFeatures?: () => void;

  get name() {
    return EXTENSION_DISPLAY_NAME;
  }
  get sanitizedExtensionId() {
    return EXTENSION_ID;
  }
  get storeName() {
    return this.manifest.storeName || EXTENSION_ID;
  }

  onActivate() {
    const power = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
    power.loadExtension(this);
    AiPreferencesStore.getInstanceOrCreate().loadExtension(this);
    AiShortcutsStore.getInstanceOrCreate().loadExtension(this);
    ReadOnlyPreferencesStore.getInstanceOrCreate().loadExtension(this);
    NodeShellPreferencesStore.getInstanceOrCreate().loadExtension(this);
    MonitoringPreferencesStore.getInstanceOrCreate().loadExtension(this);
    AppearancePreferencesStore.getInstanceOrCreate().loadExtension(this);
    DashboardPreferencesStore.getInstanceOrCreate().loadExtension(this);
    this.stopFeatures?.();
    const stopExport = startSettingsExport();
    let disposers: (() => void)[] = [];
    const stop = reaction(
      () => power.enabled,
      (enabled) => {
        for (const dispose of disposers) dispose();
        disposers = enabled
          ? [
              startAiIpc(),
              startAiModels(),
              startDockIconOverride(),
              startDashboardViews(),
              startDashboardPicker(),
              registerDashboardCatalog(this),
            ]
          : [];
      },
      { fireImmediately: true },
    );
    this.stopFeatures = () => {
      stop();
      stopExport();
      for (const dispose of disposers) dispose();
      disposers = [];
    };
  }

  onDeactivate() {
    this.stopFeatures?.();
    this.stopFeatures = undefined;
  }
}
