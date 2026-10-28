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
  expect(restored.toJSON()).toEqual({ enabled: false, checkUpdates: false });
  restored.enabled = true;
  expect(restored.checkUpdates).toBe(false);
});
