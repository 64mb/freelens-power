import { reaction } from "mobx";
import { NodeShellPreferencesStore } from "../common/store/node-shell-preferences-store";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";

const replacementSelector = ".power-secure-node-shell-menu";
const marker = "data-power-default-node-shell";

export function startNodeShellEntrypoints(): () => void {
  const shell = NodeShellPreferencesStore.getInstanceOrCreate<NodeShellPreferencesStore>();
  const power = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  const style = document.createElement("style");
  style.dataset.freelensPower = "node-shell-entrypoints";
  style.textContent = `[${marker}] { display: none !important; }`;
  const hidden = new Map<HTMLElement, HTMLElement>();
  let active = false;
  let stopped = false;
  let scheduled = false;
  const isNativeShell = (item: HTMLElement) =>
    item.matches(".MenuItem") &&
    !item.matches(replacementSelector) &&
    item.querySelector(":scope > .title")?.textContent?.trim() === "Shell" &&
    Boolean(item.querySelector(":scope > .Icon.svg"));
  const restore = (item: HTMLElement) => {
    item.removeAttribute(marker);
    hidden.delete(item);
  };
  const sync = () => {
    scheduled = false;
    if (stopped) return;
    for (const [item, replacement] of hidden) {
      if (
        !active ||
        !item.isConnected ||
        !replacement.isConnected ||
        !replacement.matches(replacementSelector) ||
        replacement.parentElement !== item.parentElement ||
        !isNativeShell(item)
      )
        restore(item);
    }
    if (!active) return;
    for (const replacement of document.querySelectorAll<HTMLElement>(replacementSelector)) {
      if (!replacement.parentElement) continue;
      for (const item of replacement.parentElement.children) {
        if (!(item instanceof HTMLElement) || !isNativeShell(item)) continue;
        hidden.set(item, replacement);
        item.setAttribute(marker, "");
      }
    }
  };
  const observer = new MutationObserver(() => {
    if (stopped || !active || scheduled) return;
    scheduled = true;
    queueMicrotask(sync);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  const stop = reaction(
    () => shell.replaceDefaultNodeShell && power.enabled,
    (enabled) => {
      active = enabled;
      if (enabled) document.head.append(style);
      else style.remove();
      sync();
    },
    { fireImmediately: true },
  );
  return () => {
    stopped = true;
    observer.disconnect();
    stop();
    for (const item of hidden.keys()) restore(item);
    style.remove();
  };
}
