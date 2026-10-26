export function startHostLayoutStyles(): () => void {
  const style = document.createElement("style");
  style.dataset.freelensPower = "host-layout";
  style.textContent = `
    :root .ClusterManager { --status-bar-height: 0px; }
    :root .ClusterManager > [data-testid="status-bar"] { display: none; }
  `;
  document.head.append(style);
  return () => style.remove();
}
