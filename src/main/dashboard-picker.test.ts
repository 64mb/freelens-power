import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map(),
  windows: [] as any[],
  result: undefined as undefined | Promise<unknown>,
  installed: undefined as undefined | Promise<unknown>,
  owner: { isDestroyed: () => false },
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class BrowserWindow extends EventEmitter {
    static fromWebContents = () => mocks.owner;
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      getURL: () => "https://example.com/",
      setWindowOpenHandler: vi.fn(),
      executeJavaScriptInIsolatedWorld: vi.fn((_world: number, scripts: { code: string }[]) =>
        scripts[0].code.endsWith("; true")
          ? (mocks.installed ?? Promise.resolve(true))
          : (mocks.result ?? Promise.resolve("main:nth-child(1)")),
      ),
    });
    contentView = { setVisible: vi.fn() };
    setMenu = vi.fn();
    show = vi.fn();
    isDestroyed = () => this.destroyed;
    destroy = () => {
      this.destroyed = true;
      this.emit("closed");
    };
    loadURL = vi.fn(async () => {
      this.webContents.emit("did-finish-load");
    });
    constructor(public options: unknown) {
      super();
      mocks.windows.push(this);
    }
  }
  return {
    BrowserWindow,
    session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }) },
    ipcMain: {
      handle: (key: string, handler: unknown) => mocks.handlers.set(key, handler),
      removeHandler: (key: string) => mocks.handlers.delete(key),
    },
  };
});

import { DASHBOARD_PICK_ELEMENT } from "../common/dashboard-picker";
import { startDashboardPicker } from "./dashboard-picker";

const settings = "https://renderer.freelens.app/preferences/extension/freelens-power";
function event(url = settings) {
  const mainFrame = { url };
  return { senderFrame: mainFrame, sender: Object.assign(new EventEmitter(), { mainFrame, getURL: () => url }) };
}
beforeEach(() => {
  mocks.windows = [];
  mocks.handlers.clear();
  mocks.result = undefined;
  mocks.installed = undefined;
});
it("rejects forged websites, subframes and invalid URLs before opening a window", async () => {
  const stop = startDashboardPicker();
  const pick = mocks.handlers.get(DASHBOARD_PICK_ELEMENT);
  expect(await pick(event("https://website.example/preferences"), { url: "https://example.com" })).toEqual({
    status: "error",
  });
  const subframe = event();
  subframe.senderFrame = { url: settings };
  expect(await pick(subframe, { url: "https://example.com" })).toEqual({ status: "error" });
  expect(await pick(event(), { url: "file:///etc/passwd" })).toEqual({ status: "error" });
  expect(await pick(event(), { url: 12 })).toEqual({ status: "error" });
  expect(mocks.windows).toHaveLength(0);
  stop();
});
it("opens a sandboxed modal with shared authentication and returns only a bounded selector", async () => {
  const stop = startDashboardPicker();
  const result = await mocks.handlers.get(DASHBOARD_PICK_ELEMENT)(event(), { url: "https://example.com" });
  expect(result).toEqual({ status: "selected", selector: "main:nth-child(1)" });
  expect(mocks.windows[0].options).toMatchObject({
    modal: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:freelens-power-websites",
    },
  });
  expect(mocks.windows[0].destroyed).toBe(true);
  mocks.result = Promise.resolve("a".repeat(513));
  expect(await mocks.handlers.get(DASHBOARD_PICK_ELEMENT)(event(), { url: "https://example.com" })).toEqual({
    status: "canceled",
  });
  stop();
});
it("settles pending selection on native close and deactivation", async () => {
  mocks.result = new Promise(() => {});
  const stop = startDashboardPicker();
  const pick = mocks.handlers.get(DASHBOARD_PICK_ELEMENT);
  const pending = pick(event(), { url: "https://example.com" });
  mocks.windows[0].emit("closed");
  expect(await pending).toEqual({ status: "canceled" });
  const next = pick(event(), { url: "https://example.com" });
  stop();
  expect(await next).toEqual({ status: "canceled" });
});

it("cancels navigation and rejects a second request from the same renderer while selecting", async () => {
  mocks.result = new Promise(() => {});
  const stop = startDashboardPicker();
  const sender = event();
  const pick = mocks.handlers.get(DASHBOARD_PICK_ELEMENT);
  const pending = pick(sender, { url: "https://example.com" });
  expect(await pick(sender, { url: "https://example.com" })).toEqual({ status: "error" });
  const preventDefault = vi.fn();
  mocks.windows[0].webContents.emit("will-navigate", { preventDefault }, "https://example.com/next");
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(await pending).toEqual({ status: "canceled" });
  stop();
});

it("keeps website content hidden until the isolated pointer shield is installed", async () => {
  let installed!: (value: unknown) => void;
  mocks.installed = new Promise((resolve) => {
    installed = resolve;
  });
  mocks.result = new Promise(() => {});
  const stop = startDashboardPicker();
  const pending = mocks.handlers.get(DASHBOARD_PICK_ELEMENT)(event(), { url: "https://example.com" });
  const picker = mocks.windows[0];
  expect(picker.contentView.setVisible.mock.calls).toEqual([[false]]);
  expect(picker.show).toHaveBeenCalledOnce();
  expect(picker.contentView.setVisible.mock.invocationCallOrder[0]).toBeLessThan(
    picker.show.mock.invocationCallOrder[0],
  );
  expect(picker.contentView.setVisible.mock.invocationCallOrder[0]).toBeLessThan(
    picker.loadURL.mock.invocationCallOrder[0],
  );
  installed(true);
  await vi.waitFor(() => expect(picker.contentView.setVisible.mock.calls).toEqual([[false], [true]]));
  expect(picker.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
  stop();
  expect(await pending).toEqual({ status: "canceled" });
});

it("never reveals website content when installing the isolated shield fails", async () => {
  mocks.installed = Promise.reject(new Error("unreported installation details"));
  const stop = startDashboardPicker();
  expect(await mocks.handlers.get(DASHBOARD_PICK_ELEMENT)(event(), { url: "https://example.com" })).toEqual({
    status: "error",
  });
  expect(mocks.windows[0].contentView.setVisible.mock.calls).toEqual([[false]]);
  expect(mocks.windows[0].destroyed).toBe(true);
  stop();
});
