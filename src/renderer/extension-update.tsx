import { Renderer } from "@freelensapp/extensions";

const packageName = "@64mb/freelens-power";
const installTarget = `${packageName}@latest`;
const pageSelector = '[data-testid="extensions-page"]';

function installControls() {
  const page = document.querySelector(pageSelector);
  const input = page?.querySelector<HTMLInputElement>('input[placeholder="Name or file path or URL"]');
  const section = input?.closest("section");
  const button = [...(section?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (element) => element.textContent?.trim() === "Install",
  );
  return { input, button };
}

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function startExtensionUpdate(): () => void {
  if (process.isMainFrame === false) return () => {};
  let stopped = false;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draft: { input: HTMLInputElement; previous: string } | undefined;
  let mounted:
    | {
        menu: HTMLElement;
        container: HTMLElement;
        trigger: HTMLElement;
        disabled: boolean;
        keyboard: (event: KeyboardEvent) => void;
        click: (event: MouseEvent) => void;
      }
    | undefined;
  const clear = () => {
    if (!mounted) return;
    mounted.menu.removeEventListener("keydown", mounted.keyboard, true);
    mounted.container.removeEventListener("click", mounted.click);
    mounted.container.remove();
    mounted = undefined;
  };
  const update = () => {
    if (stopped || timer) return;
    const { input, button } = installControls();
    if (!input || !button || input.disabled || button.disabled) return;
    const previous = input.value;
    draft = { input, previous };
    setInput(input, installTarget);
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      const current = installControls();
      if (
        current.input === input &&
        current.button === button &&
        input.value === installTarget &&
        !input.disabled &&
        !button.disabled
      ) {
        try {
          button.click();
          if (previous && previous !== installTarget && input.isConnected && input.value === installTarget)
            setInput(input, previous);
          draft = undefined;
          return;
        } catch {}
      }
      if (input.isConnected && input.value === installTarget) setInput(input, previous);
      draft = undefined;
      Renderer.Component.Notifications.error(
        "Could not start the native extension installer. Open Extensions and retry",
      );
    }, 0);
  };
  const sync = () => {
    scheduled = false;
    if (stopped) return;
    const table = document.querySelector(`${pageSelector} [data-testid="extensions-table"]`);
    const row = [...(table?.querySelectorAll<HTMLElement>(".tr") ?? [])].find(
      (element) =>
        element.querySelector(".td.extension > div > div > div:first-child")?.textContent?.trim() === packageName,
    );
    const trigger = row?.querySelector<HTMLElement>('[id^="menu-actions-for-installed-extensions-for-"]:not(ul)');
    const menu =
      trigger &&
      [...document.querySelectorAll<HTMLElement>("ul.MenuActions")].find((element) => element.id === trigger.id);
    if (!trigger || !menu || !table?.contains(trigger)) {
      clear();
      return;
    }
    const { input, button } = installControls();
    const disabled = !input || !button || input.disabled || button.disabled;
    if (
      mounted?.menu === menu &&
      mounted.trigger === trigger &&
      mounted.disabled === disabled &&
      mounted.container.isConnected
    )
      return;
    clear();
    const template = menu.querySelector<HTMLElement>(":scope > li.MenuItem");
    const nativeIcon = template?.querySelector<HTMLElement>(".Icon.material");
    if (!template || !nativeIcon?.querySelector("[data-icon-name]")) return;
    // cloned DOM retains native styles without copying React handlers or requiring host DI context
    const container = template.cloneNode(false) as HTMLElement;
    container.removeAttribute("id");
    container.dataset.powerExtensionUpdate = "";
    container.classList.toggle("disabled", disabled);
    container.setAttribute("aria-label", "Update Freelens Power");
    container.setAttribute("aria-disabled", String(disabled));
    container.setAttribute("role", "menuitem");
    container.tabIndex = disabled ? -1 : 0;
    const icon = nativeIcon.cloneNode(true) as HTMLElement;
    const glyph = icon.querySelector<HTMLElement>("[data-icon-name]")!;
    glyph.dataset.iconName = "system_update_alt";
    glyph.textContent = "system_update_alt";
    const label = document.createElement("span");
    label.className = "title";
    label.textContent = "Update";
    container.append(icon, label);
    const click = (event: MouseEvent) => {
      event.stopPropagation();
      if (disabled) return;
      update();
      trigger.click();
    };
    container.addEventListener("click", click);
    menu.prepend(container);
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        const items = [...menu.querySelectorAll<HTMLElement>(".MenuItem[tabindex='0']:not(.disabled)")];
        const index = items.findIndex((item) => item === target);
        if (index < 0) return;
        event.preventDefault();
        event.stopPropagation();
        items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
      } else if (container.contains(target) && ["Enter", " "].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) target.closest<HTMLElement>(".MenuItem")?.click();
      }
    };
    menu.addEventListener("keydown", keyboard, true);
    mounted = { menu, trigger, container, disabled, keyboard, click };
  };
  const observer = new MutationObserver(() => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(sync);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  sync();
  return () => {
    stopped = true;
    observer.disconnect();
    if (timer) clearTimeout(timer);
    if (draft?.input.isConnected && draft.input.value === installTarget) setInput(draft.input, draft.previous);
    draft = undefined;
    clear();
  };
}
