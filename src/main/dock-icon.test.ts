// SPDX-License-Identifier: Apache-2.0
import { observable, runInAction } from "mobx";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setIcon: vi.fn(),
  createFromPath: vi.fn(),
  createFromBitmap: vi.fn(),
  getStore: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { dock: { setIcon: mocks.setIcon } },
  nativeImage: { createFromPath: mocks.createFromPath, createFromBitmap: mocks.createFromBitmap },
}));
vi.mock("../common/store/appearance-preferences-store", () => ({
  AppearancePreferencesStore: { getInstanceOrCreate: mocks.getStore },
  isAccentSelection: (color: string) => ["default", "#7060e8", "#0273ee"].includes(color),
}));

import { recolorIconBitmap, startDockIconOverride } from "./dock-icon";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Dock icon recoloring", () => {
  it("preserves white artwork, neutral shadows, transparency and the source buffer", () => {
    const source = Buffer.from([255, 255, 255, 255, 20, 20, 20, 128, 0, 0, 0, 0, 156, 164, 35, 255]);
    const before = Buffer.from(source);
    const result = recolorIconBitmap(source, "#7060e8");
    expect(result.subarray(0, 12)).toEqual(source.subarray(0, 12));
    expect(result.subarray(12)).toEqual(Buffer.from([232, 96, 112, 255]));
    expect(source).toEqual(before);
  });

  it("preserves alpha and premultiplied edge brightness", () => {
    const result = recolorIconBitmap(Buffer.from([78, 82, 18, 128]), "#0273ee");
    expect(result).toEqual(Buffer.from([119, 58, 1, 128]));
  });

  it("does nothing when the Dock API is unavailable", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(startDockIconOverride()).toBeTypeOf("function");
    expect(mocks.getStore).not.toHaveBeenCalled();
  });
});

describe("Dock icon lifecycle", () => {
  function setup() {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubGlobal("process", Object.assign(Object.create(process), { resourcesPath: "/test/resources" }));
    const preferences = observable({ enabled: true, accentColor: "#7060e8", recolorAppIcon: true });
    mocks.getStore.mockReturnValue(preferences);
    const original = {
      isEmpty: () => false,
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap: () => Buffer.from([160, 167, 0, 255]),
    };
    mocks.createFromPath.mockReturnValue(original);
    mocks.createFromBitmap.mockReturnValue({ tinted: true });
    return { preferences, original };
  }

  it("restores the icon independently of interface accents and ignores a pending tint when disabled", async () => {
    const { preferences, original } = setup();
    const dispose = startDockIconOverride();
    runInAction(() => {
      preferences.recolorAppIcon = false;
    });
    await Promise.resolve();
    expect(mocks.setIcon).not.toHaveBeenCalled();
    runInAction(() => {
      preferences.recolorAppIcon = true;
    });
    await Promise.resolve();
    expect(mocks.setIcon).toHaveBeenLastCalledWith({ tinted: true });
    runInAction(() => {
      preferences.recolorAppIcon = false;
    });
    expect(mocks.setIcon).toHaveBeenLastCalledWith(original);
    expect(preferences.enabled).toBe(true);
    expect(preferences.accentColor).toBe("#7060e8");
    dispose();
  });

  it("restores the original and stops observing on disposal", async () => {
    const { preferences, original } = setup();
    const dispose = startDockIconOverride();
    await Promise.resolve();
    expect(mocks.setIcon).toHaveBeenCalledWith({ tinted: true });
    dispose();
    expect(mocks.setIcon).toHaveBeenLastCalledWith(original);
    runInAction(() => {
      preferences.accentColor = "#0273ee";
    });
    await Promise.resolve();
    expect(mocks.setIcon).toHaveBeenCalledTimes(2);
  });

  it("ignores pending recoloring after selecting default or disposing", async () => {
    const { preferences } = setup();
    const dispose = startDockIconOverride();
    runInAction(() => {
      preferences.accentColor = "default";
    });
    await Promise.resolve();
    expect(mocks.setIcon).not.toHaveBeenCalled();
    runInAction(() => {
      preferences.accentColor = "#0273ee";
    });
    dispose();
    await Promise.resolve();
    expect(mocks.setIcon).not.toHaveBeenCalled();
  });
});
