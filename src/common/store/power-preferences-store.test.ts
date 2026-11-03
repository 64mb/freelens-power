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
    podBulkActions: true,
  });
  restored.enabled = true;
  expect(restored.checkUpdates).toBe(false);
});

it("defaults bulk actions on for old settings and preserves independent opt-outs", () => {
  const store = new PowerPreferencesStore();
  store.fromStore({ enabled: true });
  expect(store.nodeBulkActions).toBe(true);
  expect(store.podBulkActions).toBe(true);
  store.nodeBulkActions = false;
  const restored = new PowerPreferencesStore();
  restored.fromStore(store.toJSON());
  expect(restored.nodeBulkActions).toBe(false);
  expect(restored.podBulkActions).toBe(true);
  restored.fromStore({ ...restored.toJSON(), nodeBulkActions: true, podBulkActions: false });
  const next = new PowerPreferencesStore();
  next.fromStore(restored.toJSON());
  expect(next.nodeBulkActions).toBe(true);
  expect(next.podBulkActions).toBe(false);
});
