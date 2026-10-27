import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import { observer } from "mobx-react";
import { useEffect, useRef, useState } from "react";
import { HELM_CHANNEL, type HelmReleaseMetadata, type HelmRequest, type HelmResponse } from "../common/helm";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { helmOperations } from "./helm-operations";
import { NativeTooltip } from "./native-tooltip";

const { Icon, Menu, MenuItem, Dialog: NativeDialog, Input, Button } = Renderer.Component;
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

function ReleaseNameConfirmation({
  name,
  enabled,
  cancel,
  submit,
  focusTarget,
}: {
  name: string;
  enabled: boolean;
  cancel: () => void;
  submit: (name: string) => void;
  focusTarget: HTMLElement | null;
}) {
  const [value, setValue] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(focusTarget);
  const callbacks = useRef({ cancel, submit });
  callbacks.current = { cancel, submit };
  const exact = value === name;
  useEffect(() => {
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        callbacks.current.cancel();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>("*")).filter((node) =>
        node.matches("input:not(:disabled),button:not(:disabled)"),
      );
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
      event.stopPropagation();
    };
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("keydown", keyboard, true);
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, []);
  return (
    <NativeDialog isOpen modal close={cancel} className="power-helm-release-delete-dialog">
      <style>{`
      .Dialog.power-helm-release-delete-dialog { z-index:12000; background:rgb(0 0 0 / 55%); }
      :root .Dialog.power-helm-release-delete-dialog > .box { border:1px solid var(--borderColor); border-radius:12px; background:var(--contentColor); overflow:hidden; }
      .power-helm-release-delete-content { box-sizing:border-box; display:grid; gap:20px; width:min(520px,calc(100vw - 48px)); max-height:calc(100vh - 64px); overflow:auto; padding:28px; }
      .power-helm-release-delete-content h2 { display:flex; align-items:center; gap:10px; margin:0; font-size:20px; }
      .power-helm-release-delete-content h2 > .Icon { color:var(--colorError); }
      .power-helm-release-delete-content p { margin:0; line-height:1.6; }
      .power-helm-release-delete-field { display:grid; gap:8px; }
      .power-helm-release-delete-footer { display:flex; justify-content:flex-end; gap:10px; padding-top:20px; border-top:1px solid var(--borderColor); }
      .power-helm-release-delete-content .Button { position:relative; display:inline-flex; align-items:center; justify-content:center; gap:6px; height:32px; padding:0 12px; border:1px solid var(--borderColor); border-radius:5px; box-sizing:border-box; }
      .power-helm-release-delete-content .Button::before { position:absolute; inset:0; pointer-events:none; }
      .power-helm-release-delete-content .Button > .Icon { margin:0; padding:0; }
      .power-helm-release-delete-content .Button.power-helm-confirm { background:var(--colorError); border-color:var(--colorError); color:white; }
      .power-helm-release-delete-content .Button.power-helm-confirm:disabled { opacity:.45; }
    `}</style>
      <div
        className="power-helm-release-delete-content"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm release deletion"
        data-testid="confirmation-dialog"
      >
        <h2>
          <Icon material="delete" />
          <span>Confirm release deletion</span>
        </h2>
        <p>
          Type <strong>{name}</strong> exactly to permanently delete this release and its Helm-managed resources.
        </p>
        <div className="power-helm-release-delete-field">
          <label id="power-helm-release-delete-name-label">Release name</label>
          <Input
            aria-labelledby="power-helm-release-delete-name-label"
            value={value}
            onChange={setValue}
            trim={false}
            autoComplete="off"
            spellCheck={false}
            onSubmit={() => {
              if (exact && enabled) callbacks.current.submit(value);
            }}
          />
        </div>
        <div className="power-helm-release-delete-footer">
          <Button onClick={cancel}>
            <Icon material="close" />
            <span>Cancel</span>
          </Button>
          <Button
            className="power-helm-confirm"
            disabled={!exact || !enabled}
            onClick={() => {
              if (exact && enabled) callbacks.current.submit(value);
            }}
          >
            <Icon material="delete" />
            <span>Delete release</span>
          </Button>
        </div>
      </div>
    </NativeDialog>
  );
}

export const HelmReleaseActions = observer((props: HelmReleaseActionsProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ target: string; name: string }>();
  const deferredConfirmation = useRef<ReturnType<typeof setTimeout>>();
  const button = useRef<HTMLButtonElement>(null);
  const live = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  const operation = useRef<HelmRequest>();
  const isWritable = writable();
  const enabled =
    isWritable &&
    props.allowed &&
    Boolean(props.contextId && props.release.uid) &&
    !busy &&
    !helmOperations.isRunning(props.clusterId, props.contextId, props.release.namespace, props.release.name);
  useEffect(() => {
    if (!isWritable) {
      setMenuOpen(false);
      setConfirmation(undefined);
      clearTimeout(deferredConfirmation.current);
    }
  }, [isWritable]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(deferredConfirmation.current);
      if (operation.current)
        void ipcRenderer.invoke(HELM_CHANNEL, { ...operation.current, operation: "cancel" }).catch(() => undefined);
    };
  }, []);
  const closeMenu = () => {
    setMenuOpen(false);
    button.current?.focus();
  };
  const validTarget = (target: string) => {
    const current = latest.current;
    return (
      live.current &&
      !operation.current &&
      identity(current) === target &&
      current.allowed &&
      Boolean(current.contextId && current.release.uid) &&
      writable() &&
      !helmOperations.isRunning(current.clusterId, current.contextId, current.release.namespace, current.release.name)
    );
  };
  const submit = (typedName: string) => {
    if (!confirmation || typedName !== confirmation.name || !validTarget(confirmation.target)) return;
    const current = latest.current;
    if (typedName !== current.release.name) return;
    const target = confirmation.target;
    setConfirmation(undefined);
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
      confirmationName: typedName,
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
  };
  const remove = () => {
    closeMenu();
    if (!enabled || operation.current || confirmation) return;
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
      labelOk: (
        <>
          <Icon material="delete" size={18} />
          <span>Delete release</span>
        </>
      ),
      okButtonProps: { className: "power-helm-confirm" },
      ok: () => {
        if (submitted || !validTarget(target)) return;
        submitted = true;
        deferredConfirmation.current = setTimeout(() => {
          if (validTarget(target)) setConfirmation({ target, name: release.name });
        }, 0);
      },
    });
  };

  if (!isWritable) return null;
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
      {confirmation && (
        <ReleaseNameConfirmation
          key={confirmation.target}
          name={confirmation.name}
          focusTarget={button.current}
          enabled={validTarget(confirmation.target)}
          cancel={() => setConfirmation(undefined)}
          submit={submit}
        />
      )}
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
          <MenuItem
            className="helm-release-delete-action"
            disabled={!enabled || Boolean(confirmation)}
            onClick={remove}
          >
            <Icon material="delete" size={16} />
            Delete release
          </MenuItem>
        </Menu>
      )}
    </>
  );
});
