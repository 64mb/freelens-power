import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";
import { normalizePowerLogsLimits } from "../power-logs-limits";

import type { PowerLogsLimits } from "../power-logs";

export class LogsPreferencesStore extends Common.Store.ExtensionStore<{
  enabled: boolean;
  gentle: boolean;
  compactRows: boolean;
  limits: PowerLogsLimits;
}> {
  enabled = false;
  gentle = true;
  compactRows = false;
  limits = normalizePowerLogsLimits(undefined);

  constructor() {
    super({
      configName: "logs-preferences",
      defaults: { enabled: false, gentle: true, compactRows: false, limits: normalizePowerLogsLimits(undefined) },
    });
    makeObservable(this, { enabled: observable, gentle: observable, compactRows: observable, limits: observable });
  }

  fromStore(data: { enabled?: boolean; gentle?: boolean; compactRows?: boolean; limits?: unknown }): void {
    this.enabled = data?.enabled === true;
    this.gentle = data?.gentle !== false;
    this.compactRows = data?.compactRows === true;
    this.limits = normalizePowerLogsLimits(data?.limits);
  }

  toJSON() {
    return {
      enabled: this.enabled,
      gentle: this.gentle,
      compactRows: this.compactRows,
      limits: normalizePowerLogsLimits(this.limits),
    };
  }
}
