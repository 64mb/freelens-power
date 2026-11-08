import { Renderer } from "@freelensapp/extensions";
import { renderIntoContainer, unmountContainer } from "./react-roots";

const icons: Record<string, { material: string } | { svg: string }> = {
  "View Details": { material: "info_outline" },
  Settings: { material: "settings" },
  "Upload Icon": { material: "file_upload" },
  Clear: { material: "clear" },
  "Open kubeconfig": { material: "edit" },
  Connect: { material: "link" },
  Disconnect: { material: "link_off" },
  Remove: { material: "delete" },
  Delete: { material: "delete" },
  "Add to Hotbar": { material: "push_pin" },
  "Remove from Hotbar": { svg: "push_off" },
};

export function startCatalogMenuIcons(): () => void {
  const owned = new Map<Element, { host: HTMLSpanElement; title: string }>();
  const style = document.createElement("style");
  style.textContent =
    "[data-power-catalog-menu-icon]{display:inline-flex;align-items:center;justify-content:center;flex:0 0 18px;width:18px;height:18px;margin-right:8px;pointer-events:none}[data-power-catalog-menu-icon] .Icon{color:inherit;margin:0!important}";
  document.head.append(style);
  const remove = (item: Element) => {
    const entry = owned.get(item);
    if (!entry) return;
    unmountContainer(entry.host);
    entry.host.remove();
    owned.delete(item);
  };
  const update = () => {
    const targets = new Set<Element>();
    const titleOf = (item: Element) =>
      Array.from(item.childNodes)
        .filter((node) => !(node instanceof HTMLElement && node.hasAttribute("data-power-catalog-menu-icon")))
        .map((node) => node.textContent)
        .join("")
        .trim();
    const hotbarMenus = Array.from(document.querySelectorAll(".Menu.portal")).filter((menu) => {
      const first = menu.querySelector(":scope > .MenuItem");
      return first && titleOf(first) === "Remove from Hotbar";
    });
    const items = new Set([
      ...document.querySelectorAll('[data-testid^="menu-actions-for-catalog-for-"] .MenuItem'),
      ...document.querySelectorAll('[data-testid^="menu-actions-for-cluster-icon-settings-for-"] .MenuItem'),
      ...hotbarMenus.flatMap((menu) => [...menu.querySelectorAll(":scope > .MenuItem")]),
    ]);
    for (const item of items) {
      const title = titleOf(item);
      const icon = icons[title];
      const nativeIcon = Array.from(item.querySelectorAll(".Icon")).some(
        (node) => !node.closest("[data-power-catalog-menu-icon]"),
      );
      if (!icon || nativeIcon) continue;
      targets.add(item);
      let entry = owned.get(item);
      if (!entry) {
        const host = document.createElement("span");
        host.setAttribute("data-power-catalog-menu-icon", "");
        host.setAttribute("aria-hidden", "true");
        item.prepend(host);
        entry = { host, title: "" };
        owned.set(item, entry);
      }
      if (entry.host.parentElement !== item) item.prepend(entry.host);
      if (entry.title === title) continue;
      entry.title = title;
      renderIntoContainer(<Renderer.Component.Icon {...icon} size={18} />, entry.host);
    }
    for (const item of owned.keys()) if (!targets.has(item)) remove(item);
  };
  const observer = new MutationObserver(update);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-testid"],
  });
  update();
  return () => {
    observer.disconnect();
    for (const item of owned.keys()) remove(item);
    style.remove();
  };
}
