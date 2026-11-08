export const KUBECONFIG_EDITOR_CHANNEL = "freelens-power:kubeconfig-editor";
export const KUBECONFIG_EDITOR_MAX_BYTES = 2 * 1024 * 1024;

export type KubeconfigEditorRequest =
  | { operation: "read"; clusterId: string }
  | { operation: "save"; clusterId: string; text: string; revision: string };

export interface KubeconfigEditorResponse {
  text: string;
  revision: string;
  readOnly: boolean;
}
