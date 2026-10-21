import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";

export interface NodeShellPreferencesModel {
  command: string;
  preferIPv6: boolean;
  useColimaSSH: boolean;
}

export class NodeShellPreferencesStore extends Common.Store.ExtensionStore<NodeShellPreferencesModel> {
  @observable command = "ssh";
  @observable preferIPv6 = false;
  @observable useColimaSSH = true;

  constructor() {
    super({
      configName: "node-shell-preferences",
      defaults: { command: "ssh", preferIPv6: false, useColimaSSH: true },
    });
    makeObservable(this);
  }

  fromStore(data: Partial<NodeShellPreferencesModel>): void {
    this.command = typeof data.command === "string" ? data.command : "ssh";
    this.preferIPv6 = data.preferIPv6 === true;
    this.useColimaSSH = data.useColimaSSH !== false;
  }

  toJSON(): NodeShellPreferencesModel {
    return { command: this.command, preferIPv6: this.preferIPv6, useColimaSSH: this.useColimaSSH };
  }
}
