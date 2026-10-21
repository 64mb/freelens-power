import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";

export class PowerPreferencesStore extends Common.Store.ExtensionStore<{ enabled: boolean }> {
  enabled = true;

  constructor() {
    super({ configName: "power-preferences", defaults: { enabled: true } });
    makeObservable(this, { enabled: observable });
  }

  fromStore(data: { enabled?: boolean }): void {
    this.enabled = data.enabled !== false;
  }

  toJSON() {
    return { enabled: this.enabled };
  }
}
