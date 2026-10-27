import { describe, expect, it, vi } from "vitest";

vi.mock("@freelensapp/extensions", () => ({ Common: { Store: { ExtensionStore: class {} } } }));

import { HelmPreferencesStore } from "./helm-preferences-store";

describe("Helm preferences", () => {
  it("requires explicit opt-in and preserves the setting across updates", () => {
    const store = new HelmPreferencesStore();
    expect(store.enabled).toBe(false);
    store.fromStore({});
    expect(store.enabled).toBe(false);
    store.fromStore({ enabled: true });
    const restored = new HelmPreferencesStore();
    restored.fromStore(store.toJSON());
    expect(restored.enabled).toBe(true);
    restored.fromStore({ enabled: false });
    expect(restored.enabled).toBe(false);
  });
});
