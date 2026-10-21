export function startPowerButtonStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.freelensPower = "button-styles";
  const scope =
    ":is(.freelens-power-preferences, .freelens-power-dashboard, .power-dashboard-dialog, .power-ai-panel, .power-ai-overview-actions)";
  const controls = `:root ${scope} :is(button, .Button), :root .power-ai-launcher, :root .power-dashboard-card-header a, :root .freelens-power-settings-icon`;
  const hover = `:root ${scope} :is(button, .Button):not(:disabled):not(.disabled):hover, :root .power-ai-launcher:hover, :root .power-dashboard-card-header a:hover, :root .freelens-power-settings-icon:hover`;
  style.textContent = `
    ${controls} { transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
    ${hover} { background-color: color-mix(in srgb, var(--contentColor) 88%, var(--textColorPrimary) 12%); color: var(--textColorAccent); border-color: var(--borderColor); }
    :root ${scope} .Button.primary:not(.disabled):hover { background-color: color-mix(in srgb, var(--primary) 88%, white 12%); }
    :root .power-dashboard-card-header a, :root .freelens-power-settings-icon { border-radius: 6px; }
    @media (prefers-reduced-motion: reduce) { ${controls} { transition: none; } }
  `;
  document.head.append(style);
  return () => style.remove();
}
