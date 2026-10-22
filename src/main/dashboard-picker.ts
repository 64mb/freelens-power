import { BrowserWindow, type IpcMainInvokeEvent, ipcMain, session } from "electron";
import { normalizeDashboardUrl } from "../common/dashboard";
import { DASHBOARD_PICK_ELEMENT, type DashboardPickerResult, dashboardPickerScript } from "../common/dashboard-picker";
import { normalizeDashboardSelector } from "../common/dashboard-selector";

export function trustedPickerSender(event: IpcMainInvokeEvent): boolean {
  const trusted = (value: string) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        (url.hostname === "renderer.freelens.app" || url.hostname.endsWith(".renderer.freelens.app")) &&
        (url.pathname === "/preferences" || url.pathname.startsWith("/preferences/"))
      );
    } catch {
      return false;
    }
  };
  return (
    event.senderFrame === event.sender.mainFrame &&
    trusted(event.senderFrame?.url ?? "") &&
    trusted(event.sender.getURL())
  );
}

export function startDashboardPicker(): () => void {
  const active = new Map<BrowserWindow, () => void>();
  const pending = new WeakSet<object>();
  let running = true;
  ipcMain.handle(DASHBOARD_PICK_ELEMENT, async (event, payload: unknown): Promise<DashboardPickerResult> => {
    if (!running || !trustedPickerSender(event) || pending.has(event.sender) || !payload || typeof payload !== "object")
      return { status: "error" };
    const rawUrl = (payload as { url?: unknown }).url;
    const url = typeof rawUrl === "string" && rawUrl.length <= 8192 ? normalizeDashboardUrl(rawUrl) : undefined;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!url || !owner || owner.isDestroyed()) return { status: "error" };
    pending.add(event.sender);
    try {
      const websiteSession = session.fromPartition("persist:freelens-power-websites");
      websiteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      websiteSession.setPermissionCheckHandler(() => false);
      const picker = new BrowserWindow({
        parent: owner,
        modal: true,
        width: 1100,
        height: 800,
        show: false,
        title: "Select website element · Click to select · Esc to cancel",
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          partition: "persist:freelens-power-websites",
        },
      });
      picker.setMenu(null);
      picker.contentView.setVisible(false);
      return await new Promise<DashboardPickerResult>((resolve) => {
        let done = false;
        let loaded = false;
        const finish = (result: DashboardPickerResult) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          active.delete(picker);
          event.sender.removeListener("destroyed", cancel);
          event.sender.removeListener("did-start-navigation", cancel);
          if (!picker.isDestroyed()) picker.destroy();
          resolve(result);
        };
        const cancel = () => finish({ status: "canceled" });
        const timer = setTimeout(cancel, 5 * 60_000);
        active.set(picker, cancel);
        event.sender.once("destroyed", cancel);
        event.sender.on("did-start-navigation", cancel);
        picker.once("closed", cancel);
        picker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        picker.webContents.on("will-navigate", (navigation, target) => {
          if (loaded || !normalizeDashboardUrl(target)) {
            navigation.preventDefault();
            cancel();
          }
        });
        picker.webContents.on("did-start-navigation", (_navigation, _target, _inPlace, mainFrame) => {
          if (loaded && mainFrame) cancel();
        });
        picker.webContents.on("will-redirect", (navigation, target) => {
          if (!normalizeDashboardUrl(target)) {
            navigation.preventDefault();
            cancel();
          }
        });
        picker.webContents.on("will-attach-webview", (attach) => attach.preventDefault());
        picker.webContents.on("before-input-event", (inputEvent, input) => {
          if (input.key === "Escape") {
            inputEvent.preventDefault();
            cancel();
          }
        });
        picker.webContents.once("render-process-gone", () => finish({ status: "error" }));
        picker.webContents.once("did-finish-load", () => {
          if (done) return;
          loaded = true;
          if (!normalizeDashboardUrl(picker.webContents.getURL())) {
            cancel();
            return;
          }
          void picker.webContents
            .executeJavaScriptInIsolatedWorld(1007, [
              {
                code: `globalThis.powerDashboardPickerSelection = ${dashboardPickerScript()}; true`,
              },
            ])
            .then((installed: unknown) => {
              if (done) return null;
              if (installed !== true) throw new Error("Picker could not start");
              picker.contentView.setVisible(true);
              return picker.webContents.executeJavaScriptInIsolatedWorld(1007, [
                {
                  code: "globalThis.powerDashboardPickerSelection.then((selection) => { delete globalThis.powerDashboardPickerSelection; return selection; })",
                },
              ]);
            })
            .then((result: unknown) => {
              if (done) return;
              const selector = normalizeDashboardSelector(result);
              finish(selector ? { status: "selected", selector } : { status: "canceled" });
            })
            .catch(() => finish({ status: "error" }));
        });
        picker.show();
        void picker.loadURL(url).catch(() => finish({ status: "error" }));
      });
    } catch {
      return { status: "error" };
    } finally {
      pending.delete(event.sender);
    }
  });
  return () => {
    running = false;
    ipcMain.removeHandler(DASHBOARD_PICK_ELEMENT);
    for (const cancel of active.values()) cancel();
  };
}
