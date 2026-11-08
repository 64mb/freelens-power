import { expect, it, vi } from "vitest";

vi.mock("@freelensapp/extensions", () => ({ Common: { Store: { ExtensionStore: class {} } } }));

import { PowerPreferencesStore } from "./power-preferences-store";

it("defaults update checks on for existing preferences and preserves explicit opt-out across master toggles", () => {
  const store = new PowerPreferencesStore();
  expect(store.checkUpdates).toBe(true);
  store.fromStore({ enabled: false });
  expect(store.checkUpdates).toBe(true);
  store.fromStore({ enabled: true, checkUpdates: false });
  store.enabled = false;
  const restored = new PowerPreferencesStore();
  restored.fromStore(store.toJSON());
  expect(restored.toJSON()).toEqual({
    enabled: false,
    checkUpdates: false,
    nodeBulkActions: true,
    hotbarShortcuts: true,
    hotbarItemShortcuts: true,
  });
  restored.enabled = true;
  expect(restored.checkUpdates).toBe(false);
});

it("defaults bulk actions on for old settings and persists the unified opt-out", () => {
  const store = new PowerPreferencesStore();
  store.fromStore({ enabled: true });
  expect(store.nodeBulkActions).toBe(true);
  const legacy = { enabled: true, nodeBulkActions: false, podBulkActions: true };
  store.fromStore(legacy);
  const restored = new PowerPreferencesStore();
  restored.fromStore(store.toJSON());
  expect(restored.nodeBulkActions).toBe(false);
  expect(restored.toJSON()).not.toHaveProperty("podBulkActions");
  restored.fromStore({ ...restored.toJSON(), nodeBulkActions: true });
  const next = new PowerPreferencesStore();
  next.fromStore(restored.toJSON());
  expect(next.nodeBulkActions).toBe(true);
});

it("enables hotbar shortcuts for legacy settings and preserves their explicit opt-out", () => {
  const store = new PowerPreferencesStore();
  store.fromStore({ enabled: true });
  expect(store.hotbarShortcuts).toBe(true);
  store.hotbarShortcuts = false;
  const restored = new PowerPreferencesStore();
  restored.fromStore(store.toJSON());
  expect(restored.hotbarShortcuts).toBe(false);
});

it("persists item shortcuts separately from panel shortcuts with backward-compatible defaults", () => {
  const store = new PowerPreferencesStore();
  store.fromStore({ hotbarShortcuts: false });
  expect(store.hotbarItemShortcuts).toBe(true);
  store.hotbarItemShortcuts = false;
  const restored = new PowerPreferencesStore();
  restored.fromStore(store.toJSON());
  expect(restored.hotbarItemShortcuts).toBe(false);
  expect(restored.hotbarShortcuts).toBe(false);
  restored.hotbarShortcuts = true;
  expect(restored.hotbarItemShortcuts).toBe(false);
});
