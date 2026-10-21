// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  nativeTheme,
  type Rectangle,
  session,
  shell,
  View,
  type WebContents,
  WebContentsView,
} from "electron";
import { reaction } from "mobx";
import { sanitizeDashboardCards } from "../common/dashboard";
import { dashboardReadinessScript } from "../common/dashboard-readiness";
import { dashboardSelectorScript } from "../common/dashboard-selector";
import {
  DASHBOARD_SITE_ICONS,
  DASHBOARD_VIEWS_LOADING,
  DASHBOARD_VIEWS_PIN,
  DASHBOARD_VIEWS_PINNED,
  type DashboardSiteIcon,
} from "../common/dashboard-views";
import { DashboardPreferencesStore } from "../common/store/dashboard-preferences-store";
import { boundedDashboardIcons, loadDashboardIcons, saveDashboardIcons } from "./dashboard-icon-cache";
import { observeDashboardNetwork } from "./dashboard-network";

const syncChannel = "freelens-power:dashboard-views:sync";
const reloadChannel = "freelens-power:dashboard-views:reload";
const clearChannel = "freelens-power:dashboard-views:clear";
const dashboardPath = "/extension/freelens-power/dashboard";
const websiteStyles =
  "* { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }";

function rendererUrl(value: string, dashboardOnly = false): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "renderer.freelens.app" || url.hostname.endsWith(".renderer.freelens.app")) &&
      (!dashboardOnly || url.pathname === dashboardPath)
    );
  } catch {
    return false;
  }
}
function dashboardUrl(value: string): boolean {
  return rendererUrl(value, true);
}
function webUrl(value: string): boolean {
  try {
    return ["https:", "http:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
function rectangle(value: unknown): Rectangle | undefined {
  if (!value || typeof value !== "object") return;
  const rect = value as Rectangle;
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(
      (n) => Number.isFinite(n) && Number.isInteger(n) && Math.abs(n) <= 32768,
    ) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

type CardView = {
  container: View;
  view: WebContentsView;
  url: string;
  failed: boolean;
  loading: boolean;
  visible: boolean;
  generation: number;
  stopPreparation?: () => void;
  selector?: string;
  pending?: Promise<void>;
  favicon?: string;
  faviconRequest?: AbortController;
  refreshTimer?: ReturnType<typeof setInterval>;
  refreshInterval?: number;
  floating?: BrowserWindow;
  floatingPreparation?: {
    refresh: () => Promise<boolean>;
    selectorChanged: () => void;
    stop: () => void;
    isPreparing: () => boolean;
  };
};
type Owner = { window: BrowserWindow; cards: Map<string, CardView>; cleanup: () => void };

async function waitForReadiness(
  contents: WebContents,
  network: ReturnType<typeof observeDashboardNetwork>,
  selector: () => string | undefined,
  current: () => boolean,
): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        if (!current()) return;
        await network.ready();
        if (!current()) return;
        await contents
          .executeJavaScriptInIsolatedWorld(1004, [{ code: dashboardSelectorScript(selector()) }])
          .catch(() => {});
        do {
          await network.wait();
          if (!current()) return;
          await contents.executeJavaScriptInIsolatedWorld(1004, [{ code: dashboardReadinessScript(selector()) }]);
        } while (current() && !network.quiet());
      })().catch(() => new Promise<void>((resolve) => setTimeout(resolve, 200))),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 8500);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

export function startDashboardViews(): () => void {
  const websiteSession = session.fromPartition("persist:freelens-power-websites");
  websiteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  websiteSession.setPermissionCheckHandler(() => false);
  const owners = new Map<WebContents, Owner>();
  const icons = new Map<string, DashboardSiteIcon>();
  const remove = (owner: Owner, id: string) => {
    const card = owner.cards.get(id);
    if (!card) return;
    owner.cards.delete(id);
    card.stopPreparation?.();
    card.faviconRequest?.abort();
    clearInterval(card.refreshTimer);
    card.floatingPreparation?.stop();
    card.floating?.destroy();
    card.floating = undefined;
    if (!owner.window.isDestroyed()) owner.window.contentView.removeChildView(card.container);
    if (!card.view.webContents.isDestroyed()) card.view.webContents.close();
  };
  const clear = (sender: WebContents) => {
    const owner = owners.get(sender);
    if (!owner) return;
    owners.delete(sender);
    for (const id of owner.cards.keys()) remove(owner, id);
    owner.cleanup();
  };
  const hide = (sender: WebContents) => {
    for (const card of owners.get(sender)?.cards.values() ?? []) {
      card.visible = false;
      card.container.setVisible(false);
    }
  };
  const configuredCards = () =>
    sanitizeDashboardCards(DashboardPreferencesStore.getInstanceOrCreate<DashboardPreferencesStore>().cards);
  const cachePath = join(app.getPath("userData"), "freelens-power", "dashboard-icons.json");
  const ready = loadDashboardIcons(cachePath).then((saved) => {
    const configured = configuredCards();
    for (const icon of saved) {
      if (!icons.has(icon.id) && configured.some((card) => card.id === icon.id && card.url === icon.pageUrl))
        icons.set(icon.id, icon);
    }
  });
  let writes = ready;
  const persistIcons = () => {
    writes = writes
      .then(async () => {
        const configured = configuredCards();
        const bounded = boundedDashboardIcons(
          [...icons.values()].filter((icon) =>
            configured.some((card) => card.id === icon.id && card.url === icon.pageUrl),
          ),
        );
        icons.clear();
        for (const icon of bounded) icons.set(icon.id, icon);
        await saveDashboardIcons(cachePath, bounded);
      })
      .catch(() => {});
  };
  persistIcons();
  const publishLoading = (card: CardView) => {
    for (const [sender, owner] of owners) {
      const id = [...owner.cards].find(([, candidate]) => candidate === card)?.[0];
      if (
        !id ||
        sender.isDestroyed() ||
        !dashboardUrl(sender.mainFrame.url) ||
        !dashboardUrl(sender.getURL()) ||
        !configuredCards().some((configured) => configured.id === id && configured.url === card.url)
      )
        continue;
      sender.send(DASHBOARD_VIEWS_LOADING, { id, url: card.url, loading: card.loading, failed: card.failed });
    }
  };
  const reload = (card: CardView, configuredUrl: string, initial = false) => {
    const current = card.view.webContents.getURL();
    const target = !initial && card.url === configuredUrl && webUrl(current) ? current : configuredUrl;
    card.faviconRequest?.abort();
    card.url = configuredUrl;
    card.failed = false;
    card.loading = true;
    card.stopPreparation?.();
    const contents = card.view.webContents;
    const backgroundThrottling = contents.getBackgroundThrottling();
    if (backgroundThrottling) contents.setBackgroundThrottling(false);
    const network = observeDashboardNetwork(card.view.webContents);
    let stopped = false;
    const stopPreparation = () => {
      if (stopped) return;
      stopped = true;
      network.dispose();
      contents.removeListener("destroyed", stopPreparation);
      if (!contents.isDestroyed() && backgroundThrottling && !contents.getBackgroundThrottling())
        contents.setBackgroundThrottling(backgroundThrottling);
      if (card.stopPreparation === stopPreparation) card.stopPreparation = undefined;
    };
    card.stopPreparation = stopPreparation;
    contents.once("destroyed", stopPreparation);
    const generation = ++card.generation;
    card.container.setVisible(false);
    publishLoading(card);
    const settled = (failed: boolean) => {
      if (card.generation !== generation || card.view.webContents.isDestroyed()) return;
      card.failed = failed;
      card.loading = false;
      for (const [sender, owner] of owners) {
        if (![...owner.cards.values()].includes(card)) continue;
        card.container.setVisible(card.visible && !card.floating && !failed && dashboardUrl(sender.getURL()));
      }
      publishLoading(card);
    };
    const load = () => {
      if (
        card.generation !== generation ||
        card.view.webContents.isDestroyed() ||
        ![...owners.values()].some((owner) => [...owner.cards.values()].includes(card))
      )
        return Promise.resolve();
      return card.view.webContents.loadURL(target);
    };
    card.pending = load().then(
      async () => {
        let preparing = true;
        const current = () =>
          preparing &&
          card.generation === generation &&
          !card.view.webContents.isDestroyed() &&
          [...owners.values()].some((owner) => [...owner.cards.values()].includes(card));
        try {
          await waitForReadiness(contents, network, () => card.selector, current);
        } finally {
          preparing = false;
          stopPreparation();
        }
        settled(false);
      },
      () => {
        stopPreparation();
        settled(true);
      },
    );
    return card.pending;
  };
  const applySelector = (card: { view: { webContents: WebContents }; selector?: string }) => {
    if (card.view.webContents.isDestroyed()) return Promise.resolve();
    return card.view.webContents
      .executeJavaScriptInIsolatedWorld(1004, [{ code: dashboardSelectorScript(card.selector) }])
      .catch(() => {});
  };
  const refreshTimers = () => {
    const configured = configuredCards();
    for (const [id, icon] of icons) {
      if (!configured.some((card) => card.id === id && card.url === icon.pageUrl)) {
        icons.delete(id);
        persistIcons();
      }
    }
    for (const [sender, owner] of owners) {
      for (const [id, card] of owner.cards) {
        const setting = configured.find((item) => item.id === id);
        if (!setting || setting.url !== card.url) {
          remove(owner, id);
          continue;
        }
        if (card.selector !== setting.selector) {
          card.selector = setting.selector;
          applySelector(card);
          card.floatingPreparation?.selectorChanged();
        }
        if (card.floating && !card.floating.isDestroyed()) card.floating.setTitle(setting.title);
        const interval = setting.refreshEvery10Seconds ? 10000 : setting.autoRefresh ? 600000 : undefined;
        if (card.refreshInterval === interval) continue;
        clearInterval(card.refreshTimer);
        card.refreshTimer = undefined;
        card.refreshInterval = interval;
        if (!interval) continue;
        card.refreshTimer = setInterval(() => {
          const latest = configuredCards().find((item) => item.id === id);
          if (
            owners.get(sender) !== owner ||
            owner.cards.get(id) !== card ||
            !latest ||
            latest.url !== card.url ||
            (latest.refreshEvery10Seconds ? 10000 : latest.autoRefresh ? 600000 : undefined) !== interval ||
            card.view.webContents.isDestroyed() ||
            card.loading ||
            card.view.webContents.isLoading()
          )
            return;
          if (latest.refreshEvery10Seconds) {
            if (card.floating) {
              if (
                card.floating.isDestroyed() ||
                card.floating.webContents.isLoading() ||
                card.floatingPreparation?.isPreparing()
              )
                return;
              void Promise.all([reload(card, latest.url), card.floatingPreparation?.refresh()]);
            } else if (card.visible && dashboardUrl(sender.getURL())) void reload(card, latest.url);
          } else if (!card.floating && !dashboardUrl(sender.getURL())) void reload(card, latest.url);
        }, interval);
      }
    }
  };
  const stopSettingsReaction = reaction(
    () =>
      JSON.stringify(
        configuredCards().map(({ id, title, url, autoRefresh, refreshEvery10Seconds, selector }) => ({
          id,
          title,
          url,
          autoRefresh,
          refreshEvery10Seconds,
          selector,
        })),
      ),
    refreshTimers,
  );
  const trusted = (event: IpcMainInvokeEvent) =>
    event.senderFrame === event.sender.mainFrame &&
    dashboardUrl(event.senderFrame?.url ?? "") &&
    dashboardUrl(event.sender.getURL());
  ipcMain.handle(DASHBOARD_SITE_ICONS, async (event) => {
    if (
      event.senderFrame !== event.sender.mainFrame ||
      !rendererUrl(event.senderFrame?.url ?? "") ||
      !rendererUrl(event.sender.getURL()) ||
      !BrowserWindow.fromWebContents(event.sender)
    )
      return [];
    await ready;
    return configuredCards().flatMap((card) => {
      const icon = icons.get(card.id);
      return icon?.pageUrl === card.url ? [icon] : [];
    });
  });
  ipcMain.handle(syncChannel, async (event, payload: unknown) => {
    if (!trusted(event)) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    const requested =
      payload && typeof payload === "object" && "cards" in payload && Array.isArray(payload.cards) ? payload.cards : [];
    const cards = sanitizeDashboardCards(
      DashboardPreferencesStore.getInstanceOrCreate<DashboardPreferencesStore>().cards,
    );
    let owner = owners.get(event.sender);
    if (!owner) {
      const sender = event.sender;
      const navigation = (_event: unknown, url: string) => {
        if (!dashboardUrl(url)) hide(sender);
      };
      const destroyed = () => clear(sender);
      sender.on("did-navigate", navigation);
      sender.on("did-navigate-in-page", navigation);
      sender.on("destroyed", destroyed);
      owner = {
        window,
        cards: new Map(),
        cleanup: () => {
          sender.removeListener("did-navigate", navigation);
          sender.removeListener("did-navigate-in-page", navigation);
          sender.removeListener("destroyed", destroyed);
        },
      };
      owners.set(sender, owner);
    }
    if (payload && typeof payload === "object" && "hidden" in payload && payload.hidden === true) {
      hide(event.sender);
      return { failed: [], pinned: [...owner.cards].filter(([, card]) => card.floating).map(([id]) => id) };
    }
    const visible = new Set<string>();
    for (const item of requested.slice(0, cards.length)) {
      if (!item || typeof item !== "object" || typeof item.id !== "string" || visible.has(item.id)) continue;
      const configured = cards.find((card) => card.id === item.id);
      const bounds = rectangle(item.bounds);
      const clip = rectangle(item.clip);
      if (
        !configured ||
        !bounds ||
        !clip ||
        clip.x < bounds.x ||
        clip.y < bounds.y ||
        clip.x + clip.width > bounds.x + bounds.width ||
        clip.y + clip.height > bounds.y + bounds.height
      )
        continue;
      visible.add(item.id);
      let card = owner.cards.get(item.id);
      if (card?.floating) {
        card.visible = false;
        card.container.setVisible(false);
        continue;
      }
      if (!card) {
        const container = new View();
        container.setBackgroundColor("#00000000");
        const view = new WebContentsView({
          webPreferences: {
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            partition: "persist:freelens-power-websites",
          },
        });
        view.setBackgroundColor("#00000000");
        view.webContents.on("did-finish-load", () => {
          if (!view.webContents.isDestroyed())
            void view.webContents.insertCSS(websiteStyles, { cssOrigin: "user" }).catch(() => {});
        });
        view.webContents.setWindowOpenHandler(({ url }) => {
          if (webUrl(url)) void shell.openExternal(url).catch(() => {});
          return { action: "deny" };
        });
        const navigation = (event: Electron.Event, url: string) => {
          if (!webUrl(url)) event.preventDefault();
        };
        view.webContents.on("will-navigate", navigation);
        view.webContents.on("will-redirect", navigation);
        view.webContents.on("will-frame-navigate", (event) => {
          if (!webUrl(event.url)) event.preventDefault();
        });
        container.addChildView(view);
        window.contentView.addChildView(container);
        card = { container, view, url: "", failed: false, loading: false, visible: false, generation: 0 };
        owner.cards.set(item.id, card);
        const created = card;
        view.webContents.on("before-input-event", (_event, input: Electron.Input) => {
          if (
            input.type !== "keyDown" ||
            input.key !== "Escape" ||
            owners.get(event.sender) !== owner ||
            owner.cards.get(item.id) !== created ||
            !trusted(event)
          )
            return;
          event.sender.send("freelens-power:dashboard-escape");
        });
        created.selector = configured.selector;
        view.webContents.on("did-finish-load", () => applySelector(created));
        view.webContents.on("page-favicon-updated", (_event, favicons: string[]) => {
          const favicon = favicons.find((value) => {
            if (!webUrl(value)) return false;
            const parsed = new URL(value);
            return !parsed.username && !parsed.password;
          });
          if (!favicon || owners.get(event.sender) !== owner || owner.cards.get(item.id) !== created) return;
          created.faviconRequest?.abort();
          const request = new AbortController();
          created.faviconRequest = request;
          created.favicon = favicon;
          const publish = (url: string) => {
            if (
              request.signal.aborted ||
              owners.get(event.sender) !== owner ||
              owner.cards.get(item.id) !== created ||
              event.senderFrame !== event.sender.mainFrame
            )
              return;
            created.favicon = url;
            if (
              url.startsWith("data:") &&
              configuredCards().some((card) => card.id === item.id && card.url === created.url)
            ) {
              icons.set(item.id, { id: item.id, pageUrl: created.url, dataUrl: url });
              persistIcons();
              if (rendererUrl(event.senderFrame?.url ?? "") && rendererUrl(event.sender.getURL()))
                event.sender.send(DASHBOARD_SITE_ICONS);
            }
            if (!trusted(event)) return;
            event.sender.send("freelens-power:dashboard-site-icon", { id: item.id, url });
          };
          publish(favicon);
          const timeout = setTimeout(() => request.abort(), 5000);
          void (async () => {
            let current = favicon;
            for (let redirects = 0; redirects <= 5; redirects++) {
              const response = await websiteSession.fetch(current, {
                signal: request.signal,
                redirect: "manual",
                credentials: "include",
              });
              if (response.status >= 300 && response.status < 400) {
                await response.body?.cancel();
                const location = response.headers.get("location");
                if (!location) return;
                const next = new URL(location, current);
                if (!webUrl(next.href) || next.username || next.password) return;
                current = next.href;
                continue;
              }
              const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
              if (
                !response.ok ||
                !mime ||
                ![
                  "image/png",
                  "image/jpeg",
                  "image/gif",
                  "image/webp",
                  "image/x-icon",
                  "image/vnd.microsoft.icon",
                  "image/svg+xml",
                ].includes(mime) ||
                Number(response.headers.get("content-length")) > 524288
              ) {
                await response.body?.cancel();
                return;
              }
              const reader = response.body?.getReader();
              if (!reader) return;
              const chunks: Uint8Array[] = [];
              let size = 0;
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > 524288) {
                  await reader.cancel();
                  return;
                }
                chunks.push(value);
              }
              if (size) publish(`data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`);
              return;
            }
          })()
            .catch(() => {})
            .finally(() => clearTimeout(timeout));
        });
      }
      card.visible = true;
      card.container.setVisible(!card.loading && !card.failed && card.url === configured.url);
      const zoom = event.sender.getZoomFactor();
      card.container.setBorderRadius(Math.round(12 * zoom));
      card.view.setBorderRadius(Math.round(12 * zoom));
      const scale = (rect: Rectangle): Rectangle => ({
        x: Math.round(rect.x * zoom),
        y: Math.round(rect.y * zoom),
        width: Math.round(rect.width * zoom),
        height: Math.round(rect.height * zoom),
      });
      card.container.setBounds(scale(clip));
      card.view.setBounds(
        scale({ x: bounds.x - clip.x, y: bounds.y - clip.y, width: bounds.width, height: bounds.height }),
      );
      if (card.url !== configured.url) {
        card.favicon = undefined;
        card.faviconRequest?.abort();
        void reload(card, configured.url, true);
      }
      publishLoading(card);
      if (card.favicon) event.sender.send("freelens-power:dashboard-site-icon", { id: item.id, url: card.favicon });
    }
    for (const [id, card] of owner.cards) {
      if (!cards.some((configured) => configured.id === id)) remove(owner, id);
      else if (!visible.has(id)) {
        card.visible = false;
        card.container.setVisible(false);
      }
    }
    refreshTimers();
    await Promise.all([...owner.cards.values()].map((card) => card.pending));
    return {
      failed: [...owner.cards.entries()].filter(([, card]) => card.failed).map(([id]) => id),
      pinned: [...owner.cards].filter(([, card]) => card.floating).map(([id]) => id),
    };
  });
  const publishPinned = (sender: WebContents, owner: Owner) => {
    if (!sender.isDestroyed())
      sender.send(
        DASHBOARD_VIEWS_PINNED,
        [...owner.cards].filter(([, card]) => card.floating).map(([id]) => id),
      );
  };
  ipcMain.handle(DASHBOARD_VIEWS_PIN, (event, payload: unknown) => {
    if (
      !trusted(event) ||
      !payload ||
      typeof payload !== "object" ||
      !("id" in payload) ||
      typeof payload.id !== "string" ||
      !(("pinned" in payload && typeof payload.pinned === "boolean") || ("focus" in payload && payload.focus === true))
    )
      return;
    const id = payload.id;
    const owner = owners.get(event.sender);
    const card = owner?.cards.get(payload.id);
    const configured = configuredCards().find((item) => item.id === payload.id);
    if (
      !owner ||
      !card ||
      !configured ||
      card.url !== configured.url ||
      owner.window.isDestroyed() ||
      BrowserWindow.fromWebContents(event.sender) !== owner.window ||
      card.view.webContents.isDestroyed()
    )
      return;
    if ("focus" in payload && payload.focus === true) {
      card.floating?.show();
      card.floating?.focus();
    } else if (!("pinned" in payload) || !payload.pinned) {
      card.floating?.close();
    } else if (!card.floating) {
      const floating = new BrowserWindow({
        title: configured.title,
        width: 800,
        height: 600,
        minWidth: 240,
        minHeight: 160,
        resizable: true,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          partition: "persist:freelens-power-websites",
        },
      });
      floating.setMenu(null);
      floating.setAlwaysOnTop(true, "floating");
      floating.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      card.floating = floating;
      card.container.setVisible(false);
      const contents = floating.webContents;
      contents.setWindowOpenHandler(({ url }) => {
        if (webUrl(url)) void shell.openExternal(url).catch(() => {});
        return { action: "deny" };
      });
      const navigation = (event: Electron.Event, url: string) => {
        if (!webUrl(url)) event.preventDefault();
      };
      contents.on("will-navigate", navigation);
      contents.on("will-redirect", navigation);
      contents.on("will-frame-navigate", (event) => {
        if (!webUrl(event.url)) event.preventDefault();
      });
      contents.on("page-title-updated", (event) => event.preventDefault());
      contents.on("will-prevent-unload", (event) => event.preventDefault());
      const skeleton = new View();
      skeleton.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#202124" : "#ffffff");
      const bars = Array.from({ length: 4 }, () => {
        const bar = new View();
        bar.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#393b40" : "#e8e9eb");
        bar.setBorderRadius(6);
        skeleton.addChildView(bar);
        return bar;
      });
      const layoutSkeleton = () => {
        const { width, height } = floating.getContentBounds();
        skeleton.setBounds({ x: 0, y: 0, width, height });
        bars.forEach((bar, index) => {
          bar.setBounds({
            x: 20,
            y: index === 0 ? 20 : 60 + (index - 1) * 24,
            width: Math.max(1, Math.round((width - 40) * (index === 0 ? 0.45 : 1))),
            height: index === 0 ? 20 : index === 3 ? Math.max(30, height - 128) : 12,
          });
        });
      };
      floating.contentView.addChildView(skeleton);
      floating.on("resize", layoutSkeleton);
      layoutSkeleton();
      let generation = 0;
      let floatingPreparing = false;
      let stopPreparation = () => {};
      let finishLoad: (() => Promise<boolean>) | undefined;
      const begin = () => {
        stopPreparation();
        floatingPreparing = true;
        const token = ++generation;
        const backgroundThrottling = contents.getBackgroundThrottling();
        if (backgroundThrottling) contents.setBackgroundThrottling(false);
        const network = observeDashboardNetwork(contents);
        let active = true;
        let finishing: Promise<boolean> | undefined;
        const current = () => active && generation === token && card.floating === floating && !contents.isDestroyed();
        skeleton.setVisible(true);
        stopPreparation = () => {
          if (!active) return;
          active = false;
          floatingPreparing = false;
          network.dispose();
          if (!contents.isDestroyed() && backgroundThrottling) contents.setBackgroundThrottling(true);
        };
        const stop = stopPreparation;
        const finish = () => {
          finishing ??= (async () => {
            await waitForReadiness(contents, network, () => card.selector, current);
            if (!current()) return false;
            skeleton.setVisible(false);
            stop();
            return false;
          })();
          return finishing;
        };
        finishLoad = finish;
        return {
          finish,
          fail: () => {
            if (current()) {
              skeleton.setVisible(false);
              stop();
            }
          },
        };
      };
      const refresh = () => {
        const preparation = begin();
        const current = contents.getURL();
        return contents.loadURL(webUrl(current) ? current : configured.url).then(
          () => finishLoad?.() ?? false,
          () => {
            preparation.fail();
            return !contents.isDestroyed();
          },
        );
      };
      card.floatingPreparation = {
        refresh,
        isPreparing: () => floatingPreparing,
        selectorChanged: () => {
          const preparation = begin();
          if (!contents.isLoading()) void preparation.finish();
        },
        stop: () => {
          ++generation;
          stopPreparation();
        },
      };
      contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
        if (!mainFrame) return;
        const preparation = begin();
        if (inPlace) void preparation.finish();
      });
      contents.on("did-finish-load", () => {
        if (contents.isDestroyed()) return;
        void contents.insertCSS(websiteStyles, { cssOrigin: "user" }).catch(() => {});
        void finishLoad?.();
      });
      contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
        if (!mainFrame || code === -3) return;
        stopPreparation();
        skeleton.setVisible(false);
      });
      contents.once("destroyed", () => {
        ++generation;
        stopPreparation();
      });
      floating.on("closed", () => {
        if (card.floating !== floating) return;
        card.floatingPreparation?.stop();
        card.floatingPreparation = undefined;
        card.floating = undefined;
        if (owner.cards.get(id) === card) publishPinned(event.sender, owner);
      });
      const initial = begin();
      void contents.loadURL(configured.url).then(() => finishLoad?.(), initial.fail);
      floating.show();
    }
    publishPinned(event.sender, owner);
    return { pinned: [...owner.cards].filter(([, item]) => item.floating).map(([id]) => id) };
  });
  ipcMain.handle(clearChannel, (event) => {
    if (
      event.senderFrame === event.sender.mainFrame &&
      rendererUrl(event.senderFrame?.url ?? "") &&
      rendererUrl(event.sender.getURL())
    )
      hide(event.sender);
  });
  ipcMain.handle(reloadChannel, async (event, payload: unknown) => {
    if (
      !trusted(event) ||
      !payload ||
      typeof payload !== "object" ||
      !("id" in payload) ||
      typeof payload.id !== "string"
    )
      return;
    const owner = owners.get(event.sender);
    const card = owner?.cards.get(payload.id);
    const configured = sanitizeDashboardCards(
      DashboardPreferencesStore.getInstanceOrCreate<DashboardPreferencesStore>().cards,
    ).find((item) => item.id === payload.id);
    if (!card || !configured || card.view.webContents.isDestroyed()) return;
    const [, floatingFailed] = await Promise.all([
      reload(card, configured.url),
      card.floatingPreparation?.refresh() ?? Promise.resolve(false),
    ]);
    return { failed: card.failed || floatingFailed ? [payload.id] : [] };
  });
  return () => {
    stopSettingsReaction();
    ipcMain.removeHandler(DASHBOARD_VIEWS_PIN);
    ipcMain.removeHandler(DASHBOARD_SITE_ICONS);
    ipcMain.removeHandler(syncChannel);
    ipcMain.removeHandler(clearChannel);
    ipcMain.removeHandler(reloadChannel);
    for (const sender of owners.keys()) clear(sender);
  };
}
