import { createHash, webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ hook: undefined as any, dispose: vi.fn(), invoke: vi.fn() }));
vi.mock("@freelensapp/extensions", () => ({
  Common: { Catalog: { WebLink: { apiVersion: "v1", kind: "WebLink" } }, logger: { warn: vi.fn() } },
  Renderer: {
    Catalog: {
      catalogEntities: {
        addOnBeforeRun: (hook: any) => {
          mocks.hook = hook;
          return mocks.dispose;
        },
      },
    },
  },
}));
vi.mock("./ipc", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("../common/store/dashboard-preferences-store", () => ({
  DashboardPreferencesStore: {
    getInstanceOrCreate: () => ({ cards: [{ id: "site", title: "Example", url: "https://example.com", size: "M" }] }),
  },
}));

import { EXTENSION_ID } from "../common/extension-info";
import { startDashboardLinks } from "./dashboard-links";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("intercepts only generated extension links and removes its hook when disabled", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const stop = startDashboardLinks();
  const uid = `freelens-power-dashboard-link-${createHash("sha256").update("https://example.com/").digest("hex")}`;
  const target = {
    apiVersion: "v1",
    kind: "WebLink",
    metadata: { source: EXTENSION_ID },
    spec: { url: "https://example.com/" },
    getId: () => uid,
  };
  for (const entity of [
    { ...target, metadata: { source: "local" } },
    { ...target, getId: () => "manual-link" },
    { ...target, spec: { url: "https://other.example/" } },
    { ...target, kind: "KubernetesCluster" },
  ]) {
    const preventDefault = vi.fn();
    await mocks.hook({ target: entity, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  }
  const preventDefault = vi.fn();
  await mocks.hook({ target, preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("freelens-power:dashboard-views:open", { id: "site" });
  stop();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  await mocks.hook({ target, preventDefault });
  expect(mocks.invoke).toHaveBeenCalledOnce();
});
