import { type BrowserWindow, nativeTheme, WebContentsView } from "electron";
import { reaction } from "mobx";
import { ACCENT_COLOR_OPTIONS, AppearancePreferencesStore } from "../common/store/appearance-preferences-store";

const toggleUrl = "https://freelens-power.invalid/dashboard-toggle-refresh";

export function createDashboardFloatingRefresh(window: BrowserWindow, enabled: boolean, toggle: () => void) {
  const view = new WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  const contents = view.webContents;
  const preferences = AppearancePreferencesStore.getInstanceOrCreate<AppearancePreferencesStore>();
  let disposed = false;
  let selected = enabled;
  let previous = "";
  const render = () => {
    if (disposed || contents.isDestroyed()) return;
    const dark = nativeTheme.shouldUseDarkColors;
    const accent = preferences.enabled
      ? (ACCENT_COLOR_OPTIONS.find((option) => option.value === preferences.accentColor)?.color ?? "#7060e8")
      : "#00a7a0";
    const label = selected ? "Disable refresh" : "Enable refresh (10s)";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action https://freelens-power.invalid"><style>
html,body,form{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}button{box-sizing:border-box;width:20px;height:20px;display:grid;place-items:center;padding:0;border:1px solid ${selected ? accent : dark ? "#54585e" : "#c5c8ce"};border-radius:3px;background:${dark ? "#292d32" : "#f5f6f8"};color:${selected ? accent : dark ? "#aeb5be" : "#5f6873"};cursor:pointer}button:hover{background:color-mix(in srgb,${accent} 8%,${dark ? "#292d32" : "#f5f6f8"})}button:focus-visible{outline:2px solid ${accent};outline-offset:-3px}svg{width:12px;height:12px;fill:currentColor;pointer-events:none}
</style></head><body><form action="${toggleUrl}" target="_blank"><button type="submit" aria-label="${label}" title="${label}" aria-pressed="${selected}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v3l4-4-4-4v3a8 8 0 0 0-6.76 12.26l1.46-1.46A6 6 0 0 1 12 6zm6.76 1.74L17.3 9.2A6 6 0 0 1 12 18v-3l-4 4 4 4v-3a8 8 0 0 0 6.76-12.26z"/></svg></button></form></body></html>`;
    if (html === previous) return;
    previous = html;
    void contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
  };
  contents.setWindowOpenHandler(({ url }) => {
    if (!disposed && !window.isDestroyed() && (url === toggleUrl || url === `${toggleUrl}?`)) toggle();
    return { action: "deny" };
  });
  const blockNavigation = (event: Electron.Event) => event.preventDefault();
  contents.on("will-navigate", blockNavigation);
  const layout = () => {
    if (disposed || window.isDestroyed()) return;
    const { width, height } = window.getContentBounds();
    view.setBounds({ x: Math.max(0, width - 28), y: Math.max(0, height - 28), width: 20, height: 20 });
  };
  view.setBackgroundColor("#00000000");
  window.contentView.addChildView(view);
  window.on("resize", layout);
  const stop = reaction(() => [preferences.enabled, preferences.accentColor], render);
  nativeTheme.on("updated", render);
  layout();
  render();
  return {
    update(value: boolean) {
      selected = value;
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      nativeTheme.removeListener("updated", render);
      window.removeListener("resize", layout);
      contents.removeListener("will-navigate", blockNavigation);
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
      if (!contents.isDestroyed()) contents.close();
    },
  };
}
