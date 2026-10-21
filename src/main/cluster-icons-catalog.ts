import { Common, type Main } from "@freelensapp/extensions";
import { observable } from "mobx";
import { EXTENSION_ID } from "../common/extension-info";

export function registerClusterIconsCatalog(extension: Main.LensExtension): () => void {
  const source = "cluster-icons";
  extension.addCatalogSource(
    source,
    observable.array([
      new Common.Catalog.GeneralEntity({
        metadata: { uid: "freelens-power-cluster-icons", name: "Cluster icons", source: EXTENSION_ID, labels: {} },
        spec: {
          path: `/extension/${EXTENSION_ID}/cluster-icons`,
          icon: { material: "palette", background: "var(--primary)" },
        },
        status: { phase: "active" },
      }),
    ]),
  );
  return () => extension.removeCatalogSource(source);
}
