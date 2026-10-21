import { reaction } from "mobx";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";

const marker = "data-freelens-power-read-only";
const excluded = ".freelens-power-preferences, #freelens-power-settings, .freelens-power-dashboard, .power-ai-panel";
const directActions = [
  ".CatalogAddButton",
  ".KubeObjectListLayout .AddRemoveButtons .add-button",
  ".KubeObjectListLayout .AddRemoveButtons .remove-button",
  ".create-resource-tab",
  ".CreateResource .InfoPanel button.active",
  '[data-testid^="save-edit-resource-from-tab-for-"]',
  '[data-testid^="save-and-close-edit-resource-from-tab-for-"]',
  '[data-testid^="menu-action-edit-for-"]',
  '[data-testid^="menu-action-delete-for-"]',
  '[data-testid^="menu-action-force-delete-for-"]',
  '[data-testid^="menu-action-delete-with-finalizers-for-"]',
  '.MenuActions [data-testid="menu-action-remove"]',
].join(",");
const menuActions = new Set([
  "edit",
  "delete",
  "force delete",
  "delete with finalizers",
  "remove",
  "remove cluster",
  "delete cluster",
  "cordon",
  "uncordon",
  "drain",
  "scale",
  "restart",
]);

export function startReadOnlyMode(): () => void {
  const preferences = ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>();
  const style = document.createElement("style");
  style.dataset.freelensPower = "read-only";
  style.textContent = `[${marker}] { display: none !important; }`;
  const hidden = new Set<HTMLElement>();

  function restore() {
    for (const element of hidden) element.removeAttribute(marker);
    hidden.clear();
    style.remove();
  }

  function isMutation(element: HTMLElement): boolean {
    if (element.closest(excluded)) return false;
    if (element.matches(directActions)) return true;
    if (!element.matches('.MenuActions .MenuItem, [data-testid^="menu-actions-for-kube-object-menu-"] .MenuItem'))
      return false;
    const title = (element.querySelector(".title")?.textContent ?? element.textContent)?.trim().toLowerCase();
    if (title && menuActions.has(title)) return true;
    return !!element.querySelector(
      '[data-icon-name="edit"], [data-icon-name="delete"], [data-icon-name="delete_forever"], [data-icon-name="delete_sweep"], [data-icon-name="pause_circle_filled"], [data-icon-name="play_circle_filled"]',
    );
  }

  function refresh() {
    for (const element of hidden) {
      if (!element.isConnected || !isMutation(element)) {
        element.removeAttribute(marker);
        hidden.delete(element);
      }
    }
    for (const element of document.querySelectorAll<HTMLElement>(`${directActions}, .MenuActions .MenuItem`)) {
      if (isMutation(element)) {
        element.setAttribute(marker, "");
        hidden.add(element);
      }
    }
  }

  function intercept(event: Event) {
    if (!preferences.enabled || !(event.target instanceof Element)) return;
    if (event instanceof KeyboardEvent && !["Enter", " "].includes(event.key)) return;
    const target = event.target.closest<HTMLElement>(`[${marker}], ${directActions}, .MenuItem`);
    if (!target || !isMutation(target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  const observer = new MutationObserver(refresh);
  const stop = reaction(
    () => preferences.enabled,
    (enabled) => {
      observer.disconnect();
      restore();
      if (!enabled) return;
      document.head.append(style);
      refresh();
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "data-testid", "title"],
      });
    },
    { fireImmediately: true },
  );
  document.addEventListener("click", intercept, true);
  document.addEventListener("keydown", intercept, true);

  return () => {
    stop();
    observer.disconnect();
    document.removeEventListener("click", intercept, true);
    document.removeEventListener("keydown", intercept, true);
    restore();
  };
}
