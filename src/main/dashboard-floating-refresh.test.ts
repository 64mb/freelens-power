import { EventEmitter } from "node:events";
import { observable, runInAction } from "mobx";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ views: [] as any[], preferences: {} as any }));
vi.mock("../common/store/appearance-preferences-store", () => ({
  ACCENT_COLOR_OPTIONS: [
    { value: "#7060e8", color: "#7060e8" },
    { value: "#0273ee", color: "#0273ee" },
  ],
  AppearancePreferencesStore: { getInstanceOrCreate: () => mocks.preferences },
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: true }),
    WebContentsView: class {
      setBounds = vi.fn();
      setBackgroundColor = vi.fn();
      webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        loadURL: vi.fn().mockResolvedValue(undefined),
        setWindowOpenHandler: vi.fn(),
        close: vi.fn(),
      });
      constructor(public options: unknown) {
        mocks.views.push(this);
      }
    },
  };
});

import { nativeTheme } from "electron";
import { createDashboardFloatingRefresh } from "./dashboard-floating-refresh";

afterEach(() => {
  mocks.views.length = 0;
  nativeTheme.removeAllListeners();
});

it("uses an isolated 20px control with 8px margins, synchronized state and scoped toggle actions", () => {
  mocks.preferences = observable({ enabled: true, accentColor: "#7060e8" });
  let bounds = { width: 800, height: 600 };
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getContentBounds: () => bounds,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  const toggle = vi.fn();
  const control = createDashboardFloatingRefresh(window as never, true, toggle);
  const view = mocks.views[0];
  const html = () => decodeURIComponent(view.webContents.loadURL.mock.calls.at(-1)[0].split(",").slice(1).join(","));
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 772, y: 572, width: 20, height: 20 });
  expect(view.options.webPreferences).toMatchObject({ nodeIntegration: false, sandbox: true, contextIsolation: true });
  expect(html()).toContain('aria-pressed="true"');
  expect(html()).toContain('title="Disable refresh"');
  const open = view.webContents.setWindowOpenHandler.mock.calls[0][0];
  expect(open({ url: "https://example.com/" })).toEqual({ action: "deny" });
  expect(toggle).not.toHaveBeenCalled();
  expect(open({ url: "https://freelens-power.invalid/dashboard-toggle-refresh?" })).toEqual({ action: "deny" });
  expect(toggle).toHaveBeenCalledTimes(1);
  const preventDefault = vi.fn();
  view.webContents.emit("will-navigate", { preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  control.update(false);
  expect(html()).toContain('aria-pressed="false"');
  expect(html()).toContain('title="Enable refresh (10s)"');
  runInAction(() => {
    mocks.preferences.accentColor = "#0273ee";
  });
  expect(html()).toContain("#0273ee");
  bounds = { width: 400, height: 300 };
  window.emit("resize");
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 372, y: 272, width: 20, height: 20 });
  control.dispose();
  control.dispose();
  expect(view.webContents.close).toHaveBeenCalledOnce();
  expect(window.contentView.removeChildView).toHaveBeenCalledWith(view);
  expect(window.listenerCount("resize")).toBe(0);
  expect(nativeTheme.listenerCount("updated")).toBe(0);
  open({ url: "https://freelens-power.invalid/dashboard-toggle-refresh" });
  expect(toggle).toHaveBeenCalledTimes(1);
});
