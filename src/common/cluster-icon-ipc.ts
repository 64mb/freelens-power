import type { ClusterIconDesign } from "./cluster-icons";

export const CLUSTER_ICONS_CHANNEL = "freelens-power:cluster-icons";

export interface ClusterIconEntry {
  id: string;
  name: string;
  icon?: string;
  design?: ClusterIconDesign;
  customized: boolean;
}

export type ClusterIconRequest = { operation: "list" } | { operation: "apply"; id: string; design: ClusterIconDesign };
