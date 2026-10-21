import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { createSettingsExport, SETTINGS_EXPORT, type SettingsExportResult } from "../common/settings-export";
import { AiShortcutsStore } from "../common/store/ai-shortcuts-store";
import { DashboardPreferencesStore } from "../common/store/dashboard-preferences-store";
import { startSettingsImport } from "./settings-import";

function trustedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "renderer.freelens.app" || url.hostname.endsWith(".renderer.freelens.app"))
    );
  } catch {
    return false;
  }
}

export function startSettingsExport(): () => void {
  const stopImport = startSettingsImport();
  let active = true;
  const pending = new WeakSet<object>();
  ipcMain.handle(SETTINGS_EXPORT, async (event): Promise<SettingsExportResult> => {
    const sender = event.sender;
    const window = BrowserWindow.fromWebContents(sender);
    if (
      !active ||
      event.senderFrame !== sender.mainFrame ||
      !trustedUrl(event.senderFrame?.url ?? "") ||
      !trustedUrl(sender.getURL()) ||
      !window ||
      window.isDestroyed() ||
      pending.has(sender)
    )
      return "error";
    pending.add(sender);
    let temporary: string | undefined;
    try {
      const selection = await dialog.showSaveDialog(window, {
        title: "Export dashboard and shortcuts",
        defaultPath: "freelens-power-settings.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (selection.canceled || !selection.filePath) return "canceled";
      if (!active || sender.isDestroyed() || window.isDestroyed()) return "error";
      const data = createSettingsExport(
        DashboardPreferencesStore.getInstanceOrCreate<DashboardPreferencesStore>().cards,
        AiShortcutsStore.getInstanceOrCreate<AiShortcutsStore>().shortcuts,
      );
      temporary = await mkdtemp(join(dirname(selection.filePath), ".freelens-power-export-"));
      const source = join(temporary, "settings.json");
      await writeFile(source, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(source, selection.filePath);
      return "saved";
    } catch {
      return "error";
    } finally {
      pending.delete(sender);
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  });
  return () => {
    stopImport();
    active = false;
    ipcMain.removeHandler(SETTINGS_EXPORT);
  };
}
