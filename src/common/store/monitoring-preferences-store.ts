import { Common } from "@freelensapp/extensions";
import { action, makeObservable, observable } from "mobx";

export class MonitoringPreferencesStore extends Common.Store.ExtensionStore<{ enabled: boolean }> {
  enabled = false;

  constructor() {
    super({ configName: "monitoring-preferences", defaults: { enabled: false } });
    makeObservable(this, { enabled: observable, fromStore: action });
  }

  fromStore(data: { enabled?: boolean }): void {
    this.enabled = data?.enabled === true;
  }

  toJSON(): { enabled: boolean } {
    return { enabled: this.enabled };
  }
}
