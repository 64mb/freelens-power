export function startPowerButtonStyles(customizePods = true): () => void {
  const style = document.createElement("style");
  style.dataset.freelensPower = "button-styles";
  const scope =
    ":is(.freelens-power-preferences, .freelens-power-dashboard, .power-dashboard-dialog, .power-ai-panel, .power-ai-overview-actions)";
  const controls = `:root ${scope} :is(button, .Button), :root .power-ai-launcher, :root .power-dashboard-card-header a, :root .freelens-power-settings-icon`;
  const hover = `:root ${scope} :is(button, .Button):not(:disabled):not(.disabled):hover, :root .power-ai-launcher:hover, :root .power-dashboard-card-header a:hover, :root .freelens-power-settings-icon:hover`;
  const remove = `:root .AddRemoveButtons .Button.remove-button${customizePods ? "" : ":not(.Pods .remove-button)"}`;
  style.textContent = `
    ${controls} { transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
    ${hover} { background-color: color-mix(in srgb, var(--contentColor) 88%, var(--textColorPrimary) 12%); color: var(--textColorAccent); border-color: var(--borderColor); }
    :root ${scope} .Button.primary:not(.disabled):hover { background-color: color-mix(in srgb, var(--primary) 88%, white 12%); }
    :root .power-dashboard-card-header a, :root .freelens-power-settings-icon { border-radius: 6px; }
    ${remove} {
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
      color: var(--textColorSecondary);
      box-shadow: none;
      transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease;
    }
    ${remove} .Icon { --size: 18px; width: 18px; height: 18px; font-size: 18px; }
    ${remove}:not(.disabled):not(:disabled):hover {
      border-color: var(--textColorAccent);
      color: var(--textColorAccent);
      background: color-mix(in srgb, var(--contentColor) 92%, var(--primary) 8%);
    }
    ${remove}:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { ${remove} { transition: none; } }
    @media (prefers-reduced-motion: reduce) { ${controls} { transition: none; } }
  `;
  document.head.append(style);
  return () => style.remove();
}
