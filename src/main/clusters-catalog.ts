import { Common, type Main } from "@freelensapp/extensions";
import { observable } from "mobx";
import { EXTENSION_ID } from "../common/extension-info";

export function registerClustersCatalog(extension: Main.LensExtension): () => void {
  const source = "clusters";
  const svg = Common.Catalog.kubernetesClusterCategory.metadata.icon.replace(
    /viewBox="([^"]+)"/,
    (attribute, value: string) => {
      const [x, y, width, height] = value.trim().split(/\s+/).map(Number);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return attribute;
      const size = (Math.max(width, height) * 4) / 3;
      return `viewBox="${x - (size - width) / 2} ${y - (size - height) / 2} ${size} ${size}"`;
    },
  );
  const icon = {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    background: "var(--primary)",
  };
  extension.addCatalogSource(
    source,
    observable.array([
      new Common.Catalog.GeneralEntity({
        metadata: { uid: "freelens-power-clusters", name: "Clusters", source: EXTENSION_ID, labels: {} },
        spec: {
          path: "/catalog/entity.k8slens.dev/KubernetesCluster",
          icon,
        },
        status: { phase: "active" },
      }),
    ]),
  );
  return () => extension.removeCatalogSource(source);
}
