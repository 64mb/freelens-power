// SPDX-License-Identifier: Apache-2.0
import { observable, runInAction } from "mobx";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setIcon: vi.fn(),
  createFromPath: vi.fn(),
  createFromBitmap: vi.fn(),
  getStore: vi.fn(),
  execFile: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({ mkdtemp: vi.fn().mockResolvedValue("/test/temp/icon"), rm: mocks.rm }));
vi.mock("electron", () => ({
  app: {
    dock: { setIcon: mocks.setIcon },
    getPath: (name: string) => (name === "exe" ? "/test/Example.app/Contents/MacOS/Example" : "/test/temp"),
  },
  nativeImage: { createFromPath: mocks.createFromPath, createFromBitmap: mocks.createFromBitmap },
}));
vi.mock("../common/store/appearance-preferences-store", () => ({
  AppearancePreferencesStore: { getInstanceOrCreate: mocks.getStore },
  isAccentSelection: (color: string) => ["default", "#7060e8", "#0273ee"].includes(color),
}));

import { loadOriginalIcon, recolorIconBitmap, startDockIconOverride } from "./dock-icon";

const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

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

  it("preserves a padded rounded tile, white logo and antialiased alpha byte for byte", () => {
    const pixels = [
      [0, 0, 0, 0],
      [28, 28, 28, 255],
      [90, 90, 90, 180],
      [251, 251, 251, 255],
      [156, 164, 35, 255],
      [78, 82, 18, 128],
      [28, 28, 28, 255],
      [0, 0, 0, 0],
    ];
    const source = Buffer.from(pixels.flat());
    const tinted = recolorIconBitmap(source, "#7060e8");
    expect(tinted.length).toBe(source.length);
    for (let pixel = 0; pixel < pixels.length; pixel++) {
      expect(tinted[pixel * 4 + 3]).toBe(source[pixel * 4 + 3]);
      if (pixel !== 4 && pixel !== 5)
        expect(tinted.subarray(pixel * 4, pixel * 4 + 4)).toEqual(source.subarray(pixel * 4, pixel * 4 + 4));
    }
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
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, "", ""));
    const original = {
      isEmpty: () => false,
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap: () => Buffer.from([160, 167, 0, 255]),
    };
    mocks.createFromPath.mockReturnValue(original);
    mocks.createFromBitmap.mockReturnValue({ tinted: true });
    return { preferences, original };
  }

  it("loads the system-composed bundle icon instead of bare ICNS and cleans temporary output", async () => {
    const { original } = setup();
    expect(await loadOriginalIcon()).toBe(original);
    expect(mocks.execFile).toHaveBeenCalledWith(
      "/usr/bin/osascript",
      expect.arrayContaining(["/test/Example.app", "/test/temp/icon/icon.png"]),
      { timeout: 10_000 },
      expect.any(Function),
    );
    expect(mocks.createFromPath).toHaveBeenCalledWith("/test/temp/icon/icon.png");
    expect(mocks.rm).toHaveBeenCalledWith("/test/temp/icon", { recursive: true, force: true });
  });

  it("leaves the Dock untouched when macOS cannot render the colored icon", async () => {
    setup();
    mocks.createFromPath.mockReturnValue({ isEmpty: () => false, toBitmap: () => Buffer.from([0, 0, 0, 255]) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispose = startDockIconOverride();
    await flush();
    expect(mocks.setIcon).not.toHaveBeenCalled();
    dispose();
    expect(mocks.rm).toHaveBeenCalled();
  });

  it("restores the icon independently of interface accents and ignores a pending tint when disabled", async () => {
    const { preferences, original } = setup();
    const dispose = startDockIconOverride();
    runInAction(() => {
      preferences.recolorAppIcon = false;
    });
    await flush();
    expect(mocks.setIcon).not.toHaveBeenCalled();
    runInAction(() => {
      preferences.recolorAppIcon = true;
    });
    await flush();
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
    await flush();
    expect(mocks.setIcon).toHaveBeenCalledWith({ tinted: true });
    dispose();
    expect(mocks.setIcon).toHaveBeenLastCalledWith(original);
    runInAction(() => {
      preferences.accentColor = "#0273ee";
    });
    await flush();
    expect(mocks.setIcon).toHaveBeenCalledTimes(2);
  });

  it("ignores pending recoloring after selecting default or disposing", async () => {
    const { preferences } = setup();
    const dispose = startDockIconOverride();
    runInAction(() => {
      preferences.accentColor = "default";
    });
    await flush();
    expect(mocks.setIcon).not.toHaveBeenCalled();
    runInAction(() => {
      preferences.accentColor = "#0273ee";
    });
    dispose();
    await flush();
    expect(mocks.setIcon).not.toHaveBeenCalled();
  });
});
