import { EventEmitter } from "node:events";
import { observable, runInAction } from "mobx";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ views: [] as any[], preferences: {} as any, cursor: { x: 0, y: 0 } }));
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
    screen: { getCursorScreenPoint: () => mocks.cursor },
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
  vi.useRealTimers();
  mocks.views.length = 0;
  nativeTheme.removeAllListeners();
});

it("uses an isolated 24px control with 12px margins, synchronized state and scoped toggle actions", () => {
  mocks.preferences = observable({ enabled: true, accentColor: "#7060e8" });
  let bounds = { x: 0, y: 0, width: 800, height: 600 };
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
    getContentBounds: () => bounds,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  const toggle = vi.fn();
  const control = createDashboardFloatingRefresh(window as never, true, toggle);
  const view = mocks.views[0];
  const html = () => decodeURIComponent(view.webContents.loadURL.mock.calls.at(-1)[0].split(",").slice(1).join(","));
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 764, y: 564, width: 24, height: 24 });
  expect(view.options.webPreferences).toMatchObject({ nodeIntegration: false, sandbox: true, contextIsolation: true });
  expect(html()).toContain('aria-pressed="true"');
  expect(html()).toContain('aria-label="Disable refresh"');
  expect(html()).not.toContain("title=");
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
  expect(html()).toContain('aria-label="Enable refresh (10s)"');
  runInAction(() => {
    mocks.preferences.accentColor = "#0273ee";
  });
  expect(html()).toContain("#0273ee");
  bounds = { x: 0, y: 0, width: 400, height: 300 };
  window.emit("resize");
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 364, y: 264, width: 24, height: 24 });
  control.dispose();
  control.dispose();
  expect(view.webContents.close).toHaveBeenCalledOnce();
  expect(window.contentView.removeChildView).toHaveBeenCalledWith(view);
  expect(window.listenerCount("resize")).toBe(0);
  expect(nativeTheme.listenerCount("updated")).toBe(0);
  open({ url: "https://freelens-power.invalid/dashboard-toggle-refresh" });
  expect(toggle).toHaveBeenCalledTimes(1);
});

it("shows a themed tooltip after hovering and removes its view and timers on exit and disposal", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  mocks.preferences = observable({ enabled: true, accentColor: "#7060e8" });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
    getContentBounds: () => ({ x: 100, y: 200, width: 800, height: 600 }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  const control = createDashboardFloatingRefresh(window as never, true, vi.fn());
  const button = mocks.views[0];
  mocks.cursor = { x: 875, y: 775 };
  button.webContents.emit("cursor-changed", {}, "pointer");
  vi.advanceTimersByTime(100);
  expect(mocks.views).toHaveLength(1);
  vi.advanceTimersByTime(50);
  const tooltip = mocks.views[1];
  const html = () => decodeURIComponent(tooltip.webContents.loadURL.mock.calls.at(-1)[0]);
  expect(window.contentView.addChildView).toHaveBeenLastCalledWith(tooltip);
  expect(tooltip.setBounds).toHaveBeenLastCalledWith({ x: 596, y: 530, width: 204, height: 34 });
  expect(html()).toContain('role="tooltip"');
  expect(html()).toContain("Disable refresh");
  expect(html()).toContain("#1e2124");
  expect(html()).not.toContain("dashboard-toggle-refresh");
  control.update(false);
  expect(html()).toContain("Enable refresh (10s)");
  Object.assign(nativeTheme, { shouldUseDarkColors: false });
  nativeTheme.emit("updated");
  expect(html()).toContain("#f1f1f1");
  Object.assign(nativeTheme, { shouldUseDarkColors: true });
  mocks.cursor = { x: 300, y: 400 };
  vi.advanceTimersByTime(50);
  expect(window.contentView.removeChildView).toHaveBeenLastCalledWith(tooltip);
  expect(vi.getTimerCount()).toBe(0);
  mocks.cursor = { x: 875, y: 775 };
  button.webContents.emit("cursor-changed", {}, "pointer");
  vi.advanceTimersByTime(150);
  window.emit("blur");
  expect(vi.getTimerCount()).toBe(0);
  control.dispose();
  expect(tooltip.webContents.close).toHaveBeenCalledOnce();
  expect(button.webContents.listenerCount("cursor-changed")).toBe(0);
  expect(window.listenerCount("blur")).toBe(0);
});
