// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, type WebContents } from "electron";
import { reaction } from "mobx";
import { AppearancePreferencesStore, isAccentSelection } from "../common/store/appearance-preferences-store";

export function isNativeSplashUrl(url: string, appPath: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "file:" && !parsed.host && fileURLToPath(parsed) === join(appPath, "static", "splash.html")
    );
  } catch {
    return false;
  }
}

export function startSplashAccentOverride(): () => void {
  const preferences = AppearancePreferencesStore.getInstanceOrCreate<AppearancePreferencesStore>();
  const appPath = app.getAppPath();
  const windows = new Map<WebContents, { refresh: () => void; cleanup: () => void }>();
  let disposed = false;
  let css = "";

  const attach = (window: BrowserWindow) => {
    const contents = window.webContents;
    if (disposed || contents.isDestroyed() || windows.has(contents)) return;
    let key: string | undefined;
    let revision = 0;
    let pending = Promise.resolve();
    const refresh = () => {
      const request = ++revision;
      pending = pending
        .then(async () => {
          if (request !== revision || contents.isDestroyed()) return;
          if (key) {
            const previous = key;
            key = undefined;
            await contents.removeInsertedCSS(previous).catch(() => {});
          }
          if (
            disposed ||
            request !== revision ||
            !css ||
            contents.isDestroyed() ||
            !isNativeSplashUrl(contents.getURL(), appPath)
          )
            return;
          const inserted = await contents.insertCSS(css, { cssOrigin: "user" });
          if (
            disposed ||
            request !== revision ||
            contents.isDestroyed() ||
            !isNativeSplashUrl(contents.getURL(), appPath)
          ) {
            if (!contents.isDestroyed()) await contents.removeInsertedCSS(inserted).catch(() => {});
          } else key = inserted;
        })
        .catch(() => {});
    };
    const cleanup = () => {
      contents.removeListener("dom-ready", refresh);
      contents.removeListener("did-start-loading", refresh);
      contents.removeListener("destroyed", cleanup);
      windows.delete(contents);
      refresh();
    };
    windows.set(contents, { refresh, cleanup });
    contents.on("dom-ready", refresh);
    contents.on("did-start-loading", refresh);
    contents.once("destroyed", cleanup);
    refresh();
  };
  const onCreated = (_event: Electron.Event, window: BrowserWindow) => attach(window);
  app.on("browser-window-created", onCreated);
  for (const window of BrowserWindow.getAllWindows()) attach(window);
  const stop = reaction(
    () => [preferences.enabled, preferences.accentColor, preferences.recolorAppIcon] as const,
    ([enabled, color, recolorAppIcon]) => {
      css =
        enabled && color !== "default" && isAccentSelection(color)
          ? `.progress, .glow div { background: ${color} !important; box-shadow: 0 0 20px ${color} !important; }
          @keyframes freelens-power-splash-glow { from { opacity: 1; flex: 1; } to { opacity: 0; flex: 10; } }
          .glow div { animation-name: freelens-power-splash-glow !important; }
          ${recolorAppIcon ? `.icon svg path:is([fill="#23a49c"], [fill="#73c3c0"], [fill="#a8d8d6"], [fill="#50b6b4"]) { fill: ${color} !important; }` : ""}`
          : "";
      for (const state of windows.values()) state.refresh();
    },
    { fireImmediately: true },
  );
  return () => {
    disposed = true;
    stop();
    app.removeListener("browser-window-created", onCreated);
    for (const state of [...windows.values()]) state.cleanup();
  };
}
