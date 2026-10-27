import { Renderer } from "@freelensapp/extensions";
// SPDX-License-Identifier: Apache-2.0
import { ipcRenderer, shell } from "electron";
import { observer } from "mobx-react";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { normalizeDashboardUrl } from "../common/dashboard";
import {
  DASHBOARD_VIEWS_CLEAR,
  DASHBOARD_VIEWS_LOADING,
  DASHBOARD_VIEWS_PIN,
  DASHBOARD_VIEWS_PINNED,
  DASHBOARD_VIEWS_RELOAD,
  DASHBOARD_VIEWS_SYNC,
  type DashboardViewLoading,
} from "../common/dashboard-views";
import { DashboardPreferencesStore } from "../common/store/dashboard-preferences-store";
import { AiPinIcon } from "./ai-icon";

const styles = `
  .freelens-power-dashboard .power-dashboard-card-pinned .power-dashboard-embed { opacity: .65; }
  .freelens-power-dashboard .power-dashboard-pin-placeholder { display: flex; width: 100%; height: 100%; flex-direction: column; align-items: center; justify-content: center; gap: 12px; border: 0; background: var(--mainBackground); color: var(--textColorSecondary); cursor: pointer; font: inherit; }
  .freelens-power-dashboard .power-dashboard-pin-placeholder:hover { color: var(--textColorAccent); }

  .ClusterManager main.freelens-power-dashboard, .freelens-power-dashboard { display: block; position: relative; z-index: 2; flex: 1; background: var(--mainBackground); padding: 28px; color: var(--textColorPrimary); min-width: 0; min-height: 0; height: auto; overflow: auto; box-sizing: border-box; }
  .freelens-power-dashboard .power-dashboard-header {
    display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 24px;
  }
  .freelens-power-dashboard h1 { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--textColorAccent); font-size: 24px; }
  .freelens-power-dashboard .power-dashboard-subtitle,
  .freelens-power-dashboard .power-dashboard-hint { color: var(--textColorSecondary); line-height: 1.5; }
  .freelens-power-dashboard .power-dashboard-subtitle { margin: 6px 0 0; }
  .freelens-power-dashboard button {
    padding: 9px 16px; border: 1px solid var(--borderFaintColor); border-radius: 8px;
    background: var(--contentColor); color: var(--textColorAccent); cursor: pointer;
  }
  .freelens-power-dashboard .power-dashboard-header .power-dashboard-action { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 6px 12px; font-size: 13px; background: transparent; color: var(--textColorSecondary); }
  .freelens-power-dashboard .power-dashboard-header .power-dashboard-action { transition: background-color 140ms, border-color 140ms, color 140ms; }
  .freelens-power-dashboard .power-dashboard-header .power-dashboard-action:hover { background: var(--contentColor); border-color: var(--borderColor); color: var(--textColorAccent); }
  .freelens-power-dashboard .power-dashboard-header .power-dashboard-action:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .freelens-power-dashboard .power-dashboard-header .power-dashboard-action .Icon { color: inherit; transition: color 160ms ease; }
  .freelens-power-dashboard .power-dashboard-header .power-dashboard-refresh { width: 32px; height: 32px; padding: 0; justify-content: center; border-color: transparent; border-radius: 8px; }
  .freelens-power-dashboard .power-dashboard-header .power-dashboard-refresh:hover { border-color: transparent; background: color-mix(in srgb, var(--primary) 10%, transparent); color: var(--primary); }
  .power-dashboard-actions { display: flex; align-items: center; gap: 8px; }
  .power-dashboard-action:disabled { opacity: 0.5; cursor: wait; }
  .freelens-power-dashboard .power-dashboard-grid {
    display: grid; grid-template-columns: repeat(var(--power-columns, 4), minmax(0, 1fr)); grid-auto-rows: 220px; grid-auto-flow: row; gap: 20px;
  }
  .freelens-power-dashboard .power-dashboard-card {
    display: flex; flex-direction: column; min-width: 0; overflow: hidden;
    border: 1px solid var(--borderFaintColor); border-radius: 12px; background: var(--contentColor);
  }
  .freelens-power-dashboard.power-dashboard-expanded { display: flex !important; flex-direction: column; overflow: hidden; }
  .freelens-power-dashboard.power-dashboard-expanded .power-dashboard-grid { display: block; flex: 1; min-height: 0; }
  .freelens-power-dashboard.power-dashboard-expanded .power-dashboard-card:not([hidden]) { height: 100%; box-sizing: border-box; }
  .freelens-power-dashboard .power-dashboard-card[hidden] { display: none; }
  .freelens-power-dashboard .power-dashboard-card-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .freelens-power-dashboard button.power-dashboard-expand { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--textColorSecondary); transition: color 160ms ease, background-color 160ms ease; }
  .freelens-power-dashboard button.power-dashboard-expand:hover { color: var(--textColorAccent); background: var(--mainBackground); }
  .freelens-power-dashboard button.power-dashboard-expand[aria-pressed="true"],
  .freelens-power-dashboard button.power-dashboard-expand[aria-pressed="true"] .Icon { color: var(--primary); }
  .freelens-power-dashboard button.power-dashboard-expand[aria-pressed="true"]:hover { background: color-mix(in srgb, var(--primary) 12%, transparent); }
  .freelens-power-dashboard button.power-dashboard-expand:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .freelens-power-dashboard .power-dashboard-card-xs { grid-column: span 1; grid-row: span 1; }
  .freelens-power-dashboard .power-dashboard-card-s { grid-column: span var(--power-small-span, 2); grid-row: span 2; }
  .freelens-power-dashboard .power-dashboard-card-m { grid-column: span var(--power-medium-span, 4); grid-row: span 2; }
  .freelens-power-dashboard .power-dashboard-card-l { grid-column: span var(--power-large-span, 4); grid-row: span 3; }
  .freelens-power-dashboard .power-dashboard-card-xl { grid-column: span var(--power-columns, 4); grid-row: span 3; }
  .freelens-power-dashboard .power-dashboard-card-header {
    display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 12px;
  }
  .freelens-power-dashboard h2 { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
  .freelens-power-dashboard .power-dashboard-card-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .freelens-power-dashboard .power-dashboard-card-title h2 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .freelens-power-dashboard .power-dashboard-card-xs .power-dashboard-card-header { flex-wrap: wrap; row-gap: 4px; }
  .freelens-power-dashboard .power-dashboard-card-xs .power-dashboard-card-title { flex-basis: 100%; }
  .freelens-power-dashboard .power-dashboard-card-xs .power-dashboard-card-actions { margin-left: auto; }
  .freelens-power-dashboard .power-dashboard-site-icon { width: 16px; height: 16px; border-radius: 4px; object-fit: contain; flex-shrink: 0; }
  .freelens-power-dashboard .power-dashboard-card-header a {
    flex-shrink: 0; color: var(--textColorPrimary); font-size: 12px; transition: color 160ms ease;
  }
  .freelens-power-dashboard .power-dashboard-card-header a .Icon { color: inherit; transition: color 160ms ease; }
  .freelens-power-dashboard .power-dashboard-card-header a:hover { color: var(--textColorAccent); }
  .freelens-power-dashboard .power-dashboard-embed { width: 100%; flex: 1; min-height: 0; overflow: hidden; }
  .freelens-power-dashboard .power-dashboard-skeleton { height: 100%; box-sizing: border-box; padding: 20px; display: flex; flex-direction: column; gap: 12px; background: var(--contentColor); }
  .freelens-power-dashboard .power-dashboard-skeleton span { height: 12px; border-radius: 6px; background: color-mix(in srgb, var(--textColorSecondary) 12%, transparent); animation: power-dashboard-loading 1.8s ease-in-out infinite; }
  .freelens-power-dashboard .power-dashboard-skeleton span:first-child { width: 45%; height: 20px; margin-bottom: 8px; }
  .freelens-power-dashboard .power-dashboard-skeleton span:last-child { flex: 1; min-height: 30px; }
  @keyframes power-dashboard-loading { 50% { opacity: .45; } }
  @media (prefers-reduced-motion: reduce) { .freelens-power-dashboard .power-dashboard-skeleton span { animation: none; } }
  .freelens-power-dashboard .power-dashboard-hint { margin: 16px 0 0; font-size: 12px; }
  .power-dashboard-right-tooltip { position: fixed !important; left: calc(anchor(right) + 8px) !important; top: anchor(center) !important; right: auto !important; bottom: auto !important; translate: 0 -50%; white-space: nowrap !important; max-width: none !important; }
  .freelens-power-dashboard .power-dashboard-empty {
    padding: 40px 24px; border: 1px solid var(--borderFaintColor); border-radius: 12px;
    background: var(--contentColor); text-align: center;
  }
  .freelens-power-dashboard .power-dashboard-empty > button { display:inline-flex; align-items:center; gap:7px; }
  .freelens-power-dashboard .power-dashboard-empty p { color: var(--textColorSecondary); margin: 12px 0 24px; }
  @media (max-width: 700px) {
    .ClusterManager main.freelens-power-dashboard, .freelens-power-dashboard { display: block; position: relative; z-index: 2; flex: 1; background: var(--mainBackground); padding: 18px; }
    .freelens-power-dashboard .power-dashboard-header { flex-wrap: wrap; }
  }
`;

function DashboardActionIcon({ material, tooltip, pinned }: { material: string; tooltip: string; pinned?: boolean }) {
  const [anchor] = useState(() => `--power-dashboard-action-${crypto.randomUUID()}`);
  if (pinned !== undefined)
    return (
      <>
        <span id={anchor} style={{ anchorName: anchor, display: "inline-flex" } as CSSProperties}>
          <AiPinIcon pinned={pinned} size={18} />
        </span>
        <Renderer.Component.Tooltip
          targetId={anchor}
          className="power-dashboard-right-tooltip"
          style={{ positionAnchor: anchor } as CSSProperties}
        >
          {tooltip}
        </Renderer.Component.Tooltip>
      </>
    );
  return (
    <Renderer.Component.Icon
      material={material}
      size={18}
      style={{ anchorName: anchor, "--size": "18px" } as CSSProperties}
      tooltip={{ children: tooltip, className: "power-dashboard-right-tooltip", style: { positionAnchor: anchor } }}
    />
  );
}

function WebsiteIcon({ url, favicon }: { url: string; favicon?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <span className="power-dashboard-site-icon" aria-hidden="true">
        🌐
      </span>
    );
  return (
    <img
      className="power-dashboard-site-icon"
      src={favicon || new URL("/favicon.ico", url).href}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export const DashboardPage = observer(({ onOpenPreferences }: { onOpenPreferences: () => void }) => {
  const preferences = DashboardPreferencesStore.getInstanceOrCreate<DashboardPreferencesStore>();
  const cards = preferences.cards.flatMap((card) => {
    const url = normalizeDashboardUrl(card.url);
    return url ? [{ ...card, url }] : [];
  });
  const root = useRef<HTMLElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = cards.some((card) => card.id === expandedId) ? expandedId : null;
  const expandedRef = useRef<string | null>(null);
  const gridScrollTop = useRef<number | null>(null);
  expandedRef.current = expanded;
  useLayoutEffect(() => {
    const container = root.current;
    if (!container) return;
    if (expanded) container.scrollTop = 0;
    else if (gridScrollTop.current !== null) {
      container.scrollTop = gridScrollTop.current;
      gridScrollTop.current = null;
    }
  }, [expanded]);
  useEffect(() => {
    if (expandedId && !expanded) setExpandedId(null);
  }, [expandedId, expanded]);
  useEffect(() => {
    const restore = () => setExpandedId(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && expandedRef.current) {
        event.preventDefault();
        event.stopPropagation();
        restore();
      }
    };
    document.addEventListener("keydown", escape, true);
    ipcRenderer.on("freelens-power:dashboard-escape", restore);
    return () => {
      document.removeEventListener("keydown", escape, true);
      ipcRenderer.removeListener("freelens-power:dashboard-escape", restore);
    };
  }, []);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadingCards, setLoadingCards] = useState<Record<string, DashboardViewLoading>>({});
  useEffect(() => {
    const update = (_event: unknown, value: DashboardViewLoading) => {
      if (
        !value ||
        typeof value.id !== "string" ||
        typeof value.url !== "string" ||
        typeof value.loading !== "boolean" ||
        typeof value.failed !== "boolean" ||
        !preferences.cards.some((card) => card.id === value.id && normalizeDashboardUrl(card.url) === value.url)
      )
        return;
      setLoadingCards((previous) => {
        const existing = previous[value.id];
        return existing?.url === value.url && existing.loading === value.loading && existing.failed === value.failed
          ? previous
          : { ...previous, [value.id]: value };
      });
      if (value.failed) setLoadFailed(true);
    };
    ipcRenderer.on(DASHBOARD_VIEWS_LOADING, update);
    return () => {
      ipcRenderer.removeListener(DASHBOARD_VIEWS_LOADING, update);
    };
  }, [preferences]);
  const [reloading, setReloading] = useState(false);
  const [reloadBlocked, setReloadBlocked] = useState(false);
  const reloadRequest = useRef(0);
  const reloadCooldown = useRef<ReturnType<typeof setTimeout>>();
  useEffect(
    () => () => {
      ++reloadRequest.current;
      clearTimeout(reloadCooldown.current);
    },
    [],
  );
  const reloadCards = async () => {
    if (reloadCooldown.current) return;
    const request = ++reloadRequest.current;
    setReloading(true);
    setReloadBlocked(true);
    reloadCooldown.current = setTimeout(() => {
      reloadCooldown.current = undefined;
      setReloadBlocked(false);
    }, 1000);
    try {
      const results = await Promise.all(cards.map(({ id }) => ipcRenderer.invoke(DASHBOARD_VIEWS_RELOAD, { id })));
      if (reloadRequest.current === request) setLoadFailed(results.some((result) => result?.failed?.length));
    } catch {
      if (reloadRequest.current === request) setLoadFailed(true);
    } finally {
      if (reloadRequest.current === request) {
        clearTimeout(reloadCooldown.current);
        reloadCooldown.current = undefined;
        setReloadBlocked(false);
        setReloading(false);
      }
    }
  };
  const focusPinned = (id: string) => {
    void ipcRenderer.invoke(DASHBOARD_VIEWS_PIN, { id, focus: true }).catch(() => setLoadFailed(true));
  };
  const [pinnedCards, setPinnedCards] = useState<string[]>([]);
  useEffect(() => {
    const update = (_event: unknown, ids: unknown) => {
      if (Array.isArray(ids)) setPinnedCards(ids.filter((id): id is string => typeof id === "string"));
    };
    ipcRenderer.on(DASHBOARD_VIEWS_PINNED, update);
    return () => {
      ipcRenderer.removeListener(DASHBOARD_VIEWS_PINNED, update);
    };
  }, []);
  const togglePinned = async (id: string) => {
    try {
      const result = await ipcRenderer.invoke(DASHBOARD_VIEWS_PIN, { id, pinned: !pinnedCards.includes(id) });
      if (Array.isArray(result?.pinned))
        setPinnedCards(result.pinned.filter((value: unknown): value is string => typeof value === "string"));
    } catch {
      setLoadFailed(true);
    }
  };
  const [siteIcons, setSiteIcons] = useState<Record<string, string>>({});
  useEffect(() => {
    const update = (_event: unknown, icon: { id?: unknown; url?: unknown }) => {
      if (typeof icon?.id !== "string" || typeof icon.url !== "string") return;
      const imageData =
        icon.url.length <= 720_000 &&
        /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(
          icon.url,
        );
      const url = imageData ? icon.url : normalizeDashboardUrl(icon.url);
      if (!url) return;
      const id = icon.id;
      setSiteIcons((previous) => (previous[id] === url ? previous : { ...previous, [id]: url }));
    };
    ipcRenderer.on("freelens-power:dashboard-site-icon", update);
    return () => {
      ipcRenderer.removeListener("freelens-power:dashboard-site-icon", update);
    };
  }, []);
  const cardIdentity = JSON.stringify(cards.map(({ id, url, size }) => ({ id, url, size })));
  useEffect(() => {
    setSiteIcons({});
  }, [cardIdentity]);
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    let active = true;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const containerStyle = window.getComputedStyle(container);
      const contentWidth =
        container.clientWidth -
        (Number.parseFloat(containerStyle.paddingLeft) || 0) -
        (Number.parseFloat(containerStyle.paddingRight) || 0);
      const columns = contentWidth >= 1200 ? 6 : contentWidth >= 800 ? 4 : contentWidth >= 520 ? 2 : 1;
      for (const [property, value] of Object.entries({
        "--power-columns": columns,
        "--power-small-span": Math.min(2, columns),
        "--power-medium-span": Math.min(4, columns),
        "--power-large-span": Math.min(4, columns),
      })) {
        if (container.style.getPropertyValue(property) !== String(value))
          container.style.setProperty(property, String(value));
      }
      const containerBounds = container.getBoundingClientRect();
      const viewport = {
        left: Math.max(0, containerBounds.left),
        top: Math.max(0, containerBounds.top),
        right: Math.min(window.innerWidth, containerBounds.right),
        bottom: Math.min(window.innerHeight, containerBounds.bottom),
      };
      for (let ancestor = container.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = window.getComputedStyle(ancestor);
        const rect = ancestor.getBoundingClientRect();
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow)) {
          viewport.left = Math.max(viewport.left, rect.left + ancestor.clientLeft);
          viewport.right = Math.min(viewport.right, rect.left + ancestor.clientLeft + ancestor.clientWidth);
        }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow)) {
          viewport.top = Math.max(viewport.top, rect.top + ancestor.clientTop);
          viewport.bottom = Math.min(viewport.bottom, rect.top + ancestor.clientTop + ancestor.clientHeight);
        }
      }
      const overlayOpen = Array.from(
        document.querySelectorAll<HTMLElement>('.Dialog, [role="dialog"], [role="menu"], .Menu, .power-ai-panel'),
      ).some((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const visible = overlayOpen
        ? []
        : Array.from(container.querySelectorAll<HTMLElement>(".power-dashboard-embed")).flatMap((element) => {
            if (expandedRef.current && element.dataset.cardId !== expandedRef.current) return [];
            const rect = element.getBoundingClientRect();
            const x = Math.ceil(Math.max(rect.left, viewport.left));
            const y = Math.ceil(Math.max(rect.top, viewport.top));
            const right = Math.floor(Math.min(rect.right, viewport.right));
            const bottom = Math.floor(Math.min(rect.bottom, viewport.bottom));
            const bounds = {
              x: Math.floor(rect.left),
              y: Math.floor(rect.top),
              width: Math.ceil(rect.right) - Math.floor(rect.left),
              height: Math.ceil(rect.bottom) - Math.floor(rect.top),
            };
            const clip = { x, y, width: right - x, height: bottom - y };
            if (
              ![...Object.values(bounds), ...Object.values(clip)].every(Number.isFinite) ||
              rect.width <= 0 ||
              rect.height <= 0 ||
              clip.width <= 0 ||
              clip.height <= 0
            )
              return [];
            return [
              {
                id: element.dataset.cardId,
                bounds,
                clip,
                ...(expandedRef.current === element.dataset.cardId ? { scrollbars: true } : {}),
              },
            ];
          });
      void ipcRenderer
        .invoke(DASHBOARD_VIEWS_SYNC, {
          cards: visible,
          ...(overlayOpen ? { hidden: true } : {}),
        })
        .then(
          (result) => {
            if (active) {
              setLoadFailed(Boolean(result?.failed?.length));
              if (Array.isArray(result?.pinned)) setPinnedCards(result.pinned);
            }
          },
          () => {
            if (active) setLoadFailed(true);
          },
        );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(sync);
    };
    const activate = () => {
      if (document.visibilityState === "hidden") return;
      schedule();
    };
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    for (let ancestor = container.parentElement; ancestor; ancestor = ancestor.parentElement)
      observer.observe(ancestor);
    for (const element of container.querySelectorAll(".power-dashboard-embed")) observer.observe(element);
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.addEventListener("focus", activate);
    document.addEventListener("visibilitychange", activate);
    schedule();
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focus", activate);
      document.removeEventListener("visibilitychange", activate);
      void ipcRenderer.invoke(DASHBOARD_VIEWS_CLEAR).catch(() => {});
    };
  }, [cardIdentity]);

  return (
    <main ref={root} className={`freelens-power-dashboard${expanded ? " power-dashboard-expanded" : ""}`}>
      <style>{styles}</style>
      <header className="power-dashboard-header">
        <div>
          <h1>
            <Renderer.Component.Icon material="battery_full" size={24} aria-hidden="true" />
            Power Dashboard
          </h1>
        </div>
        <div className="power-dashboard-actions">
          <button
            type="button"
            className="power-dashboard-action power-dashboard-refresh"
            aria-label="Refresh"
            aria-busy={reloading}
            disabled={reloadBlocked || cards.length === 0}
            onClick={() => {
              void reloadCards();
            }}
          >
            <Renderer.Component.Icon material="refresh" size={18} tooltip="Refresh" />
          </button>
          <button type="button" className="power-dashboard-action" onClick={onOpenPreferences}>
            <span aria-hidden="true">
              <Renderer.Component.Icon material="dashboard" size={16} />
            </span>{" "}
            Settings
          </button>
        </div>
      </header>
      {cards.length === 0 ? (
        <section className="power-dashboard-empty">
          <h2>Build your dashboard</h2>
          <p>Add your favorite tools and pages in Settings.</p>
          <button type="button" onClick={onOpenPreferences}>
            <span aria-hidden="true">
              <Renderer.Component.Icon material="add" size={16} />
            </span>
            Add cards
          </button>
        </section>
      ) : (
        <>
          <div className="power-dashboard-grid">
            {cards.map((card) => (
              <section
                key={card.id}
                hidden={Boolean(expanded && expanded !== card.id)}
                className={`power-dashboard-card power-dashboard-card-${card.size}${pinnedCards.includes(card.id) ? " power-dashboard-card-pinned" : ""}`}
              >
                <header className="power-dashboard-card-header">
                  <div className="power-dashboard-card-title">
                    <WebsiteIcon
                      key={`${card.url}:${siteIcons[card.id] || ""}`}
                      url={card.url}
                      favicon={siteIcons[card.id]}
                    />
                    <h2>{card.title}</h2>
                  </div>
                  <div className="power-dashboard-card-actions">
                    <button
                      type="button"
                      className="power-dashboard-expand"
                      aria-label={`Auto-refresh ${card.title} every 10 seconds`}
                      aria-pressed={card.refreshEvery10Seconds === true}
                      onClick={() => {
                        preferences.upsertCard({ ...card, refreshEvery10Seconds: !card.refreshEvery10Seconds });
                      }}
                    >
                      <DashboardActionIcon
                        material="autorenew"
                        tooltip={card.refreshEvery10Seconds ? "Disable refresh" : "Enable refresh (10s)"}
                      />
                    </button>
                    <button
                      type="button"
                      className="power-dashboard-expand"
                      aria-label={`${pinnedCards.includes(card.id) ? "Unpin" : "Pin"} ${card.title}`}
                      aria-pressed={pinnedCards.includes(card.id)}
                      onClick={() => {
                        void togglePinned(card.id);
                      }}
                    >
                      <DashboardActionIcon
                        material="push_pin"
                        pinned={pinnedCards.includes(card.id)}
                        tooltip={pinnedCards.includes(card.id) ? "Unpin" : "Pin"}
                      />
                    </button>
                    <button
                      type="button"
                      className="power-dashboard-expand"
                      aria-label={`${expanded === card.id ? "Restore" : "Expand"} ${card.title}`}
                      aria-pressed={expanded === card.id}
                      onClick={() => {
                        if (!expanded) gridScrollTop.current = root.current?.scrollTop ?? 0;
                        setExpandedId(expanded === card.id ? null : card.id);
                      }}
                    >
                      <DashboardActionIcon
                        material={expanded === card.id ? "fullscreen_exit" : "fullscreen"}
                        tooltip={expanded === card.id ? "Restore" : "Expand"}
                      />
                    </button>
                    <a
                      href={card.url}
                      onClick={(event) => {
                        event.preventDefault();
                        void shell.openExternal(card.url);
                      }}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open ${card.title} in browser`}
                    >
                      <DashboardActionIcon material="open_in_new" tooltip="Open" />
                    </a>
                  </div>
                </header>
                <div
                  className="power-dashboard-embed"
                  data-card-id={card.id}
                  role="region"
                  aria-label={card.title}
                  aria-busy={loadingCards[card.id]?.url === card.url && loadingCards[card.id]?.loading}
                >
                  {!pinnedCards.includes(card.id) &&
                    loadingCards[card.id]?.url === card.url &&
                    loadingCards[card.id]?.loading && (
                      <div className="power-dashboard-skeleton" role="status" aria-label={`Loading ${card.title}`}>
                        <span aria-hidden="true" />
                        <span aria-hidden="true" />
                        <span aria-hidden="true" />
                      </div>
                    )}
                  {pinnedCards.includes(card.id) && (
                    <button
                      type="button"
                      className="power-dashboard-pin-placeholder"
                      onClick={() => focusPinned(card.id)}
                      aria-label={`Focus pinned ${card.title}`}
                    >
                      <Renderer.Component.Icon material="push_pin" size={28} />
                      <span>Pinned above other windows</span>
                      <span>Focus window</span>
                    </button>
                  )}
                </div>
              </section>
            ))}
          </div>
          {loadFailed && (
            <p role="alert" className="power-dashboard-hint">
              Unable to load dashboard cards. Open them in your browser.
            </p>
          )}
        </>
      )}
    </main>
  );
});
