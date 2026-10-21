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
