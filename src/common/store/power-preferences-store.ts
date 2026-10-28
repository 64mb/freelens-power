import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";

export class PowerPreferencesStore extends Common.Store.ExtensionStore<{ enabled: boolean; checkUpdates: boolean }> {
  enabled = true;
  checkUpdates = true;

  constructor() {
    super({ configName: "power-preferences", defaults: { enabled: true, checkUpdates: true } });
    makeObservable(this, { enabled: observable, checkUpdates: observable });
  }

  fromStore(data: { enabled?: boolean; checkUpdates?: boolean }): void {
    this.enabled = data.enabled !== false;
    this.checkUpdates = data.checkUpdates !== false;
  }

  toJSON() {
    return { enabled: this.enabled, checkUpdates: this.checkUpdates };
  }
}
