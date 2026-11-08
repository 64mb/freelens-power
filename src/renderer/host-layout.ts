export function startHostLayoutStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.freelensPower = "host-layout";
  style.textContent = `
    :root .SettingLayout [class*="close-button-module__closeButton--"] {
      box-sizing: border-box;
      border: 1px solid color-mix(in srgb, var(--borderColor) 75%, var(--textColorSecondary) 25%);
      border-radius: 6px;
      background: var(--contentColor);
    }
    :root .SettingLayout [class*="close-button-module__closeButton--"] > .Icon {
      --size: 18px;
      width: 18px;
      height: 18px;
      font-size: 18px;
      color: var(--textColorSecondary);
      opacity: 1;
    }
    :root .SettingLayout [class*="close-button-module__closeButton--"]:hover {
      border-color: var(--textColorAccent);
      background: color-mix(in srgb, var(--contentColor) 92%, var(--primary) 8%);
    }
    :root .SettingLayout [class*="close-button-module__closeButton--"]:hover > .Icon { color: var(--textColorAccent); }

    :root [data-testid="add-cluster-page"] > .contentRegion > .content {
      width: min(1320px, calc(100vw - 96px));
      max-width: none;
      min-width: 0;
      padding: 40px 40px 0;
      box-sizing: border-box;
    }
    :root [data-testid="add-cluster-page"] [class*="add-cluster-module__editor--"] {
      --editor-height: clamp(240px, calc(100vh - 240px), 900px);
    }

    :root .CatalogAddButton { right: 40px; bottom: 30px; }
    :root .catalogSpeedDialPopper .MuiTooltip-tooltip {
      background-color: var(--contentColor);
      color: var(--textColorPrimary);
      border: 1px solid var(--borderColor);
    }
    :root .catalogSpeedDialPopper .MuiTooltip-arrow { color: var(--contentColor); }

    :root .HotbarMenu .HotbarItems.flex.flex-col > .HotbarCell:not(:last-child) {
      margin-bottom: 4px;
    }
    :root .Notifications .notification {
      width: min(520px, calc(100vw - 32px));
      min-width: 0;
      max-width: none;
      box-sizing: border-box;
    }
    :root .Notifications .notification > .message { min-width: 0; }
    :root .Select__menu-list .Select__option { margin-block: 0 2px; }
    :root .Select__menu-list .Select__option:last-child { margin-bottom: 0; }
    :root .TableCell [class*="badge-module__badge--"][class*="badge-module__flat--"][class*="badge-module__interactive--"]:hover {
      background-color: transparent;
    }
    :root .Dialog.modal {
      --dialogBackground: var(--contentColor);
      --dialogTextColor: var(--textColorPrimary);
      --dialogHeaderBackground: var(--mainBackground);
      --dialogFooterBackground: var(--mainBackground);
    }
    :root .Dialog.modal > .dialog-content {
      background: var(--contentColor);
      color: var(--textColorPrimary);
      border: 1px solid var(--borderColor);
      border-radius: 8px;
    }
    :root .Dialog.modal > .dialog-content > .Wizard > .header {
      color: var(--textColorPrimary);
      border-top-left-radius: 7px;
      border-top-right-radius: 7px;
    }
    :root .Dialog.modal > .dialog-content > .Wizard > .header h5 {
      color: inherit;
    }
    :root .Dialog.modal > .dialog-content > .Wizard .WizardStep,
    :root .Dialog.modal > .dialog-content > .Wizard .WizardStep > .buttons {
      border-bottom-left-radius: 7px;
      border-bottom-right-radius: 7px;
    }
    :root .ConfirmDialog.modal .confirm-buttons,
    :root .Dialog.modal[class*="view-module__dialog--"] > .dialog-content > [class*="view-module__dialogButtons--"] {
      background: var(--dialogFooterBackground);
      color: var(--textColorPrimary);
      border-bottom-left-radius: 7px;
      border-bottom-right-radius: 7px;
    }
    :root .ClusterManager { --status-bar-height: 0px; }
    :root .ClusterManager > [data-testid="status-bar"] { display: none; }
  `;
  document.head.append(style);
  return () => style.remove();
}
