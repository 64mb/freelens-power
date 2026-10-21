import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<string>>(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  open: vi.fn(),
  stat: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
  window: { isDestroyed: vi.fn(() => false) },
  dashboard: { cards: [{ id: "old-card" }], enabled: true, authentication: "preserved" },
  ai: { shortcuts: [{ id: "old-shortcut" }], history: ["preserved"], readOnly: true },
}));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => mocks.window },
  dialog: { showOpenDialog: mocks.showOpenDialog, showMessageBox: mocks.showMessageBox },
  ipcMain: {
    handle: (key: string, handler: (...args: any[]) => Promise<string>) => mocks.handlers.set(key, handler),
    removeHandler: (key: string) => mocks.handlers.delete(key),
  },
}));
vi.mock("node:fs/promises", () => ({ open: mocks.open }));
vi.mock("../common/store/dashboard-preferences-store", () => ({
  DashboardPreferencesStore: { getInstanceOrCreate: () => mocks.dashboard },
}));
vi.mock("../common/store/ai-shortcuts-store", () => ({ AiShortcutsStore: { getInstanceOrCreate: () => mocks.ai } }));

import { SETTINGS_IMPORT } from "../common/settings-export";
import { startSettingsImport } from "./settings-import";

const chosenPath = "/tmp/settings-fixture.json";
function fixture() {
  return {
    format: "freelens-power-settings",
    version: 1,
    dashboard: { cards: [{ id: "new-card", title: "Example", url: "https://example.com", size: "m" }] },
    ai: {
      shortcuts: [{ id: "new-shortcut", label: "Inspect", command: "inspect", prompt: "Inspect resource health" }],
    },
    readOnly: false,
    authentication: "discarded",
    history: ["discarded"],
  };
}
function event() {
  const mainFrame = { url: "https://renderer.freelens.app/preferences" };
  return {
    senderFrame: mainFrame,
    sender: Object.assign(new EventEmitter(), { mainFrame, getURL: () => mainFrame.url, isDestroyed: () => false }),
  };
}
function content(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  mocks.read.mockImplementation(async (buffer: Buffer) => ({ bytesRead: buffer.write(text, "utf8") }));
}
function snapshot() {
  return structuredClone({ dashboard: mocks.dashboard, ai: mocks.ai });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.dashboard.cards = [{ id: "old-card" }];
  mocks.ai.shortcuts = [{ id: "old-shortcut" }];
  mocks.window.isDestroyed.mockReturnValue(false);
  mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [chosenPath] });
  mocks.showMessageBox.mockResolvedValue({ response: 1 });
  mocks.stat.mockResolvedValue({ isFile: () => true, size: 500 });
  mocks.close.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue({ stat: mocks.stat, read: mocks.read, close: mocks.close });
  content(fixture());
});

it("reads only the native selected regular file and confirms list counts before restoring supported fields", async () => {
  const stop = startSettingsImport();
  const handler = mocks.handlers.get(SETTINGS_IMPORT)!;
  expect(await handler(event(), { path: "/tmp/renderer-supplied.json", readOnly: false })).toBe("restored");
  expect(mocks.open).toHaveBeenCalledWith(chosenPath, "r");
  expect(mocks.read.mock.calls[0][0]).toHaveLength(1024 * 1024 + 1);
  expect(mocks.read.mock.calls[0].slice(1)).toEqual([0, 1024 * 1024 + 1, 0]);
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.showMessageBox.mock.calls[0][1]).toMatchObject({
    buttons: ["Cancel", "Restore"],
    defaultId: 0,
    cancelId: 0,
  });
  expect(mocks.showMessageBox.mock.calls[0][1].detail).toContain("1 cards and 1 shortcuts");
  expect(mocks.dashboard.cards).toEqual([
    { id: "new-card", title: "Example", url: "https://example.com/", size: "m", autoRefresh: false },
  ]);
  expect(mocks.ai.shortcuts).toEqual(fixture().ai.shortcuts);
  expect(mocks.dashboard.authentication).toBe("preserved");
  expect(mocks.dashboard.enabled).toBe(true);
  expect(mocks.ai.history).toEqual(["preserved"]);
  expect(mocks.ai.readOnly).toBe(true);
  stop();
  expect(mocks.handlers.size).toBe(0);
});

it("rejects websites, forged frames and changed frame URLs before opening a native file dialog", async () => {
  const stop = startSettingsImport();
  const handler = mocks.handlers.get(SETTINGS_IMPORT)!;
  const before = snapshot();
  const forged = event();
  forged.senderFrame = { url: forged.senderFrame.url };
  expect(await handler(forged)).toBe("error");
  const website = event();
  website.senderFrame.url = "https://example.com/preferences";
  expect(await handler(website)).toBe("error");
  const changed = event();
  changed.sender.getURL = () => "https://renderer.freelens.app/other";
  expect(await handler(changed)).toBe("error");
  expect(mocks.showOpenDialog).not.toHaveBeenCalled();
  expect(snapshot()).toEqual(before);
  stop();
});

it("keeps both stores unchanged after either native dialog is canceled", async () => {
  const stop = startSettingsImport();
  const handler = mocks.handlers.get(SETTINGS_IMPORT)!;
  const before = snapshot();
  mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await handler(event())).toBe("canceled");
  expect(mocks.open).not.toHaveBeenCalled();
  mocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
  expect(await handler(event())).toBe("canceled");
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(snapshot()).toEqual(before);
  stop();
});

it("rejects nonregular or oversized files and a file growing past the read bound", async () => {
  const stop = startSettingsImport();
  const handler = mocks.handlers.get(SETTINGS_IMPORT)!;
  const before = snapshot();
  mocks.stat.mockResolvedValueOnce({ isFile: () => false, size: 1 });
  expect(await handler(event())).toBe("error");
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.stat.mockResolvedValueOnce({ isFile: () => true, size: 1024 * 1024 + 1 });
  expect(await handler(event())).toBe("error");
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.read.mockResolvedValueOnce({ bytesRead: 1024 * 1024 + 1 });
  expect(await handler(event())).toBe("error");
  expect(mocks.close).toHaveBeenCalledTimes(3);
  expect(mocks.showMessageBox).not.toHaveBeenCalled();
  expect(snapshot()).toEqual(before);
  stop();
});

it("rejects malformed, incompatible and unsafe backups without mutation or leaking source details", async () => {
  const stop = startSettingsImport();
  const handler = mocks.handlers.get(SETTINGS_IMPORT)!;
  const before = snapshot();
  const valid = fixture();
  const invalid: unknown[] = ['{"private-detail":', { ...valid, version: 2 }];
  for (const patch of [{ url: "javascript:alert(1)" }, { size: "xxl" }, { selector: "a".repeat(513) }])
    invalid.push({ ...valid, dashboard: { cards: [{ ...valid.dashboard.cards[0], ...patch }] } });
  for (const value of invalid) {
    content(value);
    expect(await handler(event())).toBe("error");
  }
  mocks.open.mockRejectedValueOnce(new Error("private path and filesystem details"));
  expect(await handler(event())).toBe("error");
  expect(mocks.showMessageBox).not.toHaveBeenCalled();
  expect(snapshot()).toEqual(before);
  stop();
});

it("rejects deactivation or sender navigation while either native dialog is pending", async () => {
  const before = snapshot();
  let select!: (value: unknown) => void;
  mocks.showOpenDialog.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        select = resolve;
      }),
  );
  const stop = startSettingsImport();
  const pending = mocks.handlers.get(SETTINGS_IMPORT)!(event());
  stop();
  select({ canceled: false, filePaths: [chosenPath] });
  expect(await pending).toBe("error");
  expect(mocks.open).not.toHaveBeenCalled();
  let confirm!: (value: unknown) => void;
  mocks.showMessageBox.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  const stopNext = startSettingsImport();
  const owner = event();
  const restoring = mocks.handlers.get(SETTINGS_IMPORT)!(owner);
  await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledOnce());
  owner.senderFrame.url = "https://example.com/";
  confirm({ response: 1 });
  expect(await restoring).toBe("error");
  expect(snapshot()).toEqual(before);
  stopNext();
});

it("rejects sender navigation to another trusted renderer route while the confirmation is open", async () => {
  const before = snapshot();
  let confirm!: (value: unknown) => void;
  mocks.showMessageBox.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  const stop = startSettingsImport();
  const owner = event();
  const pending = mocks.handlers.get(SETTINGS_IMPORT)!(owner);
  await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledOnce());
  owner.senderFrame.url = "https://renderer.freelens.app/preferences/other";
  confirm({ response: 1 });
  expect(await pending).toBe("error");
  expect(snapshot()).toEqual(before);
  stop();
});

it("accepts a regular backup exactly at the one MiB limit and closes its descriptor", async () => {
  const encoded = JSON.stringify(fixture());
  content(encoded.padEnd(1024 * 1024, " "));
  mocks.stat.mockResolvedValueOnce({ isFile: () => true, size: 1024 * 1024 });
  const stop = startSettingsImport();
  expect(await mocks.handlers.get(SETTINGS_IMPORT)!(event())).toBe("restored");
  expect(mocks.close).toHaveBeenCalledOnce();
  stop();
});

it("rejects navigating away and back while confirmation is open", async () => {
  const before = snapshot();
  let confirm!: (value: unknown) => void;
  mocks.showMessageBox.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  const stop = startSettingsImport();
  const owner = event();
  const originalUrl = owner.senderFrame.url;
  const pending = mocks.handlers.get(SETTINGS_IMPORT)!(owner);
  await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledOnce());
  owner.senderFrame.url = "https://renderer.freelens.app/preferences/other";
  owner.sender.emit("did-start-navigation", {}, owner.senderFrame.url, false, true);
  owner.senderFrame.url = originalUrl;
  owner.sender.emit("did-start-navigation", {}, originalUrl, false, true);
  confirm({ response: 1 });
  expect(await pending).toBe("error");
  expect(snapshot()).toEqual(before);
  expect(owner.sender.listenerCount("did-start-navigation")).toBe(0);
  stop();
});
