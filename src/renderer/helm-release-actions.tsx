import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import { observer } from "mobx-react";
import { useEffect, useRef, useState } from "react";
import { HELM_CHANNEL, type HelmReleaseMetadata, type HelmRequest, type HelmResponse } from "../common/helm";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { NativeTooltip } from "./native-tooltip";

const { Icon, Menu, MenuItem } = Renderer.Component;
const session = `uninstall-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let sequence = 0;
interface HelmReleaseActionsProps {
  clusterId: string;
  contextId?: string;
  release: HelmReleaseMetadata;
  allowed: boolean;
  onDeleted: () => void;
  onError: (message: string) => void;
  onChanged: () => void;
}
const identity = ({ clusterId, contextId, release }: HelmReleaseActionsProps) =>
  JSON.stringify([clusterId, contextId, release.namespace, release.name, release.revision, release.uid]);
const writable = () =>
  !ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled &&
  PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>().enabled;

export const HelmReleaseActions = observer((props: HelmReleaseActionsProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const live = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  const operation = useRef<HelmRequest>();
  const enabled = writable() && props.allowed && Boolean(props.contextId && props.release.uid) && !busy;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (operation.current)
        void ipcRenderer.invoke(HELM_CHANNEL, { ...operation.current, operation: "cancel" }).catch(() => undefined);
    };
  }, []);
  const closeMenu = () => {
    setMenuOpen(false);
    button.current?.focus();
  };
  const remove = () => {
    closeMenu();
    if (!enabled || operation.current) return;
    const target = identity(props);
    const { release } = props;
    let submitted = false;
    Renderer.Component.ConfirmDialog.open({
      message: (
        <div className="power-helm-confirmation">
          <strong>Delete release {release.name}?</strong>
          <p>
            Namespace: <strong>{release.namespace}</strong>
          </p>
          <p className="helm-confirmation-explanation">
            This runs Helm uninstall and removes the release and its Helm-managed resources.
          </p>
        </div>
      ),
      labelOk: "Delete release",
      okButtonProps: { className: "power-helm-confirm" },
      ok: () => {
        const current = latest.current;
        if (
          submitted ||
          !live.current ||
          operation.current ||
          identity(current) !== target ||
          !current.allowed ||
          !writable()
        )
          return;
        submitted = true;
        const payload: HelmRequest = {
          operation: "uninstall",
          requestId: `${session}-${++sequence}`,
          clusterId: current.clusterId,
          contextId: current.contextId,
          namespace: current.release.namespace,
          name: current.release.name,
          revision: current.release.revision,
          uid: current.release.uid,
          confirmed: true,
        };
        operation.current = payload;
        setBusy(true);
        void ipcRenderer
          .invoke(HELM_CHANNEL, payload)
          .then((result: HelmResponse) => {
            if (!live.current || identity(latest.current) !== target) return;
            if (!result.ok) {
              latest.current.onError(result.error.message);
              return;
            }
            const { onDeleted, onChanged } = latest.current;
            onDeleted();
            onChanged();
          })
          .catch((error: unknown) => {
            if (live.current && identity(latest.current) === target)
              latest.current.onError(error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            if (operation.current === payload) {
              operation.current = undefined;
              if (live.current) setBusy(false);
            }
          });
      },
    });
  };
  return (
    <>
      <NativeTooltip title={menuOpen ? undefined : "Release actions"}>
        <button
          ref={button}
          type="button"
          className="helm-icon-button"
          aria-label="Release actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <Icon material="more_vert" size={20} />
        </button>
      </NativeTooltip>
      {menuOpen && (
        <Menu
          isOpen
          open={() => setMenuOpen(true)}
          close={closeMenu}
          contextTarget={button.current}
          autoFocus
          usePortal
          className="helm-release-actions-menu"
        >
          <MenuItem disabled={!enabled} onClick={remove}>
            <Icon material="delete" size={16} />
            Delete release
          </MenuItem>
        </Menu>
      )}
    </>
  );
});
