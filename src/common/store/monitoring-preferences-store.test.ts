import { expect, it, vi } from "vitest";

vi.mock("@freelensapp/extensions", () => ({ Common: { Store: { ExtensionStore: class {} } } }));

import { MonitoringPreferencesStore } from "./monitoring-preferences-store";

it("serializes observable tracked resources into IPC-safe plain data", () => {
  const store = new MonitoringPreferencesStore();
  store.fromStore({
    enabled: true,
    historyEnabled: true,
    trackedHistory: [{ clusterId: "sample-cluster", scope: "pod", uid: "sample-pod" }],
  });
  const serialized = structuredClone(store.toJSON());
  expect(serialized).toEqual({
    enabled: true,
    diagnosticsVisible: true,
    relationshipsVisible: true,
    resourceSearchEnabled: true,
    hiddenUpstreamClusters: [],
    historyEnabled: true,
    trackedHistory: [{ clusterId: "sample-cluster", scope: "pod", uid: "sample-pod" }],
  });
  store.fromStore({ enabled: false, historyEnabled: false, trackedHistory: [] });
  expect(serialized.trackedHistory).toHaveLength(1);
  store.fromStore(serialized);
  expect(structuredClone(store.toJSON())).toEqual(serialized);
});

it("serializes an empty observable tracking list when updating monitoring switches", () => {
  const store = new MonitoringPreferencesStore();
  store.fromStore({ enabled: true, historyEnabled: true });
  expect(structuredClone(store.toJSON())).toEqual({
    enabled: true,
    diagnosticsVisible: true,
    relationshipsVisible: true,
    resourceSearchEnabled: true,
    hiddenUpstreamClusters: [],
    historyEnabled: true,
    trackedHistory: [],
  });
});

it("keeps Diagnostics visible for existing settings and preserves an explicit hidden preference", () => {
  const store = new MonitoringPreferencesStore();
  store.fromStore({ enabled: true });
  expect(store.diagnosticsVisible).toBe(true);
  store.fromStore({ enabled: true, diagnosticsVisible: false });
  expect(structuredClone(store.toJSON()).diagnosticsVisible).toBe(false);
});

it("keeps relationship beta visible for existing settings and preserves explicit disablement", () => {
  const store = new MonitoringPreferencesStore();
  store.fromStore({ enabled: true });
  expect(store.relationshipsVisible).toBe(true);
  store.fromStore({ enabled: true, relationshipsVisible: false });
  expect(structuredClone(store.toJSON()).relationshipsVisible).toBe(false);
});

it("restores hidden upstreams per cluster as bounded IPC-safe preferences", () => {
  const store = new MonitoringPreferencesStore();
  store.fromStore({ hiddenUpstreamClusters: ["one", "two", "one", ""] });
  const snapshot = structuredClone(store.toJSON());
  expect(snapshot.hiddenUpstreamClusters).toEqual(["one", "two"]);
  store.hiddenUpstreamClusters = ["two"];
  expect(snapshot.hiddenUpstreamClusters).toEqual(["one", "two"]);
  store.fromStore(snapshot);
  expect(store.hiddenUpstreamClusters.includes("one")).toBe(true);
  expect(store.hiddenUpstreamClusters.includes("other")).toBe(false);
  store.fromStore({});
  expect(store.hiddenUpstreamClusters).toEqual([]);
});

it("enables search for existing settings and persists an explicit full-feature disable across reloads", () => {
  const store = new MonitoringPreferencesStore();
  store.fromStore({});
  expect(store.resourceSearchEnabled).toBe(true);
  store.resourceSearchEnabled = false;
  const restored = new MonitoringPreferencesStore();
  restored.fromStore(structuredClone(store.toJSON()));
  expect(restored.resourceSearchEnabled).toBe(false);
  expect(restored.relationshipsVisible).toBe(true);
  restored.resourceSearchEnabled = true;
  store.fromStore(restored.toJSON());
  expect(store.resourceSearchEnabled).toBe(true);
});
