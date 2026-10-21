import { Renderer } from "@freelensapp/extensions";
// SPDX-License-Identifier: Apache-2.0
import { ipcRenderer, shell } from "electron";
import { observer } from "mobx-react";
import { useEffect, useRef, useState } from "react";
import { normalizeDashboardUrl } from "../common/dashboard";
import { DASHBOARD_VIEWS_CLEAR, DASHBOARD_VIEWS_RELOAD, DASHBOARD_VIEWS_SYNC } from "../common/dashboard-views";
import { DashboardPreferencesStore } from "../common/store/dashboard-preferences-store";

const styles = `
  .ClusterManager main.freelens-power-dashboard, .freelens-power-dashboard { display: block; position: relative; z-index: 2; flex: 1; background: var(--mainBackground); padding: 28px; color: var(--textColorPrimary); min-width: 0; height: 100%; overflow: auto; box-sizing: border-box; }
  .freelens-power-dashboard .power-dashboard-header {
    display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 24px;
  }
  .freelens-power-dashboard h1 { margin: 0; color: var(--textColorAccent); font-size: 24px; }
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
  .freelens-power-dashboard .power-dashboard-card-s { grid-column: span 1; grid-row: span 1; }
  .freelens-power-dashboard .power-dashboard-card-m { grid-column: span var(--power-medium-span, 2); grid-row: span 2; }
  .freelens-power-dashboard .power-dashboard-card-l { grid-column: span var(--power-large-span, 4); grid-row: span 4; }
  .freelens-power-dashboard .power-dashboard-card-header {
    display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px;
  }
  .freelens-power-dashboard h2 { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
  .freelens-power-dashboard .power-dashboard-card-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .freelens-power-dashboard .power-dashboard-site-icon { width: 16px; height: 16px; border-radius: 4px; object-fit: contain; flex-shrink: 0; }
  .freelens-power-dashboard .power-dashboard-card-header a {
    flex-shrink: 0; color: var(--textColorPrimary); font-size: 12px; transition: color 160ms ease;
  }
  .freelens-power-dashboard .power-dashboard-card-header a .Icon { color: inherit; transition: color 160ms ease; }
  .freelens-power-dashboard .power-dashboard-card-header a:hover { color: var(--textColorAccent); }
  .freelens-power-dashboard .power-dashboard-embed { width: 100%; flex: 1; min-height: 0; overflow: hidden; }
  .freelens-power-dashboard .power-dashboard-hint { margin: 16px 0 0; font-size: 12px; }
  .freelens-power-dashboard .power-dashboard-empty {
    padding: 40px 24px; border: 1px solid var(--borderFaintColor); border-radius: 12px;
    background: var(--contentColor); text-align: center;
  }
  .freelens-power-dashboard .power-dashboard-empty p { color: var(--textColorSecondary); margin: 12px 0 24px; }
  @media (max-width: 700px) {
    .ClusterManager main.freelens-power-dashboard, .freelens-power-dashboard { display: block; position: relative; z-index: 2; flex: 1; background: var(--mainBackground); padding: 18px; }
    .freelens-power-dashboard .power-dashboard-header { flex-wrap: wrap; }
  }
`;

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
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloading, setReloading] = useState(false);
  const reloadCards = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      const results = await Promise.all(cards.map(({ id }) => ipcRenderer.invoke(DASHBOARD_VIEWS_RELOAD, { id })));
      setLoadFailed(results.some((result) => result?.failed?.length));
    } catch {
      setLoadFailed(true);
    } finally {
      setReloading(false);
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
      const columns = Math.max(1, Math.min(12, Math.floor((contentWidth + 20) / 260)));
      for (const [property, value] of Object.entries({
        "--power-columns": columns,
        "--power-medium-span": Math.min(2, columns),
        "--power-large-span": Math.min(4, columns),
      })) {
        if (container.style.getPropertyValue(property) !== String(value))
          container.style.setProperty(property, String(value));
      }
      const containerBounds = container.getBoundingClientRect();
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
            const rect = element.getBoundingClientRect();
            const x = Math.ceil(Math.max(0, rect.left, containerBounds.left));
            const y = Math.ceil(Math.max(0, rect.top, containerBounds.top));
            const right = Math.floor(Math.min(window.innerWidth, rect.right, containerBounds.right));
            const bottom = Math.floor(Math.min(window.innerHeight, rect.bottom, containerBounds.bottom));
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
            return [{ id: element.dataset.cardId, bounds, clip }];
          });
      void ipcRenderer.invoke(DASHBOARD_VIEWS_SYNC, { cards: visible, ...(overlayOpen ? { hidden: true } : {}) }).then(
        (result) => {
          if (active) setLoadFailed(Boolean(result?.failed?.length));
        },
        () => {
          if (active) setLoadFailed(true);
        },
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(sync);
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
    for (const element of container.querySelectorAll(".power-dashboard-embed")) observer.observe(element);
    container.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      container.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      void ipcRenderer.invoke(DASHBOARD_VIEWS_CLEAR).catch(() => {});
    };
  }, [cardIdentity]);

  return (
    <main ref={root} className="freelens-power-dashboard">
      <style>{styles}</style>
      <header className="power-dashboard-header">
        <div>
          <h1>🔋 Power Dashboard</h1>
        </div>
        <div className="power-dashboard-actions">
          <button
            type="button"
            className="power-dashboard-action power-dashboard-refresh"
            aria-label="Refresh"
            aria-busy={reloading}
            disabled={reloading || cards.length === 0}
            onClick={() => {
              void reloadCards();
            }}
          >
            <Renderer.Component.Icon material="refresh" size={18} tooltip="Refresh" />
          </button>
          <button type="button" className="power-dashboard-action" onClick={onOpenPreferences}>
            <span aria-hidden="true">
              <Renderer.Component.Icon material="settings" size={16} />
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
            Add cards
          </button>
        </section>
      ) : (
        <>
          <div className="power-dashboard-grid">
            {cards.map((card) => (
              <section key={card.id} className={`power-dashboard-card power-dashboard-card-${card.size}`}>
                <header className="power-dashboard-card-header">
                  <div className="power-dashboard-card-title">
                    <WebsiteIcon
                      key={`${card.url}:${siteIcons[card.id] || ""}`}
                      url={card.url}
                      favicon={siteIcons[card.id]}
                    />
                    <h2>{card.title}</h2>
                  </div>
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
                    <Renderer.Component.Icon material="open_in_new" size={18} tooltip="Open in browser" />
                  </a>
                </header>
                <div className="power-dashboard-embed" data-card-id={card.id} role="region" aria-label={card.title} />
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
