import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  handlers: new Map(),
  power: { enabled: true },
  native: { clusters: [] } as any,
  messages: [] as any[],
  listening: true,
}));
vi.mock("node:fs", () => ({ readFileSync: () => JSON.stringify(state.native) }));
vi.mock("electron", () => ({
  app: { getPath: () => "/native-config" },
  ipcMain: {
    listenerCount: () => (state.listening ? 1 : 0),
    emit: (channel: string, _event: unknown, model: any) => {
      state.messages.push({ channel, model: structuredClone(model) });
      state.native = structuredClone(model);
      for (const cluster of state.native.clusters)
        if (cluster.preferences.icon === null) delete cluster.preferences.icon;
    },
    handle: (key: string, handler: unknown) => state.handlers.set(key, handler),
    removeHandler: (key: string) => state.handlers.delete(key),
  },
}));
vi.mock("@freelensapp/extensions", () => ({
  Main: { Catalog: { getAllClusters: () => [{ id: "saved", name: "Display name" }] } },
  Common: {
    Store: {
      ExtensionStore: class {
        constructor(_options: unknown) {}
        static getInstanceOrCreate() {
          return new this({});
        }
      },
    },
  },
}));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => state.power },
}));

import { CLUSTER_ICONS_CHANNEL } from "../common/cluster-icon-ipc";
import { clusterIconDataUrl, defaultClusterIconDesign } from "../common/cluster-icons";
import { ClusterIconsStore } from "../common/store/cluster-icons-store";
import {
  createClusterIconsService,
  createNativeClusterIconsHost,
  type NativeIconCluster,
  startClusterIcons,
  trustedClusterIconsSender,
} from "./cluster-icons";

const design = defaultClusterIconDesign("Example");
function fixture(icon?: string) {
  const store = new ClusterIconsStore();
  let clusters: NativeIconCluster[] = [
    { id: "saved", name: "Example", preferences: { icon, ...{ unrelated: "keep" } } },
  ];
  const host = {
    clusters: () => clusters,
    setIcon: vi.fn((id: string, value: string) => {
      clusters.find((item) => item.id === id)!.preferences.icon = value;
    }),
  };
  return {
    store,
    host,
    service: createClusterIconsService(host, store),
    remove: () => {
      clusters = [];
    },
  };
}

beforeEach(() => {
  state.handlers.clear();
  state.power.enabled = true;
});

it("lists saved clusters without requiring a live connection", () => {
  const { service } = fixture();
  expect(service.request({ operation: "list" })).toEqual([
    { id: "saved", name: "Example", icon: undefined, design: undefined, customized: false },
  ]);
});

it.each([
  undefined,
  "data:image/png;base64,original",
  "#123456",
])("saves only the latest design across edits and restarts (%s)", (original) => {
  const { service, store, host } = fixture(original);
  service.request({ operation: "apply", id: "saved", design });
  const changed = { ...design, label: "New" };
  service.request({ operation: "apply", id: "saved", design: changed });
  expect(host.clusters()[0].preferences).toMatchObject({ icon: clusterIconDataUrl(changed), unrelated: "keep" });
  const restoredStore = new ClusterIconsStore();
  restoredStore.fromStore(JSON.parse(JSON.stringify(store.toJSON())));
  const restarted = createClusterIconsService(host, restoredStore);
  expect(restarted.list()[0].customized).toBe(true);
  expect(restoredStore.toJSON()).toEqual({ icons: { saved: { design: changed } } });
  expect(JSON.stringify(restoredStore.toJSON())).not.toContain("originalIcon");
});

it("rejects missing clusters and malformed designs without modifying saved preferences", () => {
  const { service, host, remove } = fixture();
  expect(() => service.request({ operation: "apply", id: "saved", design: {} })).toThrow();
  expect(host.setIcon).not.toHaveBeenCalled();
  remove();
  expect(() => service.request({ operation: "apply", id: "saved", design })).toThrow("no longer available");
});

it("does not save a design when the native host rejects the update", () => {
  const { service, host, store } = fixture("#123456");
  host.setIcon.mockImplementation(() => {
    throw new Error("removed");
  });
  expect(() => service.request({ operation: "apply", id: "saved", design })).toThrow();
  expect(store.toJSON()).toEqual({ icons: {} });
});

it("discards legacy original icons while retaining saved designs", () => {
  const store = new ClusterIconsStore();
  store.fromStore({ icons: { saved: { design, originalIcon: "data:image/png;base64,legacy" } } } as any);
  expect(store.toJSON()).toEqual({ icons: { saved: { design } } });
});

it("rejects the removed restore operation without changing native preferences", () => {
  const { service, host } = fixture();
  expect(() => service.request({ operation: "restore", id: "saved" })).toThrow("Invalid icon operation");
  expect(host.setIcon).not.toHaveBeenCalled();
});

function event(url = "https://renderer.freelens.app/extension/icons") {
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: frame, getURL: () => url } } as any;
}

it("requires the trusted main renderer for IPC", () => {
  expect(trustedClusterIconsSender(event())).toBe(true);
  expect(trustedClusterIconsSender(event("https://renderer.freelens.app.attacker.example/"))).toBe(false);
  const iframe = event();
  iframe.senderFrame = { url: iframe.sender.getURL() };
  expect(trustedClusterIconsSender(iframe)).toBe(false);
});

it("rejects disabled or untrusted requests and unregisters the handler", () => {
  const { host } = fixture();
  const stop = startClusterIcons(host);
  const handler = state.handlers.get(CLUSTER_ICONS_CHANNEL);
  expect(() => handler(event("https://example.com/"), { operation: "list" })).toThrow("unavailable");
  state.power.enabled = false;
  expect(() => handler(event(), { operation: "apply", id: "saved", design })).toThrow("unavailable");
  expect(host.setIcon).not.toHaveBeenCalled();
  stop();
  expect(state.handlers.has(CLUSTER_ICONS_CHANNEL)).toBe(false);
});

it("uses native synchronization and preserves newer settings and other saved clusters", () => {
  state.messages = [];
  state.listening = true;
  state.native = {
    clusters: [
      {
        id: "saved",
        contextName: "Example",
        preferences: { icon: "#123456", clusterName: "Custom", unrelated: "keep" },
      },
      { id: "offline", contextName: "Offline", preferences: { unrelated: "other" } },
    ],
    unrelatedRoot: { keep: true },
  };
  const host = createNativeClusterIconsHost();
  expect(host.clusters().map((cluster) => [cluster.id, cluster.name])).toEqual([
    ["saved", "Display name"],
    ["offline", "Offline"],
  ]);
  state.native.clusters[0].preferences.unrelated = "newer";
  host.setIcon("saved", clusterIconDataUrl(design));
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0].channel).toBe("store-sync-main:/native-config/lens-cluster-store.json");
  expect(state.native).toMatchObject({
    unrelatedRoot: { keep: true },
    clusters: [
      { id: "saved", preferences: { icon: clusterIconDataUrl(design), unrelated: "newer" } },
      { id: "offline", preferences: { unrelated: "other" } },
    ],
  });
});

it("refuses malformed, removed or unavailable native stores before dispatch", () => {
  state.messages = [];
  state.listening = true;
  state.native = { clusters: [] };
  const host = createNativeClusterIconsHost();
  expect(() => host.setIcon("removed", "#123456")).toThrow("no longer available");
  state.native = {
    clusters: [
      { id: "saved", preferences: {} },
      { id: "saved", preferences: {} },
    ],
  };
  expect(() => host.setIcon("saved", "#123456")).toThrow("Invalid native");
  state.native = { clusters: [{ id: "saved", preferences: {} }] };
  state.listening = false;
  expect(() => host.setIcon("saved", "#123456")).toThrow("synchronization is unavailable");
  expect(state.messages).toEqual([]);
});

it("lists an empty native store without writing defaults back", () => {
  state.native = {};
  state.messages = [];
  const host = createNativeClusterIconsHost();
  expect(host.clusters()).toEqual([]);
  expect(state.native).toEqual({});
  expect(state.messages).toEqual([]);
});

it("applies icons for native clusters without saved preferences", () => {
  state.listening = true;
  state.messages = [];
  state.native = {
    clusters: [{ id: "saved", contextName: "Example", unrelated: { keep: true } }],
    unrelatedRoot: "keep",
  };
  const service = createClusterIconsService(createNativeClusterIconsHost(), new ClusterIconsStore());
  expect(service.list()[0]).toMatchObject({ id: "saved", customized: false });
  expect(state.native.clusters[0]).not.toHaveProperty("preferences");
  expect(service.request({ operation: "apply", id: "saved", design })[0].customized).toBe(true);
  expect(state.native).toMatchObject({
    clusters: [{ id: "saved", unrelated: { keep: true }, preferences: { icon: clusterIconDataUrl(design) } }],
    unrelatedRoot: "keep",
  });
  expect(state.native.clusters[0].unrelated).toEqual({ keep: true });
  expect(state.native.unrelatedRoot).toBe("keep");
});

it.each([
  { clusters: null },
  { clusters: {} },
  { clusters: [{ id: "saved", preferences: null }] },
  { clusters: [{ id: "saved", preferences: [] }] },
])("rejects explicitly malformed optional native fields (%j)", (model) => {
  state.native = model;
  state.messages = [];
  expect(() => createNativeClusterIconsHost().clusters()).toThrow("Invalid native");
  expect(state.messages).toEqual([]);
});
