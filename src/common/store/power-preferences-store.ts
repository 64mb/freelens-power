import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";

interface PowerPreferences {
  enabled: boolean;
  checkUpdates: boolean;
  nodeBulkActions: boolean;
  hotbarShortcuts: boolean;
}

export class PowerPreferencesStore extends Common.Store.ExtensionStore<PowerPreferences> {
  enabled = true;
  checkUpdates = true;
  nodeBulkActions = true;
  hotbarShortcuts = true;

  constructor() {
    super({
      configName: "power-preferences",
      defaults: { enabled: true, checkUpdates: true, nodeBulkActions: true, hotbarShortcuts: true },
    });
    makeObservable(this, {
      enabled: observable,
      checkUpdates: observable,
      nodeBulkActions: observable,
      hotbarShortcuts: observable,
    });
  }

  fromStore(data: Partial<PowerPreferences>): void {
    this.enabled = data.enabled !== false;
    this.checkUpdates = data.checkUpdates !== false;
    this.nodeBulkActions = data.nodeBulkActions !== false;
    this.hotbarShortcuts = data.hotbarShortcuts !== false;
  }

  toJSON() {
    return {
      enabled: this.enabled,
      checkUpdates: this.checkUpdates,
      nodeBulkActions: this.nodeBulkActions,
      hotbarShortcuts: this.hotbarShortcuts,
    };
  }
}
