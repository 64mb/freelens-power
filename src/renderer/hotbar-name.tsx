import { reaction } from "mobx";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { forwardHotbarShortcut, startHotbarFrameShortcuts } from "./hotbar-frame-shortcuts";
import { ipcRenderer } from "./ipc";
import { NativeTooltip } from "./native-tooltip";
import { renderIntoContainer, unmountContainer } from "./react-roots";

export function startHotbarName(): () => void {
  const preferences = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  const prefix = "hotbar-menu-badge-for-";
  let count = 0;
  let stopped = false;
  let refreshing = false;
  const seenSearches = new WeakSet<HTMLInputElement>();
  const numbers = new Map<HTMLElement, HTMLSpanElement>();
  const owned = new Map<Element, { host: HTMLDivElement; name: string }>();
  const style = document.createElement("style");
  style.textContent = `[data-power-hotbar-name]{position:relative;z-index:1;flex-shrink:0;width:100%;min-width:0;padding:6px;box-sizing:border-box;text-align:center;color:var(--settingsColor);font-size:10px;line-height:16px}[data-power-hotbar-name] span{display:block;padding:1px 4px;border:1px solid var(--borderColor);border-radius:4px;background:var(--secondaryBackground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;
  style.textContent +=
    "[data-power-hotbar-numbered]{position:relative}[data-power-hotbar-number]{position:absolute;left:100%;top:2px;transform:translateX(-50%);z-index:3;display:flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;box-sizing:border-box;border:1px solid var(--borderColor);border-radius:3px;background:var(--mainBackground);color:var(--textColorAccent);font:500 9px/1 system-ui;font-variant-numeric:tabular-nums;pointer-events:none}";
  document.head.append(style);
  const remove = (selector: Element) => {
    const entry = owned.get(selector);
    if (!entry) return;
    unmountContainer(entry.host);
    entry.host.remove();
    owned.delete(selector);
  };
  const update = () => {
    for (const input of document.querySelectorAll<HTMLInputElement>(
      '[data-testid^="catalog-list-for-"] > .header .SearchInput input',
    )) {
      if (seenSearches.has(input)) continue;
      seenSearches.add(input);
      if (
        (preferences.hotbarShortcuts !== false || preferences.hotbarItemShortcuts !== false) &&
        document.activeElement === input
      )
        input.blur();
    }
    const icons =
      preferences.hotbarItemShortcuts !== false
        ? Array.from(document.querySelectorAll<HTMLElement>('.HotbarMenu [id^="hotbarIcon-"]')).slice(0, 9)
        : [];
    for (const [icon, badge] of numbers) {
      if (icons.includes(icon)) continue;
      badge.parentElement?.removeAttribute("data-power-hotbar-numbered");
      badge.remove();
      icon.removeAttribute("data-power-hotbar-numbered");
      numbers.delete(icon);
    }
    icons.forEach((icon, index) => {
      let badge = numbers.get(icon);
      if (!badge) {
        badge = document.createElement("span");
        badge.setAttribute("data-power-hotbar-number", "");
        badge.setAttribute("aria-hidden", "true");
        numbers.set(icon, badge);
      }
      const label = String(index + 1);
      if (badge.textContent !== label) badge.textContent = label;
      const wrapper = icon.parentElement?.matches('[class*="HotbarIcon"]') ? icon.parentElement : icon;
      wrapper.setAttribute("data-power-hotbar-numbered", "");
      if (badge.parentElement !== wrapper) wrapper.append(badge);
      const marker = wrapper.querySelector<HTMLElement>(':scope > .Icon[class*="badge"]');
      const markerBounds = marker?.getBoundingClientRect();
      const left = markerBounds?.width
        ? `${markerBounds.left + markerBounds.width / 2 - wrapper.getBoundingClientRect().left}px`
        : "100%";
      if (badge.style.left !== left) badge.style.left = left;
    });
    const targets = new Set<Element>();
    for (const badge of count > 1
      ? document.querySelectorAll<HTMLElement>(`.HotbarMenu [data-testid^="${prefix}"]`)
      : []) {
      const selector = badge.closest('[class*="HotbarSelector"]');
      const name = badge.dataset.testid?.slice(prefix.length);
      if (!selector || !name) continue;
      targets.add(selector);
      let entry = owned.get(selector);
      if (!entry) {
        const host = document.createElement("div");
        host.setAttribute("data-power-hotbar-name", "");
        selector.before(host);
        entry = { host, name: "" };
        owned.set(selector, entry);
      }
      if (entry.host.nextElementSibling !== selector) selector.before(entry.host);
      if (entry.name === name) continue;
      entry.name = name;
      renderIntoContainer(
        <NativeTooltip title={name}>
          <span>{name}</span>
        </NativeTooltip>,
        entry.host,
      );
    }
    for (const selector of owned.keys()) {
      if (!targets.has(selector)) remove(selector);
    }
  };
  const refreshCount = async () => {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      const next: unknown = await ipcRenderer.invoke("freelens-power:hotbar-count");
      if (!stopped && typeof next === "number" && Number.isInteger(next) && next >= 0) {
        count = next;
        update();
      }
    } catch {
      // keep the last known count during a temporary service failure
    } finally {
      refreshing = false;
    }
  };
  const observer = new MutationObserver((records) => {
    update();
    if (
      records.some(
        (record) =>
          record.type === "attributes" &&
          record.target instanceof HTMLElement &&
          record.target.dataset.testid?.startsWith(prefix),
      )
    )
      void refreshCount();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-testid", "id", "class"],
  });
  void refreshCount();
  const keydown = (event: KeyboardEvent) => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const itemShortcut = !event.metaKey && !event.ctrlKey;
    if ((itemShortcut ? preferences.hotbarItemShortcuts : preferences.hotbarShortcuts) === false) return;
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.altKey ||
      event.shiftKey ||
      (!itemShortcut && (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey))
    )
      return;
    const digit = /^Digit([1-9])$/.exec(event.code);
    if (!digit) return;
    const editable =
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], .monaco-editor, .xterm, .cm-editor, .CodeMirror';
    if (event.composedPath().some((node) => node instanceof Element && node.closest(editable))) return;
    if (
      document.querySelector(
        '.Dialog.modal, [aria-modal="true"], .SettingLayout, [class*="command-container-module__CommandContainer--"]',
      )
    )
      return;
    if (itemShortcut && document.querySelector(".Menu.portal, .HotbarMenu .isDragging")) return;
    if (forwardHotbarShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = Number(digit[1]);
    if (itemShortcut) {
      const icon = document.querySelectorAll<HTMLElement>('.HotbarMenu [id^="hotbarIcon-"]')[target - 1];
      if (!icon || icon.matches('[aria-disabled="true"], [disabled], [class*="disabled"]')) return;
      event.preventDefault();
      event.stopPropagation();
      icon.click();
      return;
    }
    const badge = document.querySelector<HTMLElement>('.HotbarMenu [data-testid^="hotbar-menu-badge-for-"]');
    const current = Number(badge?.textContent?.trim());
    const selector = badge?.closest('[class*="HotbarSelector"]');
    const arrows = selector?.querySelectorAll<HTMLElement>(":scope > .Icon");
    if (
      !arrows ||
      arrows.length !== 2 ||
      !Number.isInteger(current) ||
      current < 1 ||
      current > count ||
      target > count
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const arrow = arrows[target > current ? 1 : 0];
    for (let step = 0; step < Math.abs(target - current); step++) arrow.click();
  };
  const stopFrameShortcuts = startHotbarFrameShortcuts((shortcut) => {
    document.dispatchEvent(new KeyboardEvent("keydown", { ...shortcut, bubbles: true, cancelable: true }));
  });
  document.addEventListener("keydown", keydown);
  const stopItemPreference = reaction(() => preferences.hotbarItemShortcuts, update, { fireImmediately: true });
  const timer = setInterval(() => void refreshCount(), 2000);
  return () => {
    stopped = true;
    document.removeEventListener("keydown", keydown);
    stopFrameShortcuts();
    clearInterval(timer);
    stopItemPreference();
    for (const [icon, badge] of numbers) {
      badge.parentElement?.removeAttribute("data-power-hotbar-numbered");
      badge.remove();
      icon.removeAttribute("data-power-hotbar-numbered");
    }
    numbers.clear();
    observer.disconnect();
    for (const selector of owned.keys()) remove(selector);
    style.remove();
  };
}
