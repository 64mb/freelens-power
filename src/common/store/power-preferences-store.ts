import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";

interface PowerPreferences {
  enabled: boolean;
  checkUpdates: boolean;
  nodeBulkActions: boolean;
  podBulkActions: boolean;
}

export class PowerPreferencesStore extends Common.Store.ExtensionStore<PowerPreferences> {
  enabled = true;
  checkUpdates = true;
  nodeBulkActions = true;
  podBulkActions = true;

  constructor() {
    super({
      configName: "power-preferences",
      defaults: { enabled: true, checkUpdates: true, nodeBulkActions: true, podBulkActions: true },
    });
    makeObservable(this, {
      enabled: observable,
      checkUpdates: observable,
      nodeBulkActions: observable,
      podBulkActions: observable,
    });
  }

  fromStore(data: Partial<PowerPreferences>): void {
    this.enabled = data.enabled !== false;
    this.checkUpdates = data.checkUpdates !== false;
    this.nodeBulkActions = data.nodeBulkActions !== false;
    this.podBulkActions = data.podBulkActions !== false;
  }

  toJSON() {
    return {
      enabled: this.enabled,
      checkUpdates: this.checkUpdates,
      nodeBulkActions: this.nodeBulkActions,
      podBulkActions: this.podBulkActions,
    };
  }
}
