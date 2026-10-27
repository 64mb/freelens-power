const extensionsPage = '.Extensions.SettingLayout[data-testid="extensions-page"]';
const extensionsContent = `${extensionsPage} > .contentRegion > .content > section`;
const installedExtensions = `${extensionsContent} > [data-testid="extensions-table"]`;

export function startHostExtensionsStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.freelensPower = "host-extensions";
  // direct section children are the native install form and installed extensions list
  style.textContent = `
    ${extensionsPage} > .contentRegion > .content { min-width: 0; max-width: 900px; }
    ${extensionsContent} { gap: 20px; min-width: 0; }
    ${extensionsContent} > h1 {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 0;
      font-size: 22px;
      line-height: 1.4;
    }
    ${extensionsContent} > h1::before {
      content: "extension" / "";
      font-family: "Material Icons";
      font-size: 24px;
      font-weight: 400;
      font-style: normal;
      line-height: 1;
      letter-spacing: normal;
      text-transform: none;
      white-space: nowrap;
      direction: ltr;
      font-feature-settings: "liga";
      -webkit-font-smoothing: antialiased;
      color: var(--textColorSecondary);
    }
    ${extensionsContent} > h1 + div {
      padding: 0;
      margin: -12px 0 4px;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--textColorSecondary);
      line-height: 1.5;
    }
    ${extensionsContent} > h1 + div > p { margin: 0; }
    ${extensionsContent} > section,
    ${extensionsContent} > div:last-child:not(:empty) {
      min-width: 0;
      padding: 24px;
      border: 1px solid var(--borderFaintColor);
      border-radius: 12px;
      background: var(--contentColor);
    }
    ${extensionsContent} > div:empty { display: none; }
    ${extensionsContent} > section > .SubTitle {
      margin-bottom: 16px;
      color: var(--textColorAccent);
      font-weight: 600;
      line-height: 1.5;
    }
    ${extensionsContent} > section:not([data-testid="extensions-table"]) > .SubTitle + div {
      grid-template-columns: minmax(0, 1fr) 110px;
      gap: 12px;
    }
    ${extensionsContent} > section:not([data-testid="extensions-table"]) > .SubTitle + div > div {
      min-width: 0;
    }
    ${extensionsContent} > section > small {
      margin-top: 12px;
      color: var(--textColorSecondary);
      opacity: 1;
      font-size: 12px;
      line-height: 1.5;
    }
    ${installedExtensions} > div:first-child {
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 20px;
    }
    ${installedExtensions} > div:first-child > div:first-child { margin-right: 0; }
    ${installedExtensions} h2 { font-size: 16px; line-height: 1.4; }
    ${installedExtensions} > .table { overflow-x: auto; }
    ${installedExtensions} .td.extension { overflow-wrap: anywhere; }
    @media (max-width: 760px) {
      ${extensionsPage} > .contentRegion > .content { padding: 60px 20px 0; }
      ${extensionsContent} > section,
      ${extensionsContent} > div:last-child:not(:empty) { padding: 18px; }
      ${extensionsContent} > section:not([data-testid="extensions-table"]) > .SubTitle + div {
        grid-template-columns: minmax(0, 1fr);
      }
      ${installedExtensions} > div:first-child > div:last-child {
        flex: 1 1 200px;
        min-width: 0;
      }
    }
  `;
  document.head.append(style);

  return () => style.remove();
}
