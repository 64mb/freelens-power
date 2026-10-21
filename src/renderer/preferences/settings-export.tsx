import { ipcRenderer } from "electron";
import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import {
  SETTINGS_EXPORT,
  SETTINGS_IMPORT,
  type SettingsExportResult,
  type SettingsImportResult,
} from "../../common/settings-export";
import { SettingsIconAction } from "./settings-icon-action";

export function SettingsExport() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const marker = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<HTMLSpanElement>();
  useEffect(() => {
    let heading: Element | null = null;
    for (
      let ancestor = marker.current?.parentElement;
      ancestor && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      if (ancestor.matches("section")) heading = ancestor.querySelector(":scope > h2");
      if (heading) break;
    }
    if (!heading) return;
    const container = document.createElement("span");
    container.className = "power-preferences-header-actions";
    heading.classList.add("power-preferences-heading");
    heading.append(container);
    setTarget(container);
    return () => {
      container.remove();
      heading.classList.remove("power-preferences-heading");
    };
  }, []);
  async function exportSettings() {
    if (busy) return;
    setBusy(true);
    setStatus("");
    try {
      const result: SettingsExportResult = await ipcRenderer.invoke(SETTINGS_EXPORT);
      setStatus(
        result === "saved"
          ? "Dashboard and shortcuts exported."
          : result === "canceled"
            ? ""
            : "Could not export settings.",
      );
    } catch {
      setStatus("Could not export settings.");
    } finally {
      setBusy(false);
    }
  }
  async function importSettings() {
    if (busy) return;
    setBusy(true);
    setStatus("");
    try {
      const result: SettingsImportResult = await ipcRenderer.invoke(SETTINGS_IMPORT);
      setStatus(
        result === "restored"
          ? "Dashboard and shortcuts restored."
          : result === "canceled"
            ? ""
            : "Could not restore settings.",
      );
    } catch {
      setStatus("Could not restore settings.");
    } finally {
      setBusy(false);
    }
  }
  const actions = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <SettingsIconAction
        material="file_download"
        label="Export dashboard and shortcuts"
        disabled={busy}
        onClick={() => void exportSettings()}
      />
      <SettingsIconAction
        material="file_upload"
        label="Restore dashboard and shortcuts"
        disabled={busy}
        onClick={() => void importSettings()}
      />
    </span>
  );
  return (
    <>
      <span ref={marker} hidden />
      {target ? ReactDOM.createPortal(actions, target) : actions}
      <span role="status" className="power-settings-hint" style={{ display: status ? "block" : "contents" }}>
        {status}
      </span>
    </>
  );
}
