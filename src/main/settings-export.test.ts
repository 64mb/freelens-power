import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  dialog: vi.fn(),
  mkdtemp: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
  window: { isDestroyed: () => false },
  cards: [{ id: "card", title: "Example", url: "https://example.com", size: "m" }],
  shortcuts: [{ id: "shortcut", label: "Health", command: "health", prompt: "Inspect resource health" }],
}));
vi.mock("./settings-import", () => ({ startSettingsImport: () => () => {} }));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => mocks.window },
  dialog: { showSaveDialog: mocks.dialog },
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler),
    removeHandler: (name: string) => mocks.handlers.delete(name),
  },
}));
vi.mock("node:fs/promises", () => ({
  mkdtemp: mocks.mkdtemp,
  rename: mocks.rename,
  rm: mocks.rm,
  writeFile: mocks.writeFile,
}));
vi.mock("../common/store/dashboard-preferences-store", () => ({
  DashboardPreferencesStore: { getInstanceOrCreate: () => ({ cards: mocks.cards }) },
}));
vi.mock("../common/store/ai-shortcuts-store", () => ({
  AiShortcutsStore: { getInstanceOrCreate: () => ({ shortcuts: mocks.shortcuts }) },
}));

import { SETTINGS_EXPORT } from "../common/settings-export";
import { startSettingsExport } from "./settings-export";

function event() {
  const mainFrame = { url: "https://renderer.freelens.app/preferences" };
  return { senderFrame: mainFrame, sender: { mainFrame, getURL: () => mainFrame.url, isDestroyed: () => false } };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.dialog.mockResolvedValue({ canceled: false, filePath: "/tmp/export.json" });
  mocks.mkdtemp.mockResolvedValue("/tmp/.freelens-power-export-random");
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.rename.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
});
it("rejects website/subframe callers and writes only store data to the native chosen path", async () => {
  const stop = startSettingsExport();
  const handle = mocks.handlers.get(SETTINGS_EXPORT)!;
  const owner = event();
  expect(await handle({ ...owner, senderFrame: { url: owner.senderFrame.url } })).toBe("error");
  owner.senderFrame.url = "https://example.com";
  expect(await handle(owner)).toBe("error");
  expect(mocks.dialog).not.toHaveBeenCalled();
  expect(await handle(event(), { filePath: "/tmp/unrequested.json", cards: [{ title: "untrusted" }] })).toBe("saved");
  expect(mocks.rename).toHaveBeenCalledWith("/tmp/.freelens-power-export-random/settings.json", "/tmp/export.json");
  const content = mocks.writeFile.mock.calls[0][1];
  expect(content).not.toContain("untrusted");
  expect(JSON.parse(content).dashboard.cards[0].title).toBe("Example");
  expect(mocks.writeFile.mock.calls[0][2]).toEqual({ encoding: "utf8", mode: 0o600, flag: "wx" });
  expect(mocks.rm).toHaveBeenCalledWith("/tmp/.freelens-power-export-random", { recursive: true, force: true });
  stop();
  expect(mocks.handlers.size).toBe(0);
});
it("cancels without touching the filesystem and reports write failures without exposing paths", async () => {
  const stop = startSettingsExport();
  const handle = mocks.handlers.get(SETTINGS_EXPORT)!;
  mocks.dialog.mockResolvedValueOnce({ canceled: true });
  expect(await handle(event())).toBe("canceled");
  expect(mocks.mkdtemp).not.toHaveBeenCalled();
  mocks.writeFile.mockRejectedValueOnce(new Error("unreported filesystem details"));
  expect(await handle(event())).toBe("error");
  expect(mocks.rename).not.toHaveBeenCalled();
  expect(mocks.rm).toHaveBeenCalledOnce();
  stop();
});
it("does not export after deactivation while the save dialog is open", async () => {
  let select!: (value: unknown) => void;
  mocks.dialog.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        select = resolve;
      }),
  );
  const stop = startSettingsExport();
  const pending = mocks.handlers.get(SETTINGS_EXPORT)!(event());
  stop();
  select({ canceled: false, filePath: "/tmp/export.json" });
  expect(await pending).toBe("error");
  expect(mocks.writeFile).not.toHaveBeenCalled();
});
