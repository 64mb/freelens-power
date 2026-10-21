import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Main } from "@freelensapp/extensions";
import { app, type IpcMainInvokeEvent, ipcMain } from "electron";
import { runInAction } from "mobx";
import { CLUSTER_ICONS_CHANNEL, type ClusterIconEntry } from "../common/cluster-icon-ipc";
import { clusterIconDataUrl, normalizeClusterIconDesign } from "../common/cluster-icons";
import { ClusterIconsStore } from "../common/store/cluster-icons-store";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";

export interface NativeIconCluster {
  id: string;
  name: string;
  preferences: { icon?: string | null };
}

export interface ClusterIconsHost {
  clusters(): NativeIconCluster[];
  setIcon(id: string, icon: string): void;
}

export function trustedClusterIconsSender(event: IpcMainInvokeEvent): boolean {
  const trusted = (value: string) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        (url.hostname === "renderer.freelens.app" || url.hostname.endsWith(".renderer.freelens.app"))
      );
    } catch {
      return false;
    }
  };
  return (
    event.senderFrame === event.sender.mainFrame &&
    trusted(event.senderFrame?.url ?? "") &&
    trusted(event.sender.getURL())
  );
}

export function createClusterIconsService(host: ClusterIconsHost, store: ClusterIconsStore) {
  const list = (): ClusterIconEntry[] =>
    host.clusters().map((cluster) => {
      const saved = Object.hasOwn(store.icons, cluster.id) ? store.icons[cluster.id] : undefined;
      const customized = !!saved && cluster.preferences.icon === clusterIconDataUrl(saved.design);
      return {
        id: cluster.id,
        name: cluster.name,
        icon: cluster.preferences.icon ?? undefined,
        design: saved ? { ...saved.design } : undefined,
        customized,
      };
    });
  const request = (payload: unknown): ClusterIconEntry[] => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid icon request");
    const input = payload as { operation?: unknown; id?: unknown; design?: unknown };
    if (input.operation === "list") return list();
    if (input.operation !== "apply") throw new Error("Invalid icon operation");
    if (typeof input.id !== "string" || !input.id || input.id.length > 1024)
      throw new Error("Invalid cluster identifier");
    const cluster = host.clusters().find((entry) => entry.id === input.id);
    if (!cluster) throw new Error("Cluster is no longer available");
    const id = cluster.id;
    const design = normalizeClusterIconDesign(input.design);
    host.setIcon(id, clusterIconDataUrl(design));
    runInAction(() => {
      store.icons = { ...store.icons, [id]: { design } };
    });
    return list();
  };
  return { list, request };
}

export function startClusterIcons(host: ClusterIconsHost = createNativeClusterIconsHost()): () => void {
  const service = createClusterIconsService(host, ClusterIconsStore.getInstanceOrCreate<ClusterIconsStore>());
  let active = true;
  ipcMain.handle(CLUSTER_ICONS_CHANNEL, (event, payload: unknown) => {
    if (
      !active ||
      !PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled ||
      !trustedClusterIconsSender(event)
    )
      throw new Error("Cluster icons are unavailable");
    return service.request(payload);
  });
  return () => {
    active = false;
    ipcMain.removeHandler(CLUSTER_ICONS_CHANNEL);
  };
}

interface NativeClusterModel extends Record<string, unknown> {
  id: string;
  contextName?: string;
  preferences: Record<string, unknown> & { icon?: string | null; clusterName?: string };
}

interface NativeClustersModel extends Record<string, unknown> {
  clusters: NativeClusterModel[];
}

// the native storage listener updates live preferences, persists them and broadcasts catalog changes
export function createNativeClusterIconsHost(): ClusterIconsHost {
  const path = join(app.getPath("userData"), "lens-cluster-store.json");
  const channel = `store-sync-main:${path}`;
  const read = (): NativeClustersModel => {
    let model: unknown;
    try {
      model = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("Native cluster preferences are unavailable");
    }
    if (!model || typeof model !== "object" || Array.isArray(model))
      throw new Error("Invalid native cluster preferences");
    const normalized = model as NativeClustersModel;
    if (!Object.hasOwn(normalized, "clusters")) normalized.clusters = [];
    const clusters = normalized.clusters;
    const ids = new Set<string>();
    if (!Array.isArray(clusters)) throw new Error("Invalid native cluster preferences");
    for (const cluster of clusters) {
      if (cluster && typeof cluster === "object" && !Object.hasOwn(cluster, "preferences")) {
        cluster.preferences = {};
      }
      if (
        !cluster ||
        typeof cluster !== "object" ||
        typeof cluster.id !== "string" ||
        !cluster.id ||
        ids.has(cluster.id) ||
        !cluster.preferences ||
        typeof cluster.preferences !== "object" ||
        Array.isArray(cluster.preferences) ||
        (cluster.preferences.icon !== undefined &&
          cluster.preferences.icon !== null &&
          typeof cluster.preferences.icon !== "string")
      )
        throw new Error("Invalid native cluster preferences");
      ids.add(cluster.id);
    }
    return model as NativeClustersModel;
  };
  const send = (model: NativeClustersModel) => {
    if (!ipcMain.listenerCount(channel)) throw new Error("Native cluster preference synchronization is unavailable");
    ipcMain.emit(channel, { frameId: -1, processId: process.pid }, model);
  };
  return {
    clusters: () => {
      const names = new Map(Main.Catalog.getAllClusters().map((cluster) => [cluster.id, cluster.name]));
      return read().clusters.map((cluster) => ({
        id: cluster.id,
        name: names.get(cluster.id) ?? cluster.preferences.clusterName ?? cluster.contextName ?? "Kubernetes cluster",
        preferences: { icon: cluster.preferences.icon },
      }));
    },
    setIcon: (id, icon) => {
      // read immediately before dispatch so no asynchronous work can overwrite newer native settings
      const model = read();
      const cluster = model.clusters.find((entry) => entry.id === id);
      if (!cluster) throw new Error("Cluster is no longer available");
      cluster.preferences.icon = icon;
      send(model);
      const applied = read().clusters.find((entry) => entry.id === id)?.preferences.icon;
      if (applied !== icon) throw new Error("Native cluster icon was not saved");
    },
  };
}
