import { reaction } from "mobx";
import { HelmPreferencesStore } from "../common/store/helm-preferences-store";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";

export function startPowerHelmEntrypoints(): () => void {
  if (process.isMainFrame !== false) return () => {};
  const helm = HelmPreferencesStore.getInstanceOrCreate<HelmPreferencesStore>();
  const power = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  const style = document.createElement("style");
  style.dataset.freelensPower = "helm-entrypoints";
  style.textContent = `
    [data-testid="cluster-sidebar"] [role="button"][aria-roledescription="sortable"]:has(> [data-testid="sidebar-item-helm"]) {
      display: none !important;
    }
  `;
  let active = false;
  let stopped = false;
  let scheduled = false;
  let moved: { item: HTMLElement; placeholder: Comment } | undefined;
  const restore = () => {
    if (!moved) return;
    const { item, placeholder } = moved;
    if (item.isConnected && placeholder.parentNode) placeholder.replaceWith(item);
    else placeholder.remove();
    moved = undefined;
  };
  const sync = () => {
    scheduled = false;
    if (stopped || !active) return;
    const sidebar = document.querySelector('[data-testid="cluster-sidebar"]');
    const native = sidebar?.querySelector<HTMLElement>('[data-testid="sidebar-item-helm"]')?.parentElement;
    const own = sidebar
      ?.querySelector("[data-power-helm-sidebar-icon]")
      ?.closest<HTMLElement>('[role="button"][aria-roledescription="sortable"]');
    if (!native || !own || native.parentElement !== own.parentElement) {
      restore();
      return;
    }
    if (moved?.item !== own) {
      restore();
      const placeholder = document.createComment("power helm original position");
      own.before(placeholder);
      moved = { item: own, placeholder };
    }
    if (native.nextElementSibling !== own) native.after(own);
  };
  const schedule = () => {
    if (scheduled || stopped || !active) return;
    scheduled = true;
    queueMicrotask(sync);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  const stop = reaction(
    () => power.enabled && helm.enabled,
    (enabled) => {
      active = enabled;
      if (enabled) {
        document.head.append(style);
        sync();
      } else {
        style.remove();
        restore();
      }
    },
    { fireImmediately: true },
  );
  return () => {
    stopped = true;
    observer.disconnect();
    stop();
    restore();
    style.remove();
  };
}
