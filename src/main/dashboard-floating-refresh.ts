import { type BrowserWindow, nativeTheme, screen, WebContentsView } from "electron";
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
  let tooltip: WebContentsView | undefined;
  let tooltipAttached = false;
  let hoverStarted = 0;
  let hoverTimer: ReturnType<typeof setInterval> | undefined;
  const hideTooltip = () => {
    if (tooltipAttached && !window.isDestroyed() && tooltip) window.contentView.removeChildView(tooltip);
    tooltipAttached = false;
  };
  const stopHover = () => {
    if (hoverTimer) clearInterval(hoverTimer);
    hoverTimer = undefined;
    hoverStarted = 0;
    hideTooltip();
  };
  const renderTooltip = () => {
    if (!tooltip || tooltip.webContents.isDestroyed()) return;
    const dark = nativeTheme.shouldUseDarkColors;
    const label = selected ? "Disable refresh" : "Enable refresh (10s)";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;background:transparent;overflow:hidden;font-family:Arial,sans-serif}.Tooltip{position:absolute;right:12px;top:0;border-radius:3px;padding:6.5px;background:${dark ? "#1e2124" : "#f1f1f1"};color:${dark ? "#ffffff" : "#222222"};font-size:13px;font-weight:normal;white-space:nowrap;box-shadow:0 8px 16px rgba(0,0,0,.24);pointer-events:none}</style></head><body><div class="Tooltip" role="tooltip">${label}</div></body></html>`;
    void tooltip.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
  };
  const layoutTooltip = () => {
    if (!tooltip || window.isDestroyed()) return;
    const { width, height } = window.getContentBounds();
    tooltip.setBounds({ x: Math.max(0, width - 204), y: Math.max(0, height - 70), width: 204, height: 34 });
  };
  const checkHover = () => {
    if (disposed || window.isDestroyed()) return stopHover();
    const bounds = window.getContentBounds();
    const cursor = screen.getCursorScreenPoint();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    if (
      !window.isVisible() ||
      !window.isFocused() ||
      x < bounds.width - 36 ||
      x >= bounds.width - 12 ||
      y < bounds.height - 36 ||
      y >= bounds.height - 12
    )
      return stopHover();
    if (!hoverStarted) hoverStarted = Date.now();
    if (Date.now() - hoverStarted < 150 || tooltipAttached) return;
    if (!tooltip) {
      tooltip = new WebContentsView({
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
      });
      tooltip.setBackgroundColor("#00000000");
      tooltip.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      tooltip.webContents.on("will-navigate", blockNavigation);
      renderTooltip();
    }
    layoutTooltip();
    window.contentView.addChildView(tooltip);
    tooltipAttached = true;
  };
  const onCursorChanged = (_event: Electron.Event, type: string) => {
    if (type !== "pointer" || hoverTimer || disposed) return;
    checkHover();
    hoverTimer = setInterval(checkHover, 50);
  };
  const render = () => {
    if (disposed || contents.isDestroyed()) return;
    const dark = nativeTheme.shouldUseDarkColors;
    const accent = preferences.enabled
      ? (ACCENT_COLOR_OPTIONS.find((option) => option.value === preferences.accentColor)?.color ?? "#7060e8")
      : "#00a7a0";
    const label = selected ? "Disable refresh" : "Enable refresh (10s)";
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action https://freelens-power.invalid"><style>
html,body,form{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}button{box-sizing:border-box;width:24px;height:24px;display:grid;place-items:center;padding:0;border:1px solid ${selected ? accent : dark ? "#54585e" : "#c5c8ce"};border-radius:3px;background:${dark ? "#292d32" : "#f5f6f8"};color:${selected ? accent : dark ? "#aeb5be" : "#5f6873"};cursor:pointer}button:hover{background:color-mix(in srgb,${accent} 8%,${dark ? "#292d32" : "#f5f6f8"})}button:focus-visible{outline:2px solid ${accent};outline-offset:-3px}svg{width:14px;height:14px;fill:currentColor;pointer-events:none}
</style></head><body><form action="${toggleUrl}" target="_blank"><button type="submit" aria-label="${label}" aria-pressed="${selected}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v3l4-4-4-4v3a8 8 0 0 0-6.76 12.26l1.46-1.46A6 6 0 0 1 12 6zm6.76 1.74L17.3 9.2A6 6 0 0 1 12 18v-3l-4 4 4 4v-3a8 8 0 0 0 6.76-12.26z"/></svg></button></form></body></html>`;
    renderTooltip();
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
    layoutTooltip();
    view.setBounds({ x: Math.max(0, width - 36), y: Math.max(0, height - 36), width: 24, height: 24 });
  };
  view.setBackgroundColor("#00000000");
  window.contentView.addChildView(view);
  window.on("resize", layout);
  window.on("blur", stopHover);
  window.on("hide", stopHover);
  contents.on("cursor-changed", onCursorChanged);
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
      stopHover();
      window.removeListener("blur", stopHover);
      window.removeListener("hide", stopHover);
      contents.removeListener("cursor-changed", onCursorChanged);
      if (tooltip && !tooltip.webContents.isDestroyed()) {
        tooltip.webContents.removeListener("will-navigate", blockNavigation);
        tooltip.webContents.close();
      }
      nativeTheme.removeListener("updated", render);
      window.removeListener("resize", layout);
      contents.removeListener("will-navigate", blockNavigation);
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
      if (!contents.isDestroyed()) contents.close();
    },
  };
}
