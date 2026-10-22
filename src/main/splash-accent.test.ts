// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import { observable, runInAction } from "mobx";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  windows: [] as unknown[],
}));
const host = new EventEmitter();
vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/host/app",
    on: (...args: Parameters<EventEmitter["on"]>) => host.on(...args),
    removeListener: (...args: Parameters<EventEmitter["removeListener"]>) => host.removeListener(...args),
  },
  BrowserWindow: { getAllWindows: () => mocks.windows },
}));
vi.mock("../common/store/appearance-preferences-store", () => ({
  AppearancePreferencesStore: { getInstanceOrCreate: mocks.getStore },
  isAccentSelection: (color: string) => ["default", "#7060e8", "#0273ee"].includes(color),
}));

import { isNativeSplashUrl, startSplashAccentOverride } from "./splash-accent";

const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
let dispose: (() => void) | undefined;
afterEach(async () => {
  dispose?.();
  dispose = undefined;
  await flush();
  host.removeAllListeners();
  mocks.windows = [];
  vi.clearAllMocks();
});
function setup(url = "file:///host/app/static/splash.html") {
  const preferences = observable({ enabled: true, accentColor: "#7060e8", recolorAppIcon: true });
  mocks.getStore.mockReturnValue(preferences);
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => url,
    isDestroyed: () => false,
    insertCSS: vi.fn().mockResolvedValue("style-key"),
    removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
  });
  return { preferences, contents, window: { webContents: contents } };
}

it("trusts only the exact host splash file", () => {
  expect(isNativeSplashUrl("file:///host/app/static/splash.html", "/host/app")).toBe(true);
  for (const url of [
    "https://example.com/splash.html",
    "file:///other/static/splash.html",
    "file://example.com/host/app/static/splash.html",
    "invalid",
  ]) {
    expect(isNativeSplashUrl(url, "/host/app")).toBe(false);
  }
});
it("restores original styles on opt-out, default, disable and disposal", async () => {
  const { preferences, contents, window } = setup();
  mocks.windows = [window];
  dispose = startSplashAccentOverride();
  await flush();
  expect(contents.insertCSS).toHaveBeenLastCalledWith(expect.stringContaining(".icon svg path"), { cssOrigin: "user" });
  runInAction(() => {
    preferences.recolorAppIcon = false;
  });
  await flush();
  expect(contents.removeInsertedCSS).toHaveBeenCalledWith("style-key");
  expect(contents.insertCSS).toHaveBeenLastCalledWith(expect.not.stringContaining(".icon svg path"), {
    cssOrigin: "user",
  });
  expect(contents.insertCSS).toHaveBeenLastCalledWith(expect.stringContaining(".progress"), { cssOrigin: "user" });
  runInAction(() => {
    preferences.accentColor = "default";
  });
  await flush();
  expect(contents.insertCSS).toHaveBeenCalledTimes(2);
  runInAction(() => {
    preferences.accentColor = "#0273ee";
    preferences.enabled = false;
  });
  await flush();
  expect(contents.insertCSS).toHaveBeenCalledTimes(2);
  runInAction(() => {
    preferences.enabled = true;
  });
  await flush();
  dispose();
  await flush();
  expect(contents.removeInsertedCSS).toHaveBeenCalledTimes(3);
  expect(contents.listenerCount("dom-ready")).toBe(0);
  expect(host.listenerCount("browser-window-created")).toBe(0);
});
it("handles future windows and their first navigation without touching website namesakes", async () => {
  const { window, contents } = setup("about:blank");
  dispose = startSplashAccentOverride();
  host.emit("browser-window-created", {}, window);
  await flush();
  expect(contents.insertCSS).not.toHaveBeenCalled();
  contents.getURL = () => "https://example.com/static/splash.html";
  contents.emit("dom-ready");
  await flush();
  expect(contents.insertCSS).not.toHaveBeenCalled();
  contents.getURL = () => "file:///host/app/static/splash.html";
  contents.emit("dom-ready");
  await flush();
  expect(contents.insertCSS).toHaveBeenCalledOnce();
});
it("overrides the host colors while preserving the glow timing, stagger and alternate animation", async () => {
  const { window, contents } = setup();
  mocks.windows = [window];
  dispose = startSplashAccentOverride();
  await flush();
  const [css, options] = contents.insertCSS.mock.calls[0];
  expect(options).toEqual({ cssOrigin: "user" });
  expect(css).toContain("background: #7060e8 !important");
  expect(css).toContain("fill: #7060e8 !important");
  expect(css).toContain("animation-name: freelens-power-splash-glow !important");
  expect(css).toContain("from { opacity: 1; flex: 1; } to { opacity: 0; flex: 10; }");
  expect(css).not.toMatch(/animation-(?:duration|delay|direction|timing-function|iteration-count)\s*:/);
});
it("removes an insertion that completes after disposal", async () => {
  const { window, contents } = setup();
  let finish!: (key: string) => void;
  contents.insertCSS.mockReturnValue(
    new Promise<string>((resolve) => {
      finish = resolve;
    }),
  );
  mocks.windows = [window];
  dispose = startSplashAccentOverride();
  await flush();
  dispose();
  finish("late-style");
  await flush();
  expect(contents.removeInsertedCSS).toHaveBeenCalledWith("late-style");
});
