import { createHash } from "node:crypto";
import { Common, type Main } from "@freelensapp/extensions";
import { observable, reaction } from "mobx";
import { sanitizeDashboardCards } from "../common/dashboard";
import { EXTENSION_ID } from "../common/extension-info";
import { DashboardPreferencesStore } from "../common/store/dashboard-preferences-store";

import type { DashboardSiteIcon } from "../common/dashboard-views";

export function registerDashboardLinksCatalog(extension: Main.LensExtension, icons: DashboardSiteIcon[]): () => void {
  const source = "dashboard-links";
  const entities = observable.array<Common.Catalog.WebLink>([]);
  const store = DashboardPreferencesStore.getInstanceOrCreate<DashboardPreferencesStore>();
  const stop = reaction(
    () => ({ cards: sanitizeDashboardCards(store.cards), icons: icons.map((icon) => ({ ...icon })) }),
    ({ cards, icons }) => {
      const seen = new Set<string>();
      entities.replace(
        cards.flatMap((card) => {
          if (seen.has(card.url)) return [];
          seen.add(card.url);
          const favicon = icons.find((icon) => icon.pageUrl === card.url);
          const spec = {
            url: card.url,
            icon: favicon
              ? { src: favicon.dataUrl, background: "transparent" }
              : { material: "public", background: "var(--primary)" },
          };
          return [
            new Common.Catalog.WebLink({
              metadata: {
                uid: `freelens-power-dashboard-link-${createHash("sha256").update(card.url).digest("hex")}`,
                name: card.title,
                source: EXTENSION_ID,
                labels: {},
              },
              spec,
              status: { phase: "available" },
            }),
          ];
        }),
      );
    },
    { fireImmediately: true },
  );
  extension.addCatalogSource(source, entities);
  return () => {
    stop();
    extension.removeCatalogSource(source);
  };
}
