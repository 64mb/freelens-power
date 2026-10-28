export function startHostLayoutStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.freelensPower = "host-layout";
  style.textContent = `
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
    :root .Dialog.modal > .box {
      background: var(--contentColor);
      color: var(--textColorPrimary);
      border: 1px solid var(--borderColor);
      border-radius: 8px;
    }
    :root .Dialog.modal > .box > .Wizard > .header {
      color: var(--textColorPrimary);
      border-top-left-radius: 7px;
      border-top-right-radius: 7px;
    }
    :root .Dialog.modal > .box > .Wizard > .header h5 {
      color: inherit;
    }
    :root .Dialog.modal > .box > .Wizard .WizardStep,
    :root .Dialog.modal > .box > .Wizard .WizardStep > .buttons {
      border-bottom-left-radius: 7px;
      border-bottom-right-radius: 7px;
    }
    :root .ConfirmDialog.modal .confirm-buttons,
    :root .Dialog.modal[class*="view-module__dialog--"] > .box > [class*="view-module__dialogButtons--"] {
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
