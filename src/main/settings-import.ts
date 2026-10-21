import { open } from "node:fs/promises";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { runInAction } from "mobx";
import {
  parseSettingsImport,
  SETTINGS_BACKUP_MAX_BYTES,
  SETTINGS_IMPORT,
  type SettingsImportResult,
} from "../common/settings-export";
import { AiShortcutsStore } from "../common/store/ai-shortcuts-store";
import { DashboardPreferencesStore } from "../common/store/dashboard-preferences-store";

const MAX_BYTES = SETTINGS_BACKUP_MAX_BYTES;

export function startSettingsImport(): () => void {
  let active = true;
  const pending = new WeakSet<object>();
  ipcMain.handle(SETTINGS_IMPORT, async (event): Promise<SettingsImportResult> => {
    const sender = event.sender;
    const window = BrowserWindow.fromWebContents(sender);
    const startingFrame = event.senderFrame;
    const startingUrl = sender.getURL();
    let navigated = false;
    const trusted = () => {
      try {
        const url = new URL(sender.getURL());
        return (
          active &&
          !navigated &&
          !sender.isDestroyed() &&
          window &&
          !window.isDestroyed() &&
          event.senderFrame === sender.mainFrame &&
          sender.mainFrame === startingFrame &&
          sender.getURL() === startingUrl &&
          event.senderFrame?.url === sender.getURL() &&
          url.protocol === "https:" &&
          (url.hostname === "renderer.freelens.app" || url.hostname.endsWith(".renderer.freelens.app"))
        );
      } catch {
        return false;
      }
    };
    if (!trusted() || !window || pending.has(sender)) return "error";
    pending.add(sender);
    const onNavigation = (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame) navigated = true;
    };
    sender.on("did-start-navigation", onNavigation);
    try {
      const selection = await dialog.showOpenDialog(window, {
        title: "Restore dashboard and shortcuts",
        filters: [{ name: "JSON", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (selection.canceled || !selection.filePaths[0]) return "canceled";
      if (!trusted()) return "error";
      const file = await open(selection.filePaths[0], "r");
      let backup: ReturnType<typeof parseSettingsImport>;
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > MAX_BYTES) return "error";
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) return "error";
        backup = parseSettingsImport(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
      } finally {
        await file.close();
      }
      if (!trusted()) return "error";
      const confirmation = await dialog.showMessageBox(window, {
        type: "question",
        title: "Restore dashboard and shortcuts",
        message: "Replace dashboard cards and prompt shortcuts?",
        detail: `${backup.dashboard.cards.length} cards and ${backup.ai.shortcuts.length} shortcuts will replace the current lists. Chat history, authentication and Read-only settings stay unchanged.`,
        buttons: ["Cancel", "Restore"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmation.response !== 1) return "canceled";
      if (!trusted()) return "error";
      const dashboard = DashboardPreferencesStore.getInstanceOrCreate<DashboardPreferencesStore>();
      const ai = AiShortcutsStore.getInstanceOrCreate<AiShortcutsStore>();
      runInAction(() => {
        dashboard.cards = backup.dashboard.cards;
        ai.shortcuts = backup.ai.shortcuts;
      });
      return "restored";
    } catch {
      return "error";
    } finally {
      sender.removeListener("did-start-navigation", onNavigation);
      pending.delete(sender);
    }
  });
  return () => {
    active = false;
    ipcMain.removeHandler(SETTINGS_IMPORT);
  };
}
