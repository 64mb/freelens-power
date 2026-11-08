import { Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { clusterIconDataUrl } from "../common/cluster-icons";
import { ClusterIconsStore } from "../common/store/cluster-icons-store";

export function startClusterIconOverlay(): () => void {
  const store = ClusterIconsStore.getInstanceOrCreate<ClusterIconsStore>();
  const links = () => Renderer.Catalog.catalogEntities.getItemsForApiKind("entity.k8slens.dev/v1alpha1", "WebLink");
  const owned = new Map<HTMLElement, HTMLImageElement>();
  const webLinkAvatars = new Set<HTMLElement>();
  const style = document.createElement("style");
  style.textContent = `[data-power-cluster-icon]{position:relative!important;color:transparent!important;background:transparent!important}[data-power-cluster-icon]>:not([data-power-icon-image]):not([data-power-hotbar-number]){visibility:hidden!important}[data-power-icon-image]{position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;pointer-events:none;object-fit:cover}[data-power-web-link-avatar]>img{width:16px;height:16px;margin:auto;object-fit:contain}`;
  document.head.append(style);
  let stopped = false;
  const update = () => {
    if (stopped) return;
    const urls = new Map(Object.entries(store.icons).map(([id, value]) => [id, clusterIconDataUrl(value.design)]));
    const remote = new Set<string>();
    const webLinkIds = new Set<string>();
    const nextWebLinkAvatars = new Set<HTMLElement>();
    for (const link of links()) {
      webLinkIds.add(link.getId());
      if (link.spec.icon?.src || typeof link.spec.url !== "string") continue;
      try {
        const page = new URL(link.spec.url);
        if (!["http:", "https:"].includes(page.protocol) || page.username || page.password) continue;
        const url = new URL("/favicon.ico", page).href;
        urls.set(link.getId(), url);
        remote.add(url);
      } catch {
        // keep the native avatar for invalid links
      }
    }
    const targets = new Map<HTMLElement, string>();
    try {
      const id = /^\/entity\/([^/]+)\/settings\/?$/.exec(location.pathname)?.[1];
      const url = id ? urls.get(decodeURIComponent(id)) : undefined;
      if (url)
        for (const avatar of document.querySelectorAll<HTMLElement>(
          '[data-testid="entity-settings"] [class*="Avatar"]',
        ))
          targets.set(avatar, url);
    } catch {
      // keep native avatars for malformed entity routes
    }
    for (const avatar of document.querySelectorAll<HTMLElement>('[id^="hotbarIcon-"]')) {
      const url = urls.get(avatar.id.slice("hotbarIcon-".length));
      if (url) targets.set(avatar, url);
    }
    for (const container of document.querySelectorAll<HTMLElement>(
      '[data-testid="sidebar-cluster-dropdown"][id^="cluster-"]',
    )) {
      const url = urls.get(container.id.slice("cluster-".length));
      const avatar = container.querySelector<HTMLElement>('[class*="Avatar"]');
      if (url && avatar) targets.set(avatar, url);
    }
    for (const container of document.querySelectorAll<HTMLElement>(
      '[data-testid^="catalog-entity-details-content-for-"]',
    )) {
      const id = container.getAttribute("data-testid")?.slice("catalog-entity-details-content-for-".length);
      const url = id ? urls.get(id) : undefined;
      const avatar = container.querySelector<HTMLElement>('[data-testid="detail-panel-hot-bar-icon"]');
      if (url && avatar) targets.set(avatar, url);
    }
    for (const menu of document.querySelectorAll<HTMLElement>(
      '[data-testid^="icon-for-menu-actions-for-catalog-for-"]',
    )) {
      const id = menu.getAttribute("data-testid")?.slice("icon-for-menu-actions-for-catalog-for-".length);
      const url = id ? urls.get(id) : undefined;
      const avatar = menu.closest(".TableRow")?.querySelector<HTMLElement>('[class*="Avatar"]');
      if (avatar && id && webLinkIds.has(id)) {
        nextWebLinkAvatars.add(avatar);
        avatar.setAttribute("data-power-web-link-avatar", "");
      }
      if (url && avatar) targets.set(avatar, url);
    }
    for (const avatar of webLinkAvatars) {
      if (!nextWebLinkAvatars.has(avatar)) avatar.removeAttribute("data-power-web-link-avatar");
    }
    webLinkAvatars.clear();
    for (const avatar of nextWebLinkAvatars) webLinkAvatars.add(avatar);
    for (const [avatar, image] of owned) {
      if (targets.has(avatar) && avatar.isConnected) continue;
      image.remove();
      avatar.removeAttribute("data-power-cluster-icon");
      owned.delete(avatar);
    }
    for (const [avatar, url] of targets) {
      let image = owned.get(avatar);
      if (!image) {
        image = document.createElement("img");
        image.setAttribute("data-power-icon-image", "");
        image.alt = "";
        image.setAttribute("aria-hidden", "true");
        owned.set(avatar, image);
      }
      if (image.getAttribute("src") !== url) {
        const pending = remote.has(url);
        image.hidden = pending;
        image.referrerPolicy = "no-referrer";
        avatar.toggleAttribute("data-power-cluster-icon", !pending);
        image.onload = () => {
          if (stopped || owned.get(avatar) !== image || image.getAttribute("src") !== url) return;
          image.hidden = false;
          avatar.setAttribute("data-power-cluster-icon", "");
        };
        image.onerror = () => {
          if (stopped || owned.get(avatar) !== image || image.getAttribute("src") !== url) return;
          image.hidden = true;
          avatar.removeAttribute("data-power-cluster-icon");
        };
        image.src = url;
      }
      if (image.parentElement !== avatar) avatar.append(image);
    }
  };
  const stop = reaction(
    () => JSON.stringify([store.icons, links().map((link) => [link.getId(), link.spec.url, link.spec.icon?.src])]),
    update,
  );
  const observer = new MutationObserver(update);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["id", "data-testid"],
  });
  update();
  return () => {
    stopped = true;
    stop();
    observer.disconnect();
    for (const [avatar, image] of owned) {
      image.remove();
      avatar.removeAttribute("data-power-cluster-icon");
    }
    owned.clear();
    for (const avatar of webLinkAvatars) avatar.removeAttribute("data-power-web-link-avatar");
    webLinkAvatars.clear();
    style.remove();
  };
}
