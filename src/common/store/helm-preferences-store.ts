import { Common } from "@freelensapp/extensions";
import { action, makeObservable, observable } from "mobx";

export class HelmPreferencesStore extends Common.Store.ExtensionStore<{ enabled: boolean }> {
  enabled = false;

  constructor() {
    super({ configName: "helm-preferences", defaults: { enabled: false } });
    makeObservable(this, { enabled: observable, fromStore: action });
  }

  fromStore(data: { enabled?: boolean }): void {
    this.enabled = data.enabled === true;
  }

  toJSON(): { enabled: boolean } {
    return { enabled: this.enabled };
  }
}
