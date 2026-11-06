import { beforeEach, expect, it, vi } from "vitest";
import { CLUSTER_ICONS_CHANNEL } from "../common/cluster-icon-ipc";
import { clusterIconDataUrl, defaultClusterIconDesign } from "../common/cluster-icons";
import { ClusterIconsStore } from "../common/store/cluster-icons-store";
import {
  createClusterIconsService,
  createNativeClusterIconsHost,
  startClusterIcons,
  trustedClusterIconsSender,
} from "./cluster-icons";

const state = vi.hoisted(() => ({
  handlers: new Map(),
  power: { enabled: true },
  clusters: [{ id: "saved", name: "Display name" }],
  entities: [] as { metadata: { uid: string }; spec: { icon?: { src?: string; background?: string } } }[],
}));
vi.mock("./power-ipc", () => ({
  powerIpc: {
    handle: (key: string, handler: unknown) => state.handlers.set(key, handler),
    removeHandler: (key: string) => state.handlers.delete(key),
  },
}));
vi.mock("@freelensapp/extensions", () => ({
  Main: {
    Catalog: { getAllClusters: () => state.clusters, catalogEntities: { getItemsForApiKind: () => state.entities } },
  },
  Common: {
    Catalog: { KubernetesCluster: { apiVersion: "entity.k8slens.dev/v1alpha1", kind: "KubernetesCluster" } },
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

const design = defaultClusterIconDesign("Example");
function fixture(icon?: string) {
  const store = new ClusterIconsStore();
  let clusters = [{ id: "saved", name: "Example", preferences: { icon, unrelated: "keep" } }];
  const host = { clusters: () => clusters };
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
  state.entities = [];
});

it("lists saved clusters without requiring a live connection", () => {
  expect(fixture().service.request({ operation: "list" })).toEqual([
    { id: "saved", name: "Example", icon: undefined, design: undefined, customized: false },
  ]);
});

it.each([
  undefined,
  "data:image/png;base64,original",
  "#123456",
])("persists latest designs without changing native preferences (%s)", (original) => {
  const { service, store, host } = fixture(original);
  service.request({ operation: "apply", id: "saved", design });
  const changed = { ...design, label: "New" };
  expect(service.request({ operation: "apply", id: "saved", design: changed })[0]).toMatchObject({
    icon: clusterIconDataUrl(changed),
    customized: true,
  });
  expect(host.clusters()[0].preferences).toEqual({ icon: original, unrelated: "keep" });
  const restored = new ClusterIconsStore();
  restored.fromStore(JSON.parse(JSON.stringify(store.toJSON())));
  expect(createClusterIconsService(host, restored).list()[0]).toMatchObject({
    customized: true,
    icon: clusterIconDataUrl(changed),
  });
  expect(restored.toJSON()).toEqual({ icons: { saved: { design: changed } } });
});

it("rejects malformed designs and unavailable clusters without changing stored data", () => {
  const { service, store, remove } = fixture();
  expect(() => service.request({ operation: "apply", id: "saved", design: {} })).toThrow();
  expect(store.toJSON()).toEqual({ icons: {} });
  remove();
  expect(() => service.request({ operation: "apply", id: "saved", design })).toThrow("no longer available");
  expect(store.toJSON()).toEqual({ icons: {} });
});

it("discards legacy original icons while retaining saved designs", () => {
  const store = new ClusterIconsStore();
  store.fromStore({ icons: { saved: { design, originalIcon: "data:image/png;base64,legacy" } } } as Parameters<
    ClusterIconsStore["fromStore"]
  >[0]);
  expect(store.toJSON()).toEqual({ icons: { saved: { design } } });
});

function event(url = "https://renderer.freelens.app/extension/icons") {
  const frame = { url };
  return {
    senderFrame: frame,
    sender: { mainFrame: frame, getURL: () => url },
  } as import("electron").IpcMainInvokeEvent;
}

it("requires the trusted main renderer and rejects iframe impostors", () => {
  expect(trustedClusterIconsSender(event())).toBe(true);
  expect(trustedClusterIconsSender(event("https://renderer.freelens.app.attacker.example/"))).toBe(false);
  const iframe = event();
  Object.defineProperty(iframe, "senderFrame", { value: { url: iframe.sender.getURL() } });
  expect(trustedClusterIconsSender(iframe)).toBe(false);
});

it("rejects disabled or untrusted requests and unregisters the handler", () => {
  const stop = startClusterIcons(fixture().host);
  const handler = state.handlers.get(CLUSTER_ICONS_CHANNEL);
  expect(() => handler(event("https://example.com/"), { operation: "list" })).toThrow("unavailable");
  state.power.enabled = false;
  expect(() => handler(event(), { operation: "apply", id: "saved", design })).toThrow("unavailable");
  stop();
  expect(state.handlers.has(CLUSTER_ICONS_CHANNEL)).toBe(false);
});

it("reads native icons through public catalog snapshots without host store synchronization", () => {
  state.entities = [{ metadata: { uid: "saved" }, spec: { icon: { src: "data:image/png;base64,original" } } }];
  expect(createNativeClusterIconsHost().clusters()).toEqual([
    { id: "saved", name: "Display name", preferences: { icon: "data:image/png;base64,original" } },
  ]);
  expect(state.entities[0].spec.icon?.src).toBe("data:image/png;base64,original");
});
