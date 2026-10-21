import { Common } from "@freelensapp/extensions";
import { action, makeObservable, observable } from "mobx";

export interface ReadOnlyPreferencesModel {
  enabled: boolean;
}

export class ReadOnlyPreferencesStore extends Common.Store.ExtensionStore<ReadOnlyPreferencesModel> {
  enabled = false;

  constructor() {
    super({ configName: "read-only-preferences", defaults: { enabled: false } });
    makeObservable(this, { enabled: observable, fromStore: action });
  }

  fromStore(data: Partial<ReadOnlyPreferencesModel>): void {
    this.enabled = data?.enabled === true;
  }

  toJSON(): ReadOnlyPreferencesModel {
    return { enabled: this.enabled };
  }
}
