import { Common, Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { NativeTooltip } from "./native-tooltip";
import { renderIntoContainer, unmountContainer } from "./react-roots";

const clusters = () =>
  Renderer.Catalog.catalogEntities.getItemsForApiKind<Common.Catalog.KubernetesCluster>(
    Common.Catalog.KubernetesCluster.apiVersion,
    Common.Catalog.KubernetesCluster.kind,
  );
const active = (entity: Common.Catalog.KubernetesCluster) =>
  entity.status.phase === "connected" || entity.status.phase === "connecting";

export function startCatalogDisconnect(): () => void {
  let stopped = false;
  let pending = false;
  let host: HTMLDivElement | undefined;
  let renderedDisabled: boolean | undefined;
  const style = document.createElement("style");
  style.textContent =
    ".power-catalog-disconnect{position:absolute;right:86px;bottom:30px;z-index:1}.power-catalog-disconnect button:disabled{opacity:.45;cursor:default}";
  document.head.append(style);
  const remove = () => {
    if (!host) return;
    unmountContainer(host);
    host.remove();
    host = undefined;
    renderedDisabled = undefined;
  };
  const request = () => {
    if (stopped || pending || !host?.isConnected) return;
    const snapshot = new Map(
      clusters()
        .filter(active)
        .map((entity) => [entity.getId(), entity]),
    );
    if (!snapshot.size) return;
    const confirmationHost = host;
    pending = true;
    update();
    let submitted = false;
    Renderer.Component.ConfirmDialog.open({
      message: `Disconnect ${snapshot.size} active cluster${snapshot.size === 1 ? "" : "s"}?`,
      labelOk: "Disconnect all",
      cancel: () => {
        if (submitted) return;
        submitted = true;
        pending = false;
        update();
      },
      ok: async () => {
        if (submitted || stopped) return;
        submitted = true;
        if (host !== confirmationHost || !host?.isConnected) {
          pending = false;
          update();
          return;
        }
        try {
          const targets = clusters().filter((entity) => snapshot.get(entity.getId()) === entity && active(entity));
          const results = await Promise.allSettled(
            targets.map((entity) =>
              Promise.resolve().then(() => {
                if (!stopped && active(entity) && clusters().includes(entity)) return entity.disconnect();
                return undefined;
              }),
            ),
          );
          if (!stopped && results.some((result) => result.status === "rejected"))
            Renderer.Component.Notifications.error(
              "Unable to disconnect some clusters. Check their connection status.",
            );
        } finally {
          pending = false;
          update();
        }
      },
    });
  };
  const update = () => {
    if (stopped) return;
    const list = document.querySelector('[data-testid="catalog-list-for-Clusters"]');
    let container = list?.parentElement;
    let plus: Element | null = null;
    while (container && container !== document.body) {
      plus = container.querySelector(".CatalogAddButton");
      if (plus) break;
      container = container.parentElement;
    }
    if (!plus?.parentElement || (!pending && !clusters().some(active))) {
      remove();
      return;
    }
    if (!host || host.parentElement !== plus.parentElement) {
      remove();
      host = document.createElement("div");
      host.className = "power-catalog-disconnect";
      plus.parentElement.insertBefore(host, plus);
    }
    const disabled = pending || !clusters().some(active);
    if (renderedDisabled === disabled) return;
    renderedDisabled = disabled;
    renderIntoContainer(
      <NativeTooltip title="Disconnect all">
        <button
          type="button"
          className="power-catalog-disconnect-button"
          aria-label="Disconnect all"
          disabled={disabled}
          onClick={request}
        >
          <Renderer.Component.Icon material="link_off" size={18} />
        </button>
      </NativeTooltip>,
      host,
    );
  };
  const stop = reaction(() => clusters().map((entity) => [entity, entity.getId(), entity.status.phase]), update);
  const observer = new MutationObserver(update);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-testid"],
  });
  update();
  return () => {
    stopped = true;
    stop();
    observer.disconnect();
    remove();
    style.remove();
  };
}
