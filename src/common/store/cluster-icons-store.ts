import { Common } from "@freelensapp/extensions";
import { makeObservable, observable } from "mobx";
import { type ClusterIconDesign, normalizeClusterIconDesign } from "../cluster-icons";

export interface SavedClusterIcon {
  design: ClusterIconDesign;
}

export interface ClusterIconsModel {
  icons: Record<string, SavedClusterIcon>;
}

export class ClusterIconsStore extends Common.Store.ExtensionStore<ClusterIconsModel> {
  icons: Record<string, SavedClusterIcon> = {};

  constructor() {
    super({ configName: "cluster-icons", defaults: { icons: {} }, syncOptions: { fireImmediately: true } });
    makeObservable(this, { icons: observable });
  }

  fromStore(data: Partial<ClusterIconsModel>): void {
    const entries: [string, SavedClusterIcon][] = [];
    if (data.icons && typeof data.icons === "object" && !Array.isArray(data.icons)) {
      for (const [id, entry] of Object.entries(data.icons)) {
        if (!id || !entry) continue;
        try {
          entries.push([id, { design: normalizeClusterIconDesign(entry.design) }]);
        } catch {
          // ignore invalid saved designs without discarding other clusters
        }
      }
    }
    this.icons = Object.fromEntries(entries);
  }

  toJSON(): ClusterIconsModel {
    return {
      icons: Object.fromEntries(Object.entries(this.icons).map(([id, value]) => [id, { design: { ...value.design } }])),
    };
  }
}
