import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import { observer } from "mobx-react";
import { useEffect, useRef, useState } from "react";
import { HELM_CHANNEL, type HelmReleaseMetadata, type HelmRequest, type HelmResponse } from "../common/helm";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { helmOperations } from "./helm-operations";
import { NativeTooltip } from "./native-tooltip";

const { Icon } = Renderer.Component;
const session = `delete-revision-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let sequence = 0;
export interface HelmRevisionDeleteProps {
  clusterId: string;
  contextId?: string;
  revision: HelmReleaseMetadata;
  current: boolean;
  allowed: boolean;
  busy?: boolean;
  onDeleted: () => void;
  onError: (message: string) => void;
}
const identity = (props: HelmRevisionDeleteProps) =>
  JSON.stringify([
    props.clusterId,
    props.contextId,
    props.revision.namespace,
    props.revision.name,
    props.revision.revision,
    props.revision.uid,
    props.revision.status,
    props.current,
  ]);
const readOnly = () => ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled;
const permitted = (props: HelmRevisionDeleteProps) =>
  !readOnly() &&
  PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled &&
  props.allowed &&
  !props.busy &&
  !props.current &&
  Boolean(props.contextId && props.revision.uid) &&
  ["superseded", "failed", "uninstalled"].includes(props.revision.status.toLowerCase()) &&
  !helmOperations.isRunning(props.clusterId, props.contextId, props.revision.namespace, props.revision.name);

export const HelmRevisionDelete = observer((props: HelmRevisionDeleteProps) => {
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  const operation = useRef<HelmRequest>();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (operation.current)
        void ipcRenderer.invoke(HELM_CHANNEL, { ...operation.current, operation: "cancel" }).catch(() => undefined);
    };
  }, []);
  const enabled = permitted(props) && !busy;
  if (readOnly()) return null;
  const remove = () => {
    if (!enabled || operation.current) return;
    const target = identity(props);
    const { revision } = props;
    let submitted = false;
    Renderer.Component.ConfirmDialog.open({
      message: (
        <div className="power-helm-confirmation">
          <strong>Delete revision {revision.revision} from history?</strong>
          <p>
            Release: <strong>{revision.name}</strong> · Namespace: <strong>{revision.namespace}</strong>
          </p>
          <p className="helm-confirmation-explanation">
            This permanently removes this inactive revision from Helm history. The active release and its Kubernetes
            resources are preserved.
          </p>
        </div>
      ),
      labelOk: (
        <>
          <Icon material="delete" size={18} aria-hidden="true" />
          <span>Delete revision {revision.revision}</span>
        </>
      ),
      okButtonProps: { className: "power-helm-confirm power-helm-confirm-delete-revision" },
      ok: () => {
        if (
          submitted ||
          !live.current ||
          operation.current ||
          identity(latest.current) !== target ||
          !permitted(latest.current)
        )
          return;
        submitted = true;
        const payload: HelmRequest = {
          operation: "delete-revision",
          requestId: `${session}-${++sequence}`,
          clusterId: props.clusterId,
          contextId: props.contextId,
          namespace: revision.namespace,
          name: revision.name,
          revision: revision.revision,
          uid: revision.uid,
          confirmed: true,
        };
        operation.current = payload;
        setBusy(true);
        void ipcRenderer
          .invoke(HELM_CHANNEL, payload)
          .then((response: HelmResponse) => {
            if (!live.current || identity(latest.current) !== target) return;
            if (response.ok) latest.current.onDeleted();
            else latest.current.onError(response.error.message);
          })
          .catch(() => {
            if (live.current && identity(latest.current) === target)
              latest.current.onError(
                "Unable to confirm revision deletion. Refresh release history to verify its status.",
              );
          })
          .finally(() => {
            operation.current = undefined;
            if (live.current) setBusy(false);
          });
      },
    });
  };
  return (
    <NativeTooltip title={`Delete revision ${props.revision.revision} from history`}>
      <button
        type="button"
        className="helm-icon-button helm-history-delete"
        aria-label={`Delete revision ${props.revision.revision}`}
        disabled={!enabled}
        onClick={remove}
      >
        <Icon material="delete" size={18} />
      </button>
    </NativeTooltip>
  );
});
