import { Common } from "@freelensapp/extensions";
import { action, makeObservable, observable } from "mobx";
import { type HistoryIdentity, validHistoryIdentity } from "../monitoring-history";

export class MonitoringPreferencesStore extends Common.Store.ExtensionStore<{
  enabled: boolean;
  diagnosticsVisible: boolean;
  relationshipsVisible: boolean;
  historyEnabled: boolean;
  trackedHistory: HistoryIdentity[];
}> {
  enabled = false;
  diagnosticsVisible = true;
  relationshipsVisible = true;
  historyEnabled = false;
  trackedHistory: HistoryIdentity[] = [];

  constructor() {
    super({
      configName: "monitoring-preferences",
      defaults: {
        enabled: false,
        diagnosticsVisible: true,
        relationshipsVisible: true,
        historyEnabled: false,
        trackedHistory: [],
      },
    });
    makeObservable(this, {
      enabled: observable,
      diagnosticsVisible: observable,
      relationshipsVisible: observable,
      historyEnabled: observable,
      trackedHistory: observable,
      fromStore: action,
    });
  }

  fromStore(data: {
    enabled?: boolean;
    diagnosticsVisible?: boolean;
    relationshipsVisible?: boolean;
    historyEnabled?: boolean;
    trackedHistory?: HistoryIdentity[];
  }): void {
    this.enabled = data?.enabled === true;
    this.diagnosticsVisible = data?.diagnosticsVisible !== false;
    this.relationshipsVisible = data?.relationshipsVisible !== false;
    this.historyEnabled = data?.historyEnabled === true;
    this.trackedHistory = Array.isArray(data?.trackedHistory)
      ? data.trackedHistory
          .filter(validHistoryIdentity)
          .slice(0, 100)
          .map(({ clusterId, scope, uid }) => ({ clusterId, scope, uid }))
      : [];
  }

  toJSON(): {
    enabled: boolean;
    diagnosticsVisible: boolean;
    relationshipsVisible: boolean;
    historyEnabled: boolean;
    trackedHistory: HistoryIdentity[];
  } {
    return {
      enabled: this.enabled,
      diagnosticsVisible: this.diagnosticsVisible,
      relationshipsVisible: this.relationshipsVisible,
      historyEnabled: this.historyEnabled,
      trackedHistory: this.trackedHistory.map(({ clusterId, scope, uid }) => ({ clusterId, scope, uid })),
    };
  }
}
