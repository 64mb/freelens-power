import { Common, Renderer } from "@freelensapp/extensions";
import { reaction } from "mobx";
import { observer } from "mobx-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { KUBECONFIG_EDITOR_CHANNEL, type KubeconfigEditorResponse } from "../common/kubeconfig-editor";
import { ReadOnlyPreferencesStore } from "../common/store/read-only-preferences-store";
import { HelmCodeView } from "./helm-code-view";
import { ipcRenderer } from "./ipc";
import { NativeTooltip } from "./native-tooltip";
import { SettingsModal } from "./preferences/settings-modal";
import { renderIntoContainer, unmountContainer } from "./react-roots";

function actionLabel(label: string, material: string) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span aria-hidden="true" style={{ display: "inline-flex" }}>
        <Renderer.Component.Icon material={material} size={16} />
      </span>
      {label}
    </span>
  );
}

export const KubeconfigEditor = observer(function KubeconfigEditor({
  clusterId,
  onClose,
}: {
  clusterId: string;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<KubeconfigEditorResponse>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [discardReload, setDiscardReload] = useState(false);
  const sequence = useRef(0);
  const dirty = snapshot !== undefined && text !== snapshot.text;
  const readOnly =
    snapshot?.readOnly || ReadOnlyPreferencesStore.getInstanceOrCreate<ReadOnlyPreferencesStore>().enabled;
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result: KubeconfigEditorResponse = await ipcRenderer.invoke(KUBECONFIG_EDITOR_CHANNEL, {
        operation: "read",
        clusterId,
      });
      if (request !== sequence.current) return;
      setSnapshot(result);
      setText(result.text);
      setDiscard(false);
    } catch {
      if (request === sequence.current) setError("Unable to open the kubeconfig.");
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }, [clusterId]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  const close = () => {
    if (busy) return;
    if (dirty && !discard) {
      setDiscardReload(false);
      setDiscard(true);
    } else if (dirty && discard) setDiscard(false);
    else onClose();
  };
  const save = async () => {
    if (!snapshot || busy || readOnly || !dirty) return;
    const request = ++sequence.current;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result: KubeconfigEditorResponse = await ipcRenderer.invoke(KUBECONFIG_EDITOR_CHANNEL, {
        operation: "save",
        clusterId,
        text,
        revision: snapshot.revision,
      });
      if (request !== sequence.current) return;
      setSnapshot(result);
      setText(result.text);
      setSaved(true);
      setDiscard(false);
    } catch {
      if (request === sequence.current)
        setError("Unable to save. Check the YAML and reload if the file changed outside this editor.");
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  };
  return (
    <SettingsModal id="power-kubeconfig-editor" title="Kubeconfig" onClose={close} width={1320} guardClose>
      <div data-power-kubeconfig-editor="" style={{ minWidth: 0 }}>
        {error && (
          <p role="alert" style={{ color: "var(--colorError)" }}>
            {error}
          </p>
        )}
        {readOnly && <p>Read-only mode is enabled.</p>}
        {snapshot ? (
          <HelmCodeView
            value={text}
            readOnly={!!readOnly || busy}
            onChange={(value) => {
              setText(value);
              setSaved(false);
            }}
            ariaLabel="Kubeconfig YAML"
            style={{ height: "clamp(240px, calc(100vh - 240px), 900px)" }}
          />
        ) : (
          <p role="status">{busy ? "Loading kubeconfig…" : "Kubeconfig is unavailable."}</p>
        )}
        {saved && <p role="status">Saved</p>}
        {discard && <p role="alert">Discard unsaved changes?</p>}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 16 }}>
          <Renderer.Component.Button
            label={actionLabel("Reload", "refresh")}
            disabled={busy}
            onClick={() => {
              if (dirty) {
                setDiscardReload(true);
                setDiscard(true);
              } else void load();
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            {discard && (
              <Renderer.Component.Button
                label="Discard changes"
                disabled={busy}
                onClick={() => {
                  if (discardReload) void load();
                  else onClose();
                }}
              />
            )}
            <Renderer.Component.Button
              label={actionLabel(discard ? "Keep editing" : "Close", discard ? "edit" : "close")}
              disabled={busy}
              onClick={close}
            />
            <Renderer.Component.Button
              label={actionLabel("Save", "save")}
              primary
              disabled={busy || !!readOnly || !dirty}
              onClick={() => void save()}
            />
          </div>
        </div>
      </div>
    </SettingsModal>
  );
});

export function startKubeconfigEditorEntrypoints(): () => void {
  const modal = document.createElement("div");
  modal.setAttribute("data-power-kubeconfig-modal", "");
  document.body.append(modal);
  let stopped = false;
  const open = (clusterId: string) => {
    if (stopped || !Renderer.Catalog.getClusterById(clusterId)) return;
    renderIntoContainer(
      <KubeconfigEditor key={clusterId} clusterId={clusterId} onClose={() => unmountContainer(modal)} />,
      modal,
    );
  };
  const addMenu = (entity: Common.Catalog.CatalogEntity, context: Common.Catalog.CatalogEntityContextMenuContext) => {
    if (!Renderer.Catalog.getClusterById(entity.getId())) return;
    context.menuItems.push({ title: "Open kubeconfig", icon: "edit", onClick: () => open(entity.getId()) });
  };
  let category: Common.Catalog.CatalogCategory | undefined;
  const stopCategory = reaction(
    () => Renderer.Catalog.catalogCategories.getForGroupKind("entity.k8slens.dev", "KubernetesCluster"),
    (next) => {
      category?.off("contextMenuOpen", addMenu);
      category = next;
      category?.on("contextMenuOpen", addMenu);
    },
    { fireImmediately: true },
  );
  const owned = new Map<Element, { host: HTMLSpanElement; clusterId: string }>();
  const remove = (heading: Element) => {
    const entry = owned.get(heading);
    if (!entry) return;
    unmountContainer(entry.host);
    entry.host.remove();
    owned.delete(heading);
  };
  const update = () => {
    if (stopped) return;
    const found = new Set<Element>();
    let clusterId: string | undefined;
    try {
      clusterId = decodeURIComponent(/^\/entity\/([^/]+)\/settings\/?$/.exec(location.pathname)?.[1] ?? "");
    } catch {
      /* ignore malformed routes */
    }
    if (clusterId && Renderer.Catalog.getClusterById(clusterId)) {
      for (const heading of document.querySelectorAll('[data-testid="entity-settings"] .SubTitle')) {
        const title = Array.from(heading.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join("")
          .trim();
        if (title !== "Kubeconfig") continue;
        found.add(heading);
        let entry = owned.get(heading);
        if (!entry) {
          const host = document.createElement("span");
          host.setAttribute("data-power-kubeconfig-action", "");
          heading.append(host);
          entry = { host, clusterId: "" };
          owned.set(heading, entry);
        }
        if (entry.clusterId === clusterId) continue;
        entry.clusterId = clusterId;
        const id = clusterId;
        renderIntoContainer(
          <NativeTooltip title="Open kubeconfig">
            <button
              type="button"
              className="power-kubeconfig-open"
              aria-label="Open kubeconfig"
              onClick={() => open(id)}
            >
              <Renderer.Component.Icon material="edit" size={18} />
            </button>
          </NativeTooltip>,
          entry.host,
        );
      }
    }
    for (const heading of owned.keys()) if (!found.has(heading)) remove(heading);
  };
  const style = document.createElement("style");
  style.textContent = `[data-power-kubeconfig-action]{display:inline-flex;vertical-align:middle;margin-left:8px}.power-kubeconfig-open{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--textColorSecondary);cursor:pointer}.power-kubeconfig-open:hover{color:var(--primary)}.power-kubeconfig-open:focus-visible{outline:2px solid var(--primary);outline-offset:2px}`;
  document.head.append(style);
  const observer = new MutationObserver(update);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  update();
  return () => {
    stopped = true;
    observer.disconnect();
    stopCategory();
    category?.off("contextMenuOpen", addMenu);
    for (const heading of owned.keys()) remove(heading);
    unmountContainer(modal);
    modal.remove();
    style.remove();
  };
}
