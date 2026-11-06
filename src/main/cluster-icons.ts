import { Common, Main } from "@freelensapp/extensions";
import { runInAction } from "mobx";
import { CLUSTER_ICONS_CHANNEL, type ClusterIconEntry } from "../common/cluster-icon-ipc";
import { clusterIconDataUrl, normalizeClusterIconDesign } from "../common/cluster-icons";
import { ClusterIconsStore } from "../common/store/cluster-icons-store";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { powerIpc } from "./power-ipc";

import type { IpcMainInvokeEvent } from "electron";

export interface NativeIconCluster {
  id: string;
  name: string;
  preferences: { icon?: string | null };
}

export interface ClusterIconsHost {
  clusters(): NativeIconCluster[];
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
      const customized = !!saved;
      return {
        id: cluster.id,
        name: cluster.name,
        icon: saved ? clusterIconDataUrl(saved.design) : (cluster.preferences.icon ?? undefined),
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
  powerIpc.handle(CLUSTER_ICONS_CHANNEL, (event, payload: unknown) => {
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
    powerIpc.removeHandler(CLUSTER_ICONS_CHANNEL);
  };
}

export function createNativeClusterIconsHost(): ClusterIconsHost {
  return {
    clusters: () => {
      const entities = Main.Catalog.catalogEntities.getItemsForApiKind(
        Common.Catalog.KubernetesCluster.apiVersion,
        Common.Catalog.KubernetesCluster.kind,
      ) as import("@freelensapp/extensions").Common.Catalog.KubernetesCluster[];
      const icons = new Map(
        entities.map((entity) => [entity.metadata.uid, entity.spec.icon?.src ?? entity.spec.icon?.background]),
      );
      return Main.Catalog.getAllClusters().map((cluster) => ({
        id: cluster.id,
        name: cluster.name,
        preferences: { icon: icons.get(cluster.id) },
      }));
    },
  };
}
