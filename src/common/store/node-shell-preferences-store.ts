import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";

export interface NodeShellPreferencesModel {
  command: string;
  replaceDefaultNodeShell: boolean;
  preferIPv6: boolean;
  useColimaSSH: boolean;
}

export class NodeShellPreferencesStore extends Common.Store.ExtensionStore<NodeShellPreferencesModel> {
  command = "ssh";
  replaceDefaultNodeShell = false;
  preferIPv6 = false;
  useColimaSSH = true;

  constructor() {
    super({
      configName: "node-shell-preferences",
      defaults: { command: "ssh", replaceDefaultNodeShell: false, preferIPv6: false, useColimaSSH: true },
    });
    makeObservable(this, {
      command: observable,
      replaceDefaultNodeShell: observable,
      preferIPv6: observable,
      useColimaSSH: observable,
    });
  }

  fromStore(data: Partial<NodeShellPreferencesModel>): void {
    this.command = typeof data.command === "string" ? data.command : "ssh";
    this.replaceDefaultNodeShell = data.replaceDefaultNodeShell === true;
    this.preferIPv6 = data.preferIPv6 === true;
    this.useColimaSSH = data.useColimaSSH !== false;
  }

  toJSON(): NodeShellPreferencesModel {
    return {
      command: this.command,
      replaceDefaultNodeShell: this.replaceDefaultNodeShell,
      preferIPv6: this.preferIPv6,
      useColimaSSH: this.useColimaSSH,
    };
  }
}
