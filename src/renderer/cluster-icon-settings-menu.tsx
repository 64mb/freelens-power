import { Renderer } from "@freelensapp/extensions";
import { CLUSTER_ICONS_CHANNEL, type ClusterIconEntry } from "../common/cluster-icon-ipc";
import { IconEditor } from "./cluster-icons";
import { ipcRenderer } from "./ipc";
import { renderIntoContainer, unmountContainer } from "./react-roots";

export function startClusterIconSettingsMenu(): () => void {
  const prefix = "menu-actions-for-cluster-icon-settings-for-";
  const owned = new Map<Element, HTMLLIElement>();
  const modal = document.createElement("div");
  document.body.append(modal);
  let stopped = false;
  let request = 0;
  const open = async (id: string) => {
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
  const remove = (menu: Element, button: HTMLLIElement) => {
    unmountContainer(button);
    button.remove();
    owned.delete(menu);
  };
  const update = () => {
    for (const [menu, button] of owned) if (!menu.isConnected) remove(menu, button);
    for (const menu of document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)) {
      if (owned.has(menu)) continue;
      const id = menu.dataset.testid?.slice(prefix.length);
      if (!id || !Renderer.Catalog.getClusterById(id)) continue;
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
    const items = Array.from(menu.querySelectorAll<HTMLElement>(":scope > .MenuItem:not(.disabled)"));
    const index = items.findIndex((item) => item === target || item.contains(target));
    if (index < 0) return;
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if ((event.key !== "Enter" && event.key !== " ") || items[index] !== owned.get(menu)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (next) next.focus();
    else items[index].click();
  };
  window.addEventListener("keydown", onKeyDown, true);
  const observer = new MutationObserver(update);
  observer.observe(document.body, { childList: true, subtree: true });
  update();
  return () => {
    stopped = true;
    request++;
    observer.disconnect();
    window.removeEventListener("keydown", onKeyDown, true);
    for (const [menu, button] of owned) remove(menu, button);
    unmountContainer(modal);
    modal.remove();
  };
}
