import { isObservableProp } from "mobx";
import { describe, expect, it, vi } from "vitest";

vi.mock("@freelensapp/extensions", () => ({ Common: { Store: { ExtensionStore: class {} } } }));

import { NodeShellPreferencesStore } from "./node-shell-preferences-store";

describe("Node Shell preferences", () => {
  it("requires explicit opt-in when loading existing settings", () => {
    const store = new NodeShellPreferencesStore();
    expect(store.replaceDefaultNodeShell).toBe(false);
    expect(isObservableProp(store, "replaceDefaultNodeShell")).toBe(true);
    store.fromStore({ command: "connect", preferIPv6: true, useColimaSSH: false });
    expect(store.toJSON()).toEqual({
      command: "connect",
      preferIPv6: true,
      useColimaSSH: false,
      replaceDefaultNodeShell: false,
    });
  });

  it("preserves replacement across reloads and restores the default when disabled", () => {
    const store = new NodeShellPreferencesStore();
    store.replaceDefaultNodeShell = true;
    const restored = new NodeShellPreferencesStore();
    restored.fromStore(store.toJSON());
    expect(restored.replaceDefaultNodeShell).toBe(true);
    restored.fromStore({ replaceDefaultNodeShell: false });
    expect(restored.replaceDefaultNodeShell).toBe(false);
  });
});
