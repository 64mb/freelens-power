import { Common, Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { CLUSTER_ICONS_CHANNEL, type ClusterIconEntry } from "../common/cluster-icon-ipc";
import { ClusterIconsStore } from "../common/store/cluster-icons-store";
import { IconEditor } from "./cluster-icons";
import { ipcRenderer } from "./ipc";
import { renderIntoContainer, unmountContainer } from "./react-roots";

export function startClusterIconSettingsMenu(): () => void {
  const prefix = "menu-actions-for-cluster-icon-settings-for-";
  const store = ClusterIconsStore.getInstanceOrCreate<ClusterIconsStore>();
  const clears = new Map<Element, { native: HTMLElement; action: HTMLLIElement }>();
  const owned = new Map<Element, HTMLLIElement>();
  const style = document.createElement("style");
  style.textContent = `[data-testid^="${prefix}"] > .MenuItem[hidden] { display: none !important; }`;
  document.head.append(style);
  const modal = document.createElement("div");
  document.body.append(modal);
  let stopped = false;
  let request = 0;
  const open = async (id: string) => {
    if (stopped) return;
    const current = ++request;
    try {
      const entries: ClusterIconEntry[] = await ipcRenderer.invoke(CLUSTER_ICONS_CHANNEL, { operation: "list" });
      if (stopped || current !== request) return;
      const entry = entries.find((item) => item.id === id);
      if (!entry) return;
      renderIntoContainer(
        <IconEditor
          key={id}
          entry={entry}
          onClose={() => unmountContainer(modal)}
          onSaved={() => unmountContainer(modal)}
        />,
        modal,
      );
    } catch {
      if (!stopped && current === request)
        Renderer.Component.Notifications.error("Unable to open the cluster icon editor. Try again.");
    }
  };
  const addMenu = (entity: Common.Catalog.CatalogEntity, context: Common.Catalog.CatalogEntityContextMenuContext) => {
    if (!Renderer.Catalog.getClusterById(entity.getId())) return;
    context.menuItems.push({ title: "Edit icon", icon: "palette", onClick: () => void open(entity.getId()) });
  };
  let category: Common.Catalog.CatalogCategory | undefined;
  const stopCategory = reaction(
    () => Renderer.Catalog.catalogCategories.getForGroupKind("entity.k8slens.dev", "KubernetesCluster"),
    (next) => {
      category?.off("contextMenuOpen", addMenu);
      category = next;
      category?.on("contextMenuOpen", addMenu);
    },
    { fireImmediately: true },
  );
  const remove = (menu: Element, button: HTMLLIElement) => {
    unmountContainer(button);
    button.remove();
    owned.delete(menu);
  };
  const restoreClear = (menu: Element, entry: { native: HTMLElement; action: HTMLLIElement }) => {
    entry.native.hidden = false;
    unmountContainer(entry.action);
    entry.action.remove();
    clears.delete(menu);
  };
  const update = () => {
    for (const [menu, entry] of clears) {
      const id = (menu as HTMLElement).dataset.testid?.slice(prefix.length);
      if (!id || !menu.isConnected || !menu.contains(entry.native) || !Object.hasOwn(store.icons, id))
        restoreClear(menu, entry);
    }
    for (const [menu, button] of owned) if (!menu.isConnected) remove(menu, button);
    for (const menu of document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)) {
      const id = menu.dataset.testid?.slice(prefix.length);
      if (!id || !Renderer.Catalog.getClusterById(id)) continue;
      if (Object.hasOwn(store.icons, id) && !clears.has(menu)) {
        const native = Array.from(menu.querySelectorAll<HTMLElement>(":scope > .MenuItem:not([hidden])")).find(
          (item) =>
            Array.from(item.childNodes)
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.textContent)
              .join("")
              .trim() === "Clear",
        );
        if (native) {
          const action = document.createElement("li");
          action.className = "MenuItem";
          action.tabIndex = 0;
          action.setAttribute("role", "menuitem");
          action.setAttribute("aria-label", "Clear");
          action.onclick = () => {
            if (stopped) return;
            document.querySelector<HTMLElement>(`[data-testid="icon-for-${prefix}${CSS.escape(id)}"]`)?.click();
            void ipcRenderer.invoke(CLUSTER_ICONS_CHANNEL, { operation: "clear", id }).catch(() => {
              if (!stopped) Renderer.Component.Notifications.error("Unable to clear the cluster icon. Try again.");
            });
          };
          native.hidden = true;
          native.after(action);
          clears.set(menu, { native, action });
          renderIntoContainer(
            <>
              <Renderer.Component.Icon material="clear" size={18} /> Clear
            </>,
            action,
          );
        }
      }
      if (owned.has(menu)) continue;
      const button = document.createElement("li");
      button.tabIndex = 0;
      button.setAttribute("role", "menuitem");
      button.className = "MenuItem";
      button.setAttribute("aria-label", "Edit icon");
      button.onclick = () => {
        if (stopped) return;
        document.querySelector<HTMLElement>(`[data-testid="icon-for-${prefix}${CSS.escape(id)}"]`)?.click();
        void open(id);
      };
      menu.append(button);
      owned.set(menu, button);
      renderIntoContainer(
        <>
          <Renderer.Component.Icon material="palette" size={18} /> Edit icon
        </>,
        button,
      );
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const menu = Array.from(owned.keys()).find((item) => item.contains(target));
    if (!menu) return;
    const items = Array.from(menu.querySelectorAll<HTMLElement>(":scope > .MenuItem:not(.disabled):not([hidden])"));
    const index = items.findIndex((item) => item === target || item.contains(target));
    if (index < 0) return;
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (
      (event.key !== "Enter" && event.key !== " ") ||
      (items[index] !== owned.get(menu) && items[index] !== clears.get(menu)?.action)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (next) next.focus();
    else items[index].click();
  };
  window.addEventListener("keydown", onKeyDown, true);
  const observer = new MutationObserver(update);
  observer.observe(document.body, { childList: true, subtree: true });
  const stopIcons = reaction(() => Object.keys(store.icons), update);
  update();
  return () => {
    stopped = true;
    request++;
    observer.disconnect();
    stopCategory();
    stopIcons();
    for (const [menu, entry] of clears) restoreClear(menu, entry);
    category?.off("contextMenuOpen", addMenu);
    window.removeEventListener("keydown", onKeyDown, true);
    for (const [menu, button] of owned) remove(menu, button);
    unmountContainer(modal);
    modal.remove();
    style.remove();
  };
}
