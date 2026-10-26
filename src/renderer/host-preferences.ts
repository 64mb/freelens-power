const nativeTabs = {
  application: "settings",
  proxy: "swap_horiz",
  kubernetes: "cloud",
  editor: "code",
  terminal: "terminal",
};

// native [Preferences] exposes these page and tab attributes in its component hierarchy
const page = `.Preferences.SettingLayout > .contentRegion > .content > :is(${Object.keys(nativeTabs)
  .map((id) => `[data-preference-page-test="${id}-page"]`)
  .join(", ")})`;
const tab = `.Preferences.SettingLayout > .sidebarRegion [data-preference-tab-link-test]:is(${Object.keys(nativeTabs)
  .map((id) => `[data-preference-tab-link-test="${id}"]`)
  .join(", ")})`;

export function startHostPreferencesStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.freelensPower = "host-preferences";
  style.textContent = `
    ${tab} { gap: 10px; min-height: 36px; }
    ${tab}::before {
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

  return () => style.remove();
}
