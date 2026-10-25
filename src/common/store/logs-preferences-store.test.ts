import { expect, it, vi } from "vitest";

vi.mock("@freelensapp/extensions", () => ({ Common: { Store: { ExtensionStore: class {} } } }));

import { POWER_LOGS_DEFAULT_LIMITS } from "../power-logs";
import { LogsPreferencesStore } from "./logs-preferences-store";

it("keeps normal row spacing for older preferences while preserving existing switches", () => {
  const store = new LogsPreferencesStore();
  expect(store.toJSON()).toEqual({
    enabled: false,
    gentle: true,
    compactRows: false,
    hideResourceNameColumn: false,
    limits: { ...POWER_LOGS_DEFAULT_LIMITS },
  });
  store.fromStore({ enabled: true, gentle: false });
  expect(store.toJSON()).toEqual({
    enabled: true,
    gentle: false,
    compactRows: false,
    hideResourceNameColumn: false,
    limits: { ...POWER_LOGS_DEFAULT_LIMITS },
  });
});

it("persists compact row spacing across preference reloads and restores the default when absent", () => {
  const store = new LogsPreferencesStore();
  store.compactRows = true;
  const restored = new LogsPreferencesStore();
  restored.fromStore(structuredClone(store.toJSON()));
  expect(restored.compactRows).toBe(true);
  restored.fromStore({});
  expect(restored.toJSON()).toEqual({
    enabled: false,
    gentle: true,
    compactRows: false,
    hideResourceNameColumn: false,
    limits: { ...POWER_LOGS_DEFAULT_LIMITS },
  });
});

it("normalizes persisted log limits and roundtrips them as plain data", () => {
  const store = new LogsPreferencesStore();
  store.fromStore({ limits: { liveRows: 750, historyConcurrency: 0, recordBytes: "invalid" } });
  expect(store.limits.liveRows).toBe(750);
  expect(store.limits.historyConcurrency).toBe(1);
  expect(store.limits.recordBytes).toBe(POWER_LOGS_DEFAULT_LIMITS.recordBytes);
  const snapshot = structuredClone(store.toJSON());
  const restored = new LogsPreferencesStore();
  restored.fromStore(snapshot);
  expect(restored.toJSON()).toEqual(snapshot);
  restored.fromStore({});
  expect(restored.limits).toEqual(POWER_LOGS_DEFAULT_LIMITS);
});

it("persists the resource name visibility switch without changing existing preferences or limits", () => {
  const store = new LogsPreferencesStore();
  store.fromStore({ enabled: true, gentle: false, compactRows: true, limits: { liveRows: 750 } });
  store.hideResourceNameColumn = true;
  const snapshot = structuredClone(store.toJSON());
  expect(snapshot).toMatchObject({ enabled: true, gentle: false, compactRows: true, hideResourceNameColumn: true });
  expect(snapshot.limits.liveRows).toBe(750);
  const restored = new LogsPreferencesStore();
  restored.fromStore(snapshot);
  expect(restored.toJSON()).toEqual(snapshot);
  expect(restored.hideResourceNameColumn).toBe(true);
});

it.each([
  undefined,
  false,
  "true",
  1,
  null,
  {},
  [],
])("requires strict true for the resource name visibility switch: %j", (value) => {
  const store = new LogsPreferencesStore();
  store.hideResourceNameColumn = true;
  store.fromStore({ hideResourceNameColumn: value } as Parameters<LogsPreferencesStore["fromStore"]>[0]);
  expect(store.hideResourceNameColumn).toBe(false);
  expect(store.toJSON().hideResourceNameColumn).toBe(false);
});
