export const HELM_CHANNEL = "freelens-power:helm";
export type HelmSection = "overview" | "values" | "manifest" | "notes";
export interface HelmReleaseMetadata {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  secretName: string;
  uid?: string;
  updatedAt?: string;
}
export interface HelmOverview {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart?: string;
  chartName?: string;
  appVersion?: string;
  chartVersion?: string;
  description?: string;
  updatedAt?: string;
}
export interface HelmDetail {
  overview: HelmOverview;
  section: HelmSection;
  content: string;
  language: string;
}
export interface HelmRequest {
  requestId: string;
  contextId?: string;
  clusterId: string;
  namespace: string;
  operation:
    | "list"
    | "history"
    | "details"
    | "rollback"
    | "edit-options"
    | "upgrade-values"
    | "uninstall"
    | "app-version"
    | "cancel";
  name?: string;
  revision?: number;
  uid?: string;
  section?: HelmSection;
  confirmed?: boolean;
  values?: string;
  chart?: string;
  refresh?: boolean;
}
export type HelmResponse =
  | {
      ok: true;
      contextId?: string;
      releases?: HelmReleaseMetadata[];
      detail?: HelmDetail;
      rollbackAllowed?: boolean;
      uninstallAllowed?: boolean;
      upgradeAllowed?: boolean;
      appVersion?: string;
      chartVersion?: string;
      chartChoices?: Array<{ ref: string; version: string }>;
      fetchedAt?: number;
      cached?: boolean;
    }
  | { ok: false; error: { code: string; message: string } };
