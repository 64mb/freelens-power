export function startPowerButtonStyles(customizeResources = true): () => void {
  const style = document.createElement("style");
  style.dataset.freelensPower = "button-styles";
  const scope =
    ":is(.freelens-power-preferences, .freelens-power-dashboard, .power-dashboard-dialog, .power-ai-panel, .power-ai-overview-actions)";
  const controls = `:root ${scope} :is(button, .Button), :root .power-ai-launcher, :root .power-dashboard-card-header a, :root .freelens-power-settings-icon`;
  const hover = `:root ${scope} :is(button, .Button):not(:disabled):not(.disabled):hover, :root .power-dashboard-card-header a:hover, :root .freelens-power-settings-icon:hover`;
  const floating = customizeResources
    ? ":root :is(.AddRemoveButtons .Button:is(.remove-button, .add-button), .power-node-bulk-floating .Button.power-node-bulk-fab, .power-catalog-disconnect-button, .CatalogAddButton .MuiFab-root:not(.Mui-disabled))"
    : ":root :is(.power-node-bulk-floating .Button.power-node-bulk-fab, .power-catalog-disconnect-button, .CatalogAddButton .MuiFab-root:not(.Mui-disabled))";
  style.textContent = `
    ${controls} { transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
    ${hover} { background-color: color-mix(in srgb, var(--contentColor) 88%, var(--textColorPrimary) 12%); color: var(--textColorAccent); border-color: var(--borderColor); }
    :root ${scope} .Button.primary:not(.disabled):hover { background-color: color-mix(in srgb, var(--primary) 88%, white 12%); }
    :root .power-dashboard-card-header a, :root .freelens-power-settings-icon { border-radius: 6px; }
    ${customizeResources ? ":root .AddRemoveButtons:has(> .Button:is(.remove-button, .add-button)), " : ""}:root .power-node-bulk-floating { margin-right: 16px; }
    ${floating} {
      box-sizing: border-box;
      width: 38px;
      height: 38px;
      min-width: 38px;
      min-height: 38px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid color-mix(in srgb, var(--borderColor) 75%, var(--textColorSecondary) 25%);
      border-radius: 6px;
      background: var(--contentColor);
      color: var(--textColorSecondary) !important;
      box-shadow: none;
      transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease;
    }
    ${floating} :is(.Icon, .MuiSvgIcon-root) { --size: 18px; width: 18px; height: 18px; font-size: 18px; }
    ${floating}:not(.disabled):not(:disabled):hover {
      border-color: var(--textColorAccent);
      color: var(--textColorAccent) !important;
      background: color-mix(in srgb, var(--contentColor) 92%, var(--primary) 8%);
    }
    ${floating}:is(.power-node-bulk-fab, .MuiSpeedDial-fab)[aria-expanded=true]:not(.disabled):not(:disabled) { border-color: var(--primary); }
    ${floating}:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { ${floating} { transition: none; } }
    @media (prefers-reduced-motion: reduce) { ${controls} { transition: none; } }
  `;
  document.head.append(style);
  return () => style.remove();
}
