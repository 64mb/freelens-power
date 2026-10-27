import { Renderer } from "@freelensapp/extensions";
import { EXTENSION_DISPLAY_NAME, EXTENSION_ID } from "../common/extension-info";

const extensionsHeader =
  '.Preferences.SettingLayout > .sidebarRegion [data-preference-tab-group-test="extensions-tab-group"] > .header';
const powerTabSelector = `.Preferences.SettingLayout > .sidebarRegion [data-preference-tab-group-test="extensions-tab-group"] :is([data-preference-tab-link-test="${EXTENSION_ID}"], [data-preference-tab-link-test="preference-item-for-extension-${EXTENSION_ID}-primary-tab"])`;
const powerTabStyle = powerTabSelector;

const nativeTabs = {
  app: "settings",
  proxy: "swap_horiz",
  kubernetes: "cloud",
  editor: "code",
  terminal: "terminal",
};

// native [Preferences] exposes these page and tab attributes in its component hierarchy
const page = `.Preferences.SettingLayout > .contentRegion > .content > :is(${Object.keys(nativeTabs)
  .map((id) => `[data-preference-page-test="${id === "app" ? "application" : id}-page"]`)
  .join(", ")})`;
const tab = `.Preferences.SettingLayout > .sidebarRegion [data-preference-tab-link-test]:is(${Object.keys(nativeTabs)
  .map((id) => `[data-preference-tab-link-test="${id}"]`)
  .join(", ")})`;

export function startHostPreferencesStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.freelensPower = "host-preferences";
  style.textContent = `
    .Preferences.SettingLayout > .sidebarRegion [data-preference-tab-group-test="extensions-tab-group"] > .header { gap: 8px; }
    .Preferences.SettingLayout > .sidebarRegion [data-preference-tab-group-test="extensions-tab-group"] > .header > .Icon { margin: 0; flex-shrink: 0; }
    ${extensionsHeader} { cursor: pointer; }
    ${extensionsHeader}:hover, ${extensionsHeader}:focus-visible { color: var(--primary); }
    ${extensionsHeader}:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 4px; }
    ${tab}, ${powerTabStyle} { gap: 10px; min-height: 36px; }
    ${tab}::before, ${powerTabStyle}::before {
      flex: 0 0 18px;
      width: 18px;
      font-family: "Material Icons";
      font-size: 18px;
      font-weight: 400;
      font-style: normal;
      line-height: 1;
      letter-spacing: normal;
      text-transform: none;
      white-space: nowrap;
      direction: ltr;
      font-feature-settings: "liga";
      -webkit-font-smoothing: antialiased;
    }
    ${powerTabStyle}::before { content: "battery_full" / ""; }
    ${Object.entries(nativeTabs)
      .map(
        ([id, icon]) =>
          `.Preferences.SettingLayout > .sidebarRegion [data-preference-tab-link-test="${id}"]::before { content: "${icon}" / ""; }`,
      )
      .join("\n")}
    ${page} { gap: 20px; }
    ${page} > [data-preference-page-title-test] { margin-bottom: 4px; }
    ${page} > [data-preference-item-test] {
      padding: 24px;
      border: 1px solid var(--borderFaintColor);
      border-radius: 12px;
      background: var(--contentColor);
      min-width: 0;
    }
    ${page} > div:empty:not([data-preference-item-test]) { display: none; }
    ${page} > [data-preference-item-test] > section > h2 {
      margin-bottom: 20px;
      font-size: 16px;
      line-height: 1.4;
    }
    ${page} [data-preference-item-test] .SubTitle {
      color: var(--textColorAccent);
      font-weight: 600;
      line-height: 1.4;
      margin-bottom: 12px;
    }
    ${page} [data-preference-item-test] .hint {
      color: var(--textColorSecondary);
      font-size: 12px;
      line-height: 1.5;
    }
    @media (max-width: 760px) {
      ${page} > [data-preference-item-test] { padding: 18px; }
    }
  `;
  document.head.append(style);

  let header: HTMLElement | null = null;
  let powerTab: HTMLElement | null = null;
  let restorePowerTab: (() => void) | undefined;
  const connectPowerTab = () => {
    if (powerTab?.isConnected) return;
    restorePowerTab?.();
    restorePowerTab = undefined;
    powerTab = null;
    const target = document.querySelector<HTMLElement>(powerTabSelector);
    if (!target) return;
    if (target.textContent?.trim() !== EXTENSION_DISPLAY_NAME) return;
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && text.textContent?.trim() !== EXTENSION_DISPLAY_NAME) text = walker.nextNode();
    if (!text) return;
    powerTab = target;
    const originalText = text.textContent ?? "";
    text.textContent = originalText.replace(/^(\s*)🔋 /u, "$1");
    restorePowerTab = () => {
      text.textContent = originalText;
    };
  };
  let restoreHeader: (() => void) | undefined;
  const connectHeader = () => {
    if (header?.isConnected) return;
    restoreHeader?.();
    restoreHeader = undefined;
    header = document.querySelector<HTMLElement>(extensionsHeader);
    if (!header) return;

    const target = header;
    const originalRole = target.getAttribute("role");
    const originalTabIndex = target.getAttribute("tabindex");
    const navigate = () => Renderer.Navigation.navigate("/extensions");
    const click = (event: MouseEvent) => {
      if (event.button === 0) navigate();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat) return;
      event.preventDefault();
      navigate();
    };
    target.setAttribute("role", "link");
    target.setAttribute("tabindex", "0");
    target.addEventListener("click", click);
    target.addEventListener("keydown", keydown);
    restoreHeader = () => {
      target.removeEventListener("click", click);
      target.removeEventListener("keydown", keydown);
      for (const [name, value] of [
        ["role", originalRole],
        ["tabindex", originalTabIndex],
      ] as const) {
        if (value === null) target.removeAttribute(name);
        else target.setAttribute(name, value);
      }
    };
  };
  const connect = () => {
    connectHeader();
    connectPowerTab();
  };
  connect();
  const observer = new MutationObserver(connect);
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    restoreHeader?.();
    restorePowerTab?.();
    style.remove();
  };
}
