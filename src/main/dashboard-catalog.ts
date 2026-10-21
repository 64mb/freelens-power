// SPDX-License-Identifier: Apache-2.0
import { Common, type Main } from "@freelensapp/extensions";
import { observable } from "mobx";
import { EXTENSION_ID } from "../common/extension-info";

const DASHBOARD_CATALOG_SOURCE_ID = "dashboard";

export function registerDashboardCatalog(extension: Main.LensExtension): () => void {
  const entities = observable.array([
    new Common.Catalog.GeneralEntity({
      metadata: {
        uid: "freelens-power-dashboard",
        name: "Power Dashboard",
        source: EXTENSION_ID,
        labels: {},
      },
      spec: {
        path: `/extension/${EXTENSION_ID}/dashboard`,
        icon: {
          material: "dashboard",
          background: "var(--primary)",
        },
      },
      status: {
        phase: "active",
      },
    }),
  ]);

  extension.addCatalogSource(DASHBOARD_CATALOG_SOURCE_ID, entities);

  return () => extension.removeCatalogSource(DASHBOARD_CATALOG_SOURCE_ID);
}
