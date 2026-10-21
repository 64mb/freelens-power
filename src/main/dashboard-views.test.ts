// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import { observable, runInAction } from "mobx";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map(),
  permissions: { fetch: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
  views: [] as any[],
  floating: [] as any[],
  window: { isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } },
  external: vi.fn().mockResolvedValue(undefined),
  store: {
    cards: [
      {
        id: "site",
        title: "Example",
        url: "https://example.com",
        size: "M",
        autoRefresh: false,
        selector: undefined as string | undefined,
      },
    ],
  },
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class View {
    setBorderRadius = vi.fn();
    setBackgroundColor = vi.fn();
    setVisible = vi.fn();
    setBounds = vi.fn();
    addChildView = vi.fn();
    removeChildView = vi.fn();
  }
  class WebContentsView extends View {
    webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isLoading: vi.fn(() => false),
      getURL: vi.fn(() => "https://example.com/current"),
      close: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue(undefined),
      insertCSS: vi.fn().mockResolvedValue("styles"),
      setWindowOpenHandler: vi.fn(),
    });
    constructor(public options: unknown) {
      super();
      mocks.views.push(this);
    }
  }
  class BrowserWindow extends EventEmitter {
    static fromWebContents = () => mocks.window;
    webContents = new WebContentsView({}).webContents;
    contentView = new View();
    destroyed = false;
    isDestroyed = () => this.destroyed;
    setMenu = vi.fn();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setTitle = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    close = vi.fn(() => {
      this.destroyed = true;
      this.webContents.close();
      this.emit("closed");
    });
    destroy = vi.fn(() => this.close());
    constructor(public options: unknown) {
      super();
      mocks.floating.push(this);
    }
  }
  return {
    View,
    app: { getPath: () => "/unused" },
    session: { fromPartition: () => mocks.permissions },
    WebContentsView,
    BrowserWindow,
    shell: { openExternal: mocks.external },
    ipcMain: {
      handle: (name: string, fn: unknown) => mocks.handlers.set(name, fn),
      removeHandler: (name: string) => mocks.handlers.delete(name),
    },
  };
});
vi.mock("./dashboard-icon-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dashboard-icon-cache")>()),
  loadDashboardIcons: vi.fn().mockResolvedValue([]),
  saveDashboardIcons: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../common/store/dashboard-preferences-store", () => ({
  DashboardPreferencesStore: { getInstanceOrCreate: () => mocks.store },
}));

import { loadDashboardIcons } from "./dashboard-icon-cache";
import { startDashboardViews } from "./dashboard-views";

const sync = "freelens-power:dashboard-views:sync";
const url = "https://renderer.freelens.app/extension/freelens-power/dashboard";
function event() {
  const mainFrame = { url };
  const sender = Object.assign(new EventEmitter(), {
    mainFrame,
    getURL: (): string => url,
    getZoomFactor: () => 1,
    isDestroyed: () => false,
    send: vi.fn(),
  });
  return { sender, senderFrame: mainFrame };
}
const payload = {
  cards: [
    {
      id: "site",
      url: "https://attacker.example",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      clip: { x: 10, y: 30, width: 300, height: 190 },
    },
  ],
};
beforeEach(() => {
  mocks.store = observable(mocks.store);
  runInAction(() => {
    if (!mocks.store.cards.length)
      mocks.store.cards = [
        {
          id: "site",
          title: "Example",
          url: "https://example.com",
          size: "M",
          autoRefresh: false,
          selector: undefined,
        },
      ];
    mocks.store.cards[0].autoRefresh = false;
    mocks.store.cards[0].selector = undefined;
  });
  mocks.views.length = 0;
  mocks.floating.length = 0;
  vi.clearAllMocks();
  mocks.permissions.fetch.mockImplementation(
    async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
  );
});
it("accepts only the dashboard top frame and configured card URLs", () => {
  const dispose = startDashboardViews();
  const owner = event();
  const handler = mocks.handlers.get(sync);
  handler({ ...owner, senderFrame: { url } }, payload);
  handler({ ...owner, senderFrame: { url: "https://example.com" } }, payload);
  expect(mocks.views).toHaveLength(0);
  handler(owner, payload);
  expect(mocks.views).toHaveLength(1);
  const view = mocks.views[0];
  expect(view.options.webPreferences).toEqual({
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    partition: "persist:freelens-power-websites",
  });
  expect(view.webContents.loadURL).toHaveBeenCalledWith("https://example.com/");
  expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: -10, width: 300, height: 200 });
  expect(view.setBorderRadius).toHaveBeenCalledWith(12);
  view.webContents.emit("did-finish-load");
  expect(view.webContents.insertCSS).toHaveBeenCalledWith(expect.stringContaining("::-webkit-scrollbar"), {
    cssOrigin: "user",
  });
  const open = view.webContents.setWindowOpenHandler.mock.calls[0][0];
  expect(open({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
  expect(mocks.external).not.toHaveBeenCalled();
  open({ url: "https://example.org" });
  expect(mocks.external).toHaveBeenCalledWith("https://example.org");
  const preventDefault = vi.fn();
  view.webContents.emit("will-navigate", { preventDefault }, "file:///tmp/example");
  expect(preventDefault).toHaveBeenCalled();
  owner.sender.emit("did-navigate-in-page", {}, "https://renderer.freelens.app/other");
  expect(view.webContents.close).not.toHaveBeenCalled();
  expect(view.setVisible).not.toHaveBeenCalled();
  expect(owner.sender.listenerCount("destroyed")).toBe(1);
  owner.sender.emit("destroyed");
  expect(view.webContents.close).toHaveBeenCalledOnce();
  expect(owner.sender.listenerCount("destroyed")).toBe(0);
  dispose();
  expect(mocks.handlers.size).toBe(0);
});
it("rejects invalid geometry and closes removed views and all views on disposal", () => {
  const dispose = startDashboardViews();
  const owner = event();
  const handler = mocks.handlers.get(sync);
  handler(owner, { cards: [{ ...payload.cards[0], bounds: { ...payload.cards[0].bounds, width: Infinity } }] });
  expect(mocks.views).toHaveLength(0);
  handler(owner, payload);
  handler(owner, { cards: [], hidden: true });
  expect(mocks.views[0].webContents.close).not.toHaveBeenCalled();
  handler(owner, payload);
  expect(mocks.views).toHaveLength(1);
  expect(mocks.views[0].webContents.loadURL).toHaveBeenCalledOnce();
  handler(owner, { cards: [] });
  expect(mocks.views[0].webContents.close).not.toHaveBeenCalled();
  dispose();
  expect(mocks.views[0].webContents.close).toHaveBeenCalledOnce();
});

it("denies embedded website permissions", () => {
  const dispose = startDashboardViews();
  const callback = vi.fn();
  mocks.permissions.setPermissionRequestHandler.mock.calls[0][0]({}, "media", callback);
  expect(callback).toHaveBeenCalledWith(false);
  expect(mocks.permissions.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
  dispose();
});

it("scales native coordinates for page zoom and reports failed loads", async () => {
  const dispose = startDashboardViews();
  const owner = event();
  owner.sender.getZoomFactor = vi.fn(() => 1.5) as () => 1;
  await mocks.handlers.get(sync)(owner, payload);
  expect(mocks.views[0].setBounds).toHaveBeenCalledWith({ x: 0, y: -15, width: 450, height: 300 });
  mocks.views[0].webContents.loadURL.mockRejectedValueOnce(new Error("unreachable"));
  expect(await mocks.handlers.get("freelens-power:dashboard-views:reload")(owner, { id: "site" })).toEqual({
    failed: ["site"],
  });
  expect(await mocks.handlers.get(sync)(owner, payload)).toEqual({ failed: ["site"], pinned: [] });
  dispose();
});

it("uses safe website-reported icons and repeats them when an existing view is synchronized", async () => {
  const dispose = startDashboardViews();
  const owner = event();
  const handler = mocks.handlers.get(sync);
  await handler(owner, payload);
  const contents = mocks.views[0].webContents;
  contents.emit("page-favicon-updated", {}, ["javascript:alert(1)", "https://user:password@example.com/icon.png"]);
  expect(owner.sender.send).not.toHaveBeenCalled();
  contents.emit("page-favicon-updated", {}, ["javascript:alert(1)", "https://example.com/assets/icon.png"]);
  expect(owner.sender.send).toHaveBeenLastCalledWith("freelens-power:dashboard-site-icon", {
    id: "site",
    url: "https://example.com/assets/icon.png",
  });
  await vi.waitFor(() =>
    expect(owner.sender.send).toHaveBeenLastCalledWith("freelens-power:dashboard-site-icon", {
      id: "site",
      url: "data:image/png;base64,AQID",
    }),
  );
  owner.sender.send.mockClear();
  await handler(owner, payload);
  expect(owner.sender.send).toHaveBeenCalledOnce();
  dispose();
  owner.sender.send.mockClear();
  contents.emit("page-favicon-updated", {}, ["https://example.com/other.png"]);
  expect(owner.sender.send).not.toHaveBeenCalled();
});

it("loads icons through the website session and cancels late updates on disposal", async () => {
  const dispose = startDashboardViews();
  const owner = event();
  await mocks.handlers.get(sync)(owner, payload);
  const contents = mocks.views[0].webContents;
  contents.emit("page-favicon-updated", {}, ["https://example.com/icon.png"]);
  await vi.waitFor(() =>
    expect(owner.sender.send).toHaveBeenLastCalledWith("freelens-power:dashboard-site-icon", {
      id: "site",
      url: "data:image/png;base64,AQID",
    }),
  );
  expect(mocks.permissions.fetch).toHaveBeenCalledWith(
    "https://example.com/icon.png",
    expect.objectContaining({ credentials: "include", redirect: "manual" }),
  );
  let finish: (value: Response) => void = () => {};
  mocks.permissions.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  contents.emit("page-favicon-updated", {}, ["https://example.com/other.png"]);
  const signal = mocks.permissions.fetch.mock.calls.at(-1)?.[1].signal;
  dispose();
  expect(signal.aborted).toBe(true);
  owner.sender.send.mockClear();
  finish(new Response(new Uint8Array([4]), { headers: { "content-type": "image/png" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(owner.sender.send).not.toHaveBeenCalled();
});
it("rejects unsafe favicon redirects and non-image responses", async () => {
  const dispose = startDashboardViews();
  const owner = event();
  await mocks.handlers.get(sync)(owner, payload);
  mocks.permissions.fetch.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { location: "file:///tmp/icon.png" } }),
  );
  mocks.views[0].webContents.emit("page-favicon-updated", {}, ["https://example.com/icon.png"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.permissions.fetch).toHaveBeenCalledOnce();
  expect(owner.sender.send).toHaveBeenCalledOnce();
  mocks.permissions.fetch.mockResolvedValueOnce(new Response("text", { headers: { "content-type": "text/html" } }));
  mocks.views[0].webContents.emit("page-favicon-updated", {}, ["https://example.com/icon.png"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(owner.sender.send).toHaveBeenCalledTimes(2);
  dispose();
});

it("keeps pages alive across route changes, hides on unmount, and reloads only explicitly", async () => {
  const dispose = startDashboardViews();
  const owner = event();
  const syncViews = mocks.handlers.get(sync);
  await syncViews(owner, payload);
  const contents = mocks.views[0].webContents;
  const container = mocks.window.contentView.addChildView.mock.calls[0][0];
  owner.sender.emit("did-navigate-in-page", {}, "https://renderer.freelens.app/other");
  expect(container.setVisible).toHaveBeenLastCalledWith(false);
  expect(contents.close).not.toHaveBeenCalled();
  await syncViews(owner, payload);
  expect(container.setVisible).toHaveBeenLastCalledWith(true);
  expect(contents.loadURL).toHaveBeenCalledOnce();
  owner.sender.mainFrame.url = "https://renderer.freelens.app/other";
  owner.sender.getURL = () => owner.sender.mainFrame.url;
  mocks.handlers.get("freelens-power:dashboard-views:clear")(owner);
  expect(container.setVisible).toHaveBeenLastCalledWith(false);
  const reload = mocks.handlers.get("freelens-power:dashboard-views:reload");
  await reload(owner, { id: "site" });
  expect(contents.loadURL).toHaveBeenCalledOnce();
  owner.sender.mainFrame.url = url;
  expect(await reload(owner, { id: "site" })).toEqual({ failed: [] });
  expect(contents.loadURL).toHaveBeenLastCalledWith("https://example.com/current");
  expect(contents.loadURL).toHaveBeenCalledTimes(2);
  dispose();
});

it("refreshes enabled cached pages every ten minutes and applies settings while hidden", async () => {
  vi.useFakeTimers();
  const dispose = startDashboardViews();
  try {
    const owner = event();
    await mocks.handlers.get(sync)(owner, payload);
    const contents = mocks.views[0].webContents;
    owner.sender.mainFrame.url = "https://renderer.freelens.app/other";
    owner.sender.getURL = () => owner.sender.mainFrame.url;
    owner.sender.emit("did-navigate-in-page", {}, owner.sender.mainFrame.url);
    await vi.advanceTimersByTimeAsync(600000);
    expect(contents.loadURL).toHaveBeenCalledOnce();
    runInAction(() => {
      mocks.store.cards[0].autoRefresh = true;
    });
    await vi.advanceTimersByTimeAsync(599999);
    expect(contents.loadURL).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(contents.loadURL).toHaveBeenCalledTimes(2);
    expect(contents.loadURL).toHaveBeenLastCalledWith("https://example.com/current");
    owner.sender.mainFrame.url = url;
    await vi.advanceTimersByTimeAsync(600000);
    expect(contents.loadURL).toHaveBeenCalledTimes(2);
    owner.sender.mainFrame.url = "https://renderer.freelens.app/other";
    contents.isLoading.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(600000);
    expect(contents.loadURL).toHaveBeenCalledTimes(2);
    contents.isLoading.mockReturnValue(false);
    runInAction(() => {
      if (!mocks.store.cards.length)
        mocks.store.cards = [
          {
            id: "site",
            title: "Example",
            url: "https://example.com",
            size: "M",
            autoRefresh: false,
            selector: undefined,
          },
        ];
      mocks.store.cards[0].autoRefresh = false;
      mocks.store.cards[0].selector = undefined;
    });
    await vi.advanceTimersByTimeAsync(600000);
    expect(contents.loadURL).toHaveBeenCalledTimes(2);
    runInAction(() => {
      mocks.store.cards[0].autoRefresh = true;
    });
    dispose();
    await vi.advanceTimersByTimeAsync(600000);
    expect(contents.loadURL).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
    vi.useRealTimers();
  }
});

it("caches an icon that finishes loading away from the dashboard and replays it on return", async () => {
  const dispose = startDashboardViews();
  const owner = event();
  await mocks.handlers.get(sync)(owner, payload);
  let finish: (value: Response) => void = () => {};
  mocks.permissions.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  mocks.views[0].webContents.emit("page-favicon-updated", {}, ["https://example.com/icon.png"]);
  owner.sender.mainFrame.url = "https://renderer.freelens.app/other";
  owner.sender.getURL = () => owner.sender.mainFrame.url;
  owner.sender.send.mockClear();
  finish(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(owner.sender.send).toHaveBeenCalledExactlyOnceWith("freelens-power:dashboard-site-icons");
  owner.sender.mainFrame.url = url;
  await mocks.handlers.get(sync)(owner, payload);
  expect(owner.sender.send).toHaveBeenLastCalledWith("freelens-power:dashboard-site-icon", {
    id: "site",
    url: "data:image/png;base64,AQID",
  });
  dispose();
});

it("shares only cached image data with trusted host settings without fetching requested URLs", async () => {
  const dispose = startDashboardViews();
  const owner = event();
  await mocks.handlers.get(sync)(owner, payload);
  mocks.views[0].webContents.emit("page-favicon-updated", {}, ["https://example.com/assets/brand.png"]);
  const snapshot = mocks.handlers.get("freelens-power:dashboard-site-icons");
  await vi.waitFor(async () =>
    expect(await snapshot(owner)).toEqual([
      { id: "site", pageUrl: "https://example.com/", dataUrl: "data:image/png;base64,AQID" },
    ]),
  );
  const settingsUrl = "https://renderer.freelens.app/preferences";
  owner.senderFrame.url = settingsUrl;
  owner.sender.getURL = () => settingsUrl;
  expect(await snapshot(owner)).toHaveLength(1);
  expect(await snapshot({ ...owner, senderFrame: { url: settingsUrl } })).toEqual([]);
  owner.senderFrame.url = "https://example.com";
  expect(await snapshot(owner)).toEqual([]);
  owner.senderFrame.url = settingsUrl;
  const requests = mocks.permissions.fetch.mock.calls.length;
  await snapshot(owner, { url: "https://arbitrary.example/icon" });
  expect(mocks.permissions.fetch).toHaveBeenCalledTimes(requests);
  runInAction(() => {
    mocks.store.cards[0].url = "https://example.org";
  });
  expect(await snapshot(owner)).toEqual([]);
  runInAction(() => {
    mocks.store.cards[0].url = "https://example.com";
  });
  dispose();
});

it("loads saved icons before settings snapshot and discards old card identities without opening websites", async () => {
  vi.mocked(loadDashboardIcons).mockResolvedValueOnce([
    { id: "site", pageUrl: "https://example.com/", dataUrl: "data:image/png;base64,AQID" },
    { id: "removed", pageUrl: "https://example.org/", dataUrl: "data:image/png;base64,AQID" },
    { id: "site", pageUrl: "https://old.example/", dataUrl: "data:image/png;base64,AQID" },
  ]);
  const dispose = startDashboardViews();
  const owner = event();
  const settingsUrl = "https://renderer.freelens.app/preferences";
  owner.senderFrame.url = settingsUrl;
  owner.sender.getURL = () => settingsUrl;
  expect(await mocks.handlers.get("freelens-power:dashboard-site-icons")(owner)).toEqual([
    { id: "site", pageUrl: "https://example.com/", dataUrl: "data:image/png;base64,AQID" },
  ]);
  expect(mocks.views).toHaveLength(0);
  expect(mocks.permissions.fetch).not.toHaveBeenCalled();
  dispose();
});

it("updates selectors in cached hidden views without reloading website history", async () => {
  const dispose = startDashboardViews();
  const owner = event();
  await mocks.handlers.get(sync)(owner, payload);
  const contents = mocks.views[0].webContents;
  contents.emit("did-finish-load");
  expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1004, [
    { code: expect.stringContaining(')("")') },
  ]);
  await mocks.handlers.get(sync)(owner, { hidden: true });
  runInAction(() => {
    mocks.store.cards[0].selector = "main .chart";
  });
  expect(contents.executeJavaScriptInIsolatedWorld.mock.lastCall[1][0].code).toContain(')("main .chart")');
  contents.emit("did-finish-load");
  expect(contents.executeJavaScriptInIsolatedWorld.mock.lastCall[1][0].code).toContain(')("main .chart")');
  runInAction(() => {
    mocks.store.cards[0].selector = undefined;
  });
  expect(contents.executeJavaScriptInIsolatedWorld.mock.lastCall[1][0].code).toContain(')("")');
  expect(contents.loadURL).toHaveBeenCalledOnce();
  dispose();
  expect(contents.close).toHaveBeenCalledOnce();
});

it("forwards website Escape only to its trusted active dashboard owner", async () => {
  const dispose = startDashboardViews();
  const owner = event();
  await mocks.handlers.get(sync)(owner, payload);
  const website = mocks.views[0].webContents;
  owner.sender.send.mockClear();
  website.emit("before-input-event", {}, { type: "keyDown", key: "Escape" });
  expect(owner.sender.send).toHaveBeenCalledExactlyOnceWith("freelens-power:dashboard-escape");
  owner.sender.send.mockClear();
  website.emit("before-input-event", {}, { type: "keyUp", key: "Escape" });
  owner.sender.mainFrame.url = "https://renderer.freelens.app/other";
  website.emit("before-input-event", {}, { type: "keyDown", key: "Escape" });
  expect(owner.sender.send).not.toHaveBeenCalled();
  dispose();
});

it("pins one hardened duplicate, preserves the cached grid view and focuses without reopening", async () => {
  const dispose = startDashboardViews();
  const owner = event();
  const handler = mocks.handlers.get(sync);
  const pin = mocks.handlers.get("freelens-power:dashboard-views:pin");
  try {
    await handler(owner, payload);
    const original = mocks.views[0];
    expect(await pin({ ...owner, senderFrame: { url } }, { id: "site", pinned: true })).toBeUndefined();
    expect(await pin(owner, { id: "unknown", pinned: true })).toBeUndefined();
    expect(mocks.floating).toHaveLength(0);
    expect(await pin(owner, { id: "site", pinned: true, url: "https://attacker.example", width: 1 })).toEqual({
      pinned: ["site"],
    });
    const floating = mocks.floating[0];
    expect(floating.options).toMatchObject({
      title: "Example",
      width: 800,
      height: 600,
      resizable: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition: "persist:freelens-power-websites",
      },
    });
    expect(floating.setMenu).toHaveBeenCalledWith(null);
    expect(floating.setAlwaysOnTop).toHaveBeenCalledWith(true, "floating");
    expect(floating.webContents.loadURL).toHaveBeenCalledExactlyOnceWith("https://example.com/");
    expect(original.webContents.loadURL).toHaveBeenCalledOnce();
    expect(original.webContents.close).not.toHaveBeenCalled();
    expect(mocks.window.contentView.removeChildView).not.toHaveBeenCalled();
    const originalBounds = original.setBounds.mock.calls.length;
    await handler(owner, payload);
    await handler(owner, { hidden: true, cards: [] });
    owner.sender.emit("did-navigate-in-page", {}, "https://renderer.freelens.app/other");
    expect(original.setBounds).toHaveBeenCalledTimes(originalBounds);
    expect(floating.close).not.toHaveBeenCalled();
    expect(floating.webContents.close).not.toHaveBeenCalled();
    owner.sender.getURL = () => url;
    await pin(owner, { id: "site", focus: true });
    expect(floating.focus).toHaveBeenCalledOnce();
    expect(mocks.floating).toHaveLength(1);
    floating.close();
    expect(owner.sender.send).toHaveBeenLastCalledWith("freelens-power:dashboard-views:pinned", []);
    await handler(owner, payload);
    expect(mocks.views).toHaveLength(2);
    expect(original.webContents.loadURL).toHaveBeenCalledOnce();
    expect(original.setBounds.mock.calls.length).toBeGreaterThan(originalBounds);
  } finally {
    dispose();
  }
});

it("applies live selectors to both copies and destroys floating windows on removal or disposal", async () => {
  const dispose = startDashboardViews();
  const owner = event();
  await mocks.handlers.get(sync)(owner, payload);
  await mocks.handlers.get("freelens-power:dashboard-views:pin")(owner, { id: "site", pinned: true });
  const original = mocks.views[0];
  const floating = mocks.floating[0];
  runInAction(() => {
    mocks.store.cards[0].selector = ".example";
  });
  expect(original.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1004, [
    { code: expect.stringContaining(".example") },
  ]);
  expect(floating.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1004, [
    { code: expect.stringContaining(".example") },
  ]);
  const open = floating.webContents.setWindowOpenHandler.mock.calls[0][0];
  expect(open({ url: "file:///example" })).toEqual({ action: "deny" });
  const preventDefault = vi.fn();
  floating.webContents.emit("will-navigate", { preventDefault }, "javascript:example");
  expect(preventDefault).toHaveBeenCalled();
  runInAction(() => {
    mocks.store.cards = [];
  });
  expect(floating.close).toHaveBeenCalledOnce();
  expect(original.webContents.close).toHaveBeenCalledOnce();
  dispose();
  expect(floating.close).toHaveBeenCalledOnce();
});

it("closes pinned duplicates and cached cards when their owner is destroyed or the feature stops", async () => {
  for (const destroyOwner of [true, false]) {
    const dispose = startDashboardViews();
    const owner = event();
    await mocks.handlers.get(sync)(owner, payload);
    const original = mocks.views.at(-1);
    await mocks.handlers.get("freelens-power:dashboard-views:pin")(owner, { id: "site", pinned: true });
    const floating = mocks.floating.at(-1);
    if (destroyOwner) owner.sender.emit("destroyed");
    dispose();
    expect(floating.close).toHaveBeenCalledOnce();
    expect(floating.webContents.close).toHaveBeenCalledOnce();
    expect(original.webContents.close).toHaveBeenCalledOnce();
  }
});

it("refreshes both the cached card and pinned page manually while pausing automatic refresh", async () => {
  vi.useFakeTimers();
  const dispose = startDashboardViews();
  const owner = event();
  try {
    runInAction(() => {
      mocks.store.cards[0].autoRefresh = true;
    });
    await mocks.handlers.get(sync)(owner, payload);
    const original = mocks.views[0];
    await mocks.handlers.get("freelens-power:dashboard-views:pin")(owner, { id: "site", pinned: true });
    const floating = mocks.floating[0];
    floating.webContents.getURL.mockReturnValue("https://example.com/pinned-page");
    owner.sender.getURL = () => "https://renderer.freelens.app/other";
    await vi.advanceTimersByTimeAsync(600000);
    expect(original.webContents.loadURL).toHaveBeenCalledOnce();
    expect(floating.webContents.loadURL).toHaveBeenCalledOnce();
    owner.sender.getURL = () => url;
    const refresh = mocks.handlers.get("freelens-power:dashboard-views:reload");
    expect(await refresh(owner, { id: "site" })).toEqual({ failed: [] });
    expect(original.webContents.loadURL).toHaveBeenLastCalledWith("https://example.com/current");
    expect(floating.webContents.loadURL).toHaveBeenLastCalledWith("https://example.com/pinned-page");
    expect(floating.webContents.loadURL).toHaveBeenCalledTimes(2);
    floating.webContents.loadURL.mockRejectedValueOnce(new Error("example failure"));
    expect(await refresh(owner, { id: "site" })).toEqual({ failed: ["site"] });
    floating.close();
    expect(await refresh(owner, { id: "site" })).toEqual({ failed: [] });
    expect(floating.webContents.loadURL).toHaveBeenCalledTimes(3);
  } finally {
    dispose();
    vi.useRealTimers();
  }
});
