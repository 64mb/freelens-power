import { Common, Renderer } from "@freelensapp/extensions";
import { sanitizeDashboardCards } from "../common/dashboard";
import { DASHBOARD_VIEWS_OPEN } from "../common/dashboard-views";
import { EXTENSION_ID } from "../common/extension-info";
import { DashboardPreferencesStore } from "../common/store/dashboard-preferences-store";
import { ipcRenderer } from "./ipc";

export function startDashboardLinks(): () => void {
  let stopped = false;
  const dispose = Renderer.Catalog.catalogEntities.addOnBeforeRun(async (event) => {
    const entity = event.target;
    if (
      entity.apiVersion !== Common.Catalog.WebLink.apiVersion ||
      entity.kind !== Common.Catalog.WebLink.kind ||
      entity.metadata.source !== EXTENSION_ID
    )
      return;
    const card = sanitizeDashboardCards(
      DashboardPreferencesStore.getInstanceOrCreate<DashboardPreferencesStore>().cards,
    ).find((item) => item.url === entity.spec.url);
    if (!card) return;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(card.url));
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (stopped || entity.getId() !== `freelens-power-dashboard-link-${hash}`) return;
    event.preventDefault();
    try {
      await ipcRenderer.invoke(DASHBOARD_VIEWS_OPEN, { id: card.id });
    } catch {
      Common.logger.warn("[Freelens Power] dashboard link could not be opened");
    }
  });
  return () => {
    stopped = true;
    dispose();
  };
}
