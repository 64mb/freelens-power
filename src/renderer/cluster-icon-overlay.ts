import { reaction } from "mobx";
import { clusterIconDataUrl } from "../common/cluster-icons";
import { ClusterIconsStore } from "../common/store/cluster-icons-store";

export function startClusterIconOverlay(): () => void {
  const store = ClusterIconsStore.getInstanceOrCreate<ClusterIconsStore>();
  const owned = new Map<HTMLElement, HTMLImageElement>();
  const style = document.createElement("style");
  style.textContent = `[data-power-cluster-icon]{position:relative!important;color:transparent!important}[data-power-cluster-icon]>:not([data-power-icon-image]){visibility:hidden!important}[data-power-icon-image]{position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;pointer-events:none;object-fit:cover}`;
  document.head.append(style);
  let stopped = false;
  const update = () => {
    if (stopped) return;
    const urls = new Map(Object.entries(store.icons).map(([id, value]) => [id, clusterIconDataUrl(value.design)]));
    const targets = new Map<HTMLElement, string>();
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
    for (const menu of document.querySelectorAll<HTMLElement>('[data-testid^="menu-actions-for-catalog-for-"]')) {
      const id = menu.getAttribute("data-testid")?.slice("menu-actions-for-catalog-for-".length);
      const url = id ? urls.get(id) : undefined;
      const avatar = menu.closest(".TableRow")?.querySelector<HTMLElement>('[class*="Avatar"]');
      if (url && avatar) targets.set(avatar, url);
    }
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
        avatar.setAttribute("data-power-cluster-icon", "");
      }
      if (image.getAttribute("src") !== url) image.src = url;
      if (image.parentElement !== avatar) avatar.append(image);
    }
  };
  const stop = reaction(() => JSON.stringify(store.icons), update);
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
    style.remove();
  };
}
