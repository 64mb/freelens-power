import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ model: {} as unknown, listening: true, fail: false, emit: vi.fn() }));
vi.mock("node:fs", () => ({
  readFileSync: () => {
    if (state.fail) throw new Error("Unavailable");
    return JSON.stringify(state.model);
  },
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/native-config" },
  ipcMain: { listenerCount: () => Number(state.listening), emit: state.emit },
}));

import { EXTENSION_DISPLAY_NAME } from "../common/extension-info";
import { startDiagnosticsMenuOrder } from "./diagnostics-menu-order";

const key = `sidebar-item-${EXTENSION_DISPLAY_NAME}`;

beforeEach(() => {
  state.model = {};
  state.listening = true;
  state.fail = false;
  state.emit.mockClear();
});

it("places diagnostics between favorites and the next item while preserving native settings", () => {
  state.model = {
    metadata: { version: "example" },
    preferences: {
      colorTheme: "dark",
      clusterPageMenuOrder: { "sidebar-item-favorites": 20, "sidebar-item-cluster-overview": 21, [key]: 9999 },
    },
  };
  const original = structuredClone(state.model);
  const dispose = startDiagnosticsMenuOrder();
  expect(state.emit).toHaveBeenCalledWith(
    "store-sync-main:/native-config/lens-user-store.json",
    { frameId: -1, processId: process.pid },
    {
      metadata: { version: "example" },
      preferences: {
        colorTheme: "dark",
        clusterPageMenuOrder: { "sidebar-item-favorites": 20, "sidebar-item-cluster-overview": 21, [key]: 20.5 },
      },
    },
  );
  expect(state.model).toEqual(original);
  dispose();
  expect(state.emit).toHaveBeenCalledTimes(1);
});

it("uses native defaults for a new installation", () => {
  startDiagnosticsMenuOrder();
  expect(state.emit.mock.calls[0][2]).toEqual({ preferences: { clusterPageMenuOrder: { [key]: 5 } } });
});

it("preserves the user's explicit diagnostics position", () => {
  state.model = { preferences: { clusterPageMenuOrder: { [key]: 45 } } };
  startDiagnosticsMenuOrder();
  expect(state.emit).not.toHaveBeenCalled();
});

it.each([
  null,
  [],
  { preferences: [] },
  { preferences: { clusterPageMenuOrder: [] } },
  { preferences: { clusterPageMenuOrder: { other: "invalid" } } },
])("ignores malformed native settings: %j", (model) => {
  state.model = model;
  expect(() => startDiagnosticsMenuOrder()()).not.toThrow();
  expect(state.emit).not.toHaveBeenCalled();
});

it("does not break startup when native storage or synchronization is unavailable", () => {
  state.fail = true;
  expect(() => startDiagnosticsMenuOrder()()).not.toThrow();
  state.fail = false;
  state.listening = false;
  expect(() => startDiagnosticsMenuOrder()()).not.toThrow();
  expect(state.emit).not.toHaveBeenCalled();
});
