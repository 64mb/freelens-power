import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import { useCallback, useEffect, useRef, useState } from "react";
import { CLUSTER_ICONS_CHANNEL, type ClusterIconEntry } from "../common/cluster-icon-ipc";
import {
  type ClusterIconDesign,
  clusterIconDataUrl,
  defaultClusterIconDesign,
  GLYPHS,
  normalizeClusterIconDesign,
} from "../common/cluster-icons";
import { IconColorPicker, MATCHING_ICON_COLORS } from "./cluster-icon-colors";
import { NativeTooltip } from "./native-tooltip";
import { SettingsModal } from "./preferences/settings-modal";

const styles = `
.ClusterManager main.power-icon-studio, .power-icon-studio { display: block; position: relative; z-index: 2; flex: 1; min-width: 0; height: 100%; overflow: auto; padding: 32px; box-sizing: border-box; background: var(--mainBackground); color: var(--textColorPrimary); }
.power-icon-studio > .power-icon-content { max-width: 1000px; margin: 0 auto; }
.power-icon-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
.power-icon-header h1 { font-size: 24px; font-weight: 600; margin: 0 0 8px; color: var(--textColorAccent); }
.power-icon-header p { margin: 0; color: var(--textColorSecondary); }
.power-icon-search { width: 240px; }
.power-icon-grid { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 16px; }
.power-icon-card { display: flex; flex-direction: column; align-items: center; gap: 12px; position: relative; padding: 20px 14px 16px; min-width: 0; border: 1px solid var(--borderFaintColor); border-radius: 14px; background: var(--contentColor); color: var(--textColorPrimary); font: inherit; cursor: pointer; transition: border-color 150ms ease, background-color 150ms ease, transform 150ms ease; }
.power-icon-card:hover { border-color: var(--primary); background: color-mix(in srgb,var(--primary) 4%,var(--contentColor)); transform: translateY(-2px); }
.power-icon-card:focus-visible, .power-icon-glyph:focus-visible, .power-icon-swatch:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.power-icon-card > img, .power-icon-card .power-icon-current-avatar { width: 64px; height: 64px; object-fit: contain; border-radius: 16px; }
.power-icon-card-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.power-icon-empty { padding: 64px 24px; text-align: center; border: 1px dashed var(--borderFaintColor); border-radius: 14px; color: var(--textColorSecondary); }
.power-icon-editor { display: grid; grid-template-columns: 144px minmax(0,1fr); gap: 24px; }
.power-icon-preview { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; padding: 24px 12px; border: 1px solid var(--borderFaintColor); border-radius: 12px; background: var(--contentColor); }
.power-icon-preview-main { width: 96px; height: 96px; }
.power-icon-preview-sizes { display: flex; align-items: center; gap: 14px; }
.power-icon-preview-caption { font-size: 11px; color: var(--textColorSecondary); }
.power-icon-fields { display: grid; gap: 16px; }
.power-icon-field { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
.power-icon-field input[type=text] { width: 100px; padding: 8px 10px; border: 1px solid var(--borderFaintColor); border-radius: 6px; background: var(--contentColor); color: var(--textColorPrimary); font: inherit; }
.power-icon-field input:focus-visible { outline: 1px solid var(--primary); }
.power-icon-section-label { color: var(--textColorSecondary); font-size: 12px; margin-bottom: 10px; }
.power-icon-glyphs { display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 8px; }
.power-icon-glyph { display: flex; align-items: center; justify-content: center; min-height: 54px; padding: 6px; border: 1px solid var(--borderFaintColor); border-radius: 8px; background: var(--contentColor); cursor: pointer; transition: border-color 150ms ease, background-color 150ms ease; }
.power-icon-glyph:hover, .power-icon-glyph[aria-pressed=true] { border-color: var(--primary); background: color-mix(in srgb,var(--primary) 8%,var(--contentColor)); }
.power-icon-glyph img { width: 38px; height: 38px; }
.power-icon-swatches { display: flex; align-items: center; gap: 8px; }
.power-icon-swatch { width: 22px; height: 22px; border: 2px solid transparent; border-radius: 50%; cursor: pointer; }
.power-icon-swatch[aria-pressed=true] { box-shadow: 0 0 0 2px var(--mainBackground),0 0 0 3px var(--primary); }
.power-icon-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 1px solid var(--borderFaintColor); }
.power-icon-footer-actions { display: flex; gap: 8px; margin-left: auto; }
.power-icon-error { color: var(--colorError); font-size: 12px; line-height: 1.5; }
@media (max-width: 900px) { .power-icon-grid { grid-template-columns: repeat(4,minmax(0,1fr)); } }
@media (max-width: 700px) { .power-icon-header { align-items: stretch; flex-direction: column; } .power-icon-search { width: 100%; } .power-icon-grid { grid-template-columns: repeat(3,minmax(0,1fr)); } .ClusterManager main.power-icon-studio, .power-icon-studio { padding: 20px; } }
@media (max-width: 480px) { .power-icon-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } .power-icon-editor { grid-template-columns: 1fr; } .power-icon-preview { flex-direction: row; padding: 16px; } .power-icon-preview-main { width: 72px; height: 72px; } }
@media (prefers-reduced-motion: reduce) { .power-icon-card { transition: none; transform: none; } }
`;

function IconEditor({
  entry,
  onClose,
  onSaved,
}: {
  entry: ClusterIconEntry;
  onClose: () => void;
  onSaved: (entries: ClusterIconEntry[]) => void;
}) {
  const [design, setDesign] = useState<ClusterIconDesign>(() => entry.design ?? defaultClusterIconDesign(entry.name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const paletteOpen = useRef(false);
  const onPaletteOpenChange = useCallback((open: boolean) => {
    paletteOpen.current = open;
  }, []);
  const update = (key: keyof ClusterIconDesign, value: string) =>
    setDesign((previous) => ({ ...previous, [key]: value }));
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const entries = await ipcRenderer.invoke(CLUSTER_ICONS_CHANNEL, {
        operation: "apply",
        id: entry.id,
        design,
      });
      onSaved(entries);
    } catch {
      setError("Unable to save this cluster icon. Try again.");
    } finally {
      setBusy(false);
    }
  };
  let validDesign: ClusterIconDesign | undefined;
  try {
    validDesign = normalizeClusterIconDesign(design);
  } catch {
    validDesign = undefined;
  }
  const previewDesign = validDesign ?? defaultClusterIconDesign(entry.name);
  const preview = clusterIconDataUrl(previewDesign);
  return (
    <SettingsModal
      id="power-cluster-icon-editor"
      title={entry.name}
      onClose={() => {
        if (!busy && !paletteOpen.current) onClose();
      }}
    >
      <style>{styles}</style>
      <div className="power-icon-editor">
        <div className="power-icon-preview">
          <img className="power-icon-preview-main" src={preview} alt="Cluster icon preview" />
          <div className="power-icon-preview-sizes">
            <img src={preview} width={36} height={36} alt="" />
          </div>
          <span className="power-icon-preview-caption">Sidebar preview</span>
        </div>
        <div className="power-icon-fields">
          <label className="power-icon-field" htmlFor="power-icon-label">
            Label
            <input
              id="power-icon-label"
              type="text"
              value={design.label}
              onChange={(event) => update("label", Array.from(event.target.value).slice(0, 3).join(""))}
              disabled={busy}
              autoFocus
            />
          </label>
          {(
            [
              ["outlineColor", "Outline"],
              ["labelColor", "Label color"],
              ["iconColor", "Icon color"],
            ] as const
          ).map(([key, label]) => (
            <div className="power-icon-field" key={key}>
              <span>{label}</span>
              <IconColorPicker
                label={label}
                value={design[key]}
                onChange={(color) => update(key, color)}
                disabled={busy}
                onOpenChange={onPaletteOpenChange}
              />
            </div>
          ))}
          <div>
            <div className="power-icon-section-label">Matching outline & label</div>
            <div className="power-icon-swatches">
              {MATCHING_ICON_COLORS.map(({ name, color }) => (
                <NativeTooltip key={color} title={`${name} · ${color}`}>
                  <button
                    type="button"
                    className="power-icon-swatch"
                    style={{ background: color }}
                    aria-label={`Use ${color} for outline and label`}
                    aria-pressed={design.outlineColor === color && design.labelColor === color}
                    disabled={busy}
                    onClick={() => setDesign((previous) => ({ ...previous, outlineColor: color, labelColor: color }))}
                  />
                </NativeTooltip>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div>
        <div className="power-icon-section-label">Choose an icon</div>
        <div className="power-icon-glyphs">
          {GLYPHS.map((glyph) => (
            <NativeTooltip key={glyph.id} title={glyph.label}>
              <button
                type="button"
                className="power-icon-glyph"
                aria-label={glyph.label}
                aria-pressed={design.glyph === glyph.id}
                disabled={busy}
                onClick={() => update("glyph", glyph.id)}
              >
                <img src={clusterIconDataUrl({ ...previewDesign, glyph: glyph.id })} alt="" />
              </button>
            </NativeTooltip>
          ))}
        </div>
      </div>
      {!validDesign && (
        <div role="alert" className="power-icon-error">
          Use up to three visible characters for the label.
        </div>
      )}
      {error && (
        <div role="alert" className="power-icon-error">
          {error}
        </div>
      )}
      <div className="power-icon-footer">
        <div className="power-icon-footer-actions">
          <Renderer.Component.Button label="Cancel" disabled={busy} onClick={onClose} />
          <Renderer.Component.Button
            primary
            label={busy ? "Applying…" : "Apply"}
            disabled={busy || !validDesign}
            onClick={() => void save()}
          />
        </div>
      </div>
    </SettingsModal>
  );
}

export function ClusterIconsPage() {
  const [entries, setEntries] = useState<ClusterIconEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ClusterIconEntry>();
  const load = () => {
    setLoading(true);
    setError("");
    return ipcRenderer
      .invoke(CLUSTER_ICONS_CHANNEL, { operation: "list" })
      .then(setEntries)
      .catch(() => setError("Unable to load saved clusters. Try again."))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    void load();
  }, []);
  const visible = entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return (
    <main className="power-icon-studio">
      <style>{styles}</style>
      <div className="power-icon-content">
        <header className="power-icon-header">
          <div>
            <h1>Cluster icons</h1>
            <p>A shared style. A distinct identity for every cluster.</p>
          </div>
          <div className="power-icon-search">
            <Renderer.Component.Input
              value={query}
              onChange={setQuery}
              placeholder="Find a cluster…"
              aria-label="Find a cluster"
            />
          </div>
        </header>
        {error ? (
          <div className="power-icon-empty" role="alert">
            {error} <Renderer.Component.Button label="Retry" onClick={() => void load()} />
          </div>
        ) : loading ? (
          <div className="power-icon-empty" role="status">
            Loading clusters…
          </div>
        ) : visible.length === 0 ? (
          <div className="power-icon-empty">
            {entries.length ? "No matching clusters" : "Your saved clusters will appear here"}
          </div>
        ) : (
          <div className="power-icon-grid">
            {visible.map((entry) => (
              <NativeTooltip key={entry.id} title={`Edit icon for ${entry.name}`}>
                <button type="button" className="power-icon-card" onClick={() => setEditing(entry)}>
                  <Renderer.Component.Avatar
                    title={entry.name}
                    size={64}
                    src={entry.icon?.startsWith("data:image/") ? entry.icon : undefined}
                    background={entry.icon && !entry.icon.startsWith("data:") ? entry.icon : undefined}
                    colorHash={`${entry.name}-${Renderer.Catalog.catalogEntities.getById(entry.id)?.metadata.source ?? ""}`}
                    className="power-icon-current-avatar"
                  />
                  <span className="power-icon-card-name">{entry.name}</span>
                </button>
              </NativeTooltip>
            ))}
          </div>
        )}
        {editing && (
          <IconEditor
            key={editing.id}
            entry={editing}
            onClose={() => setEditing(undefined)}
            onSaved={(next) => {
              setEntries(next);
              setEditing(undefined);
            }}
          />
        )}
      </div>
    </main>
  );
}
