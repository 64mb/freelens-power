import { Renderer } from "@freelensapp/extensions";
import { ipcRenderer } from "electron";
import { observer } from "mobx-react";
import { useEffect, useState } from "react";
import { type DashboardCard, type DashboardCardSize, normalizeDashboardUrl } from "../../common/dashboard";
import { DASHBOARD_SITE_ICONS, type DashboardSiteIcon } from "../../common/dashboard-views";
import { DashboardPreferencesStore } from "../../common/store/dashboard-preferences-store";
import { SettingsIconAction } from "./settings-icon-action";
import { SettingsField, SettingsModal } from "./settings-modal";

const { Input, Select, Button, Icon, Checkbox } = Renderer.Component;
const sizeOptions = [
  { value: "s" as const, label: "S · Small" },
  { value: "m" as const, label: "M · Medium" },
  { value: "l" as const, label: "L · Large" },
];

function CardEditor({
  card,
  onSave,
  onClose,
}: {
  card?: DashboardCard;
  onSave: (card: DashboardCard) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(card?.title ?? "");
  const [url, setUrl] = useState(card?.url ?? "");
  const [size, setSize] = useState<DashboardCardSize>(card?.size ?? "m");
  const [autoRefresh, setAutoRefresh] = useState(card ? card.autoRefresh === true : true);
  const [submitted, setSubmitted] = useState(false);
  const id = `freelens-power-dashboard-${card?.id ?? "new"}`;
  const normalizedUrl = normalizeDashboardUrl(url);
  const invalid = (submitted || url.length > 0) && !normalizedUrl;

  function save() {
    setSubmitted(true);
    if (!normalizedUrl) return;
    onSave({
      id: card?.id ?? crypto.randomUUID(),
      title: title.trim() || new URL(normalizedUrl).hostname,
      url: normalizedUrl,
      size,
      autoRefresh,
    });
    onClose();
  }

  return (
    <SettingsModal id={id} title={card ? "Edit card" : "Add a card"} onClose={onClose}>
      <SettingsField id={`${id}-title`} label="Title">
        <Input autoFocus id={`${id}-title`} value={title} placeholder="Website name" onChange={setTitle} />
      </SettingsField>
      <SettingsField id={`${id}-url`} label="URL">
        <Input
          id={`${id}-url`}
          value={url}
          placeholder="https://example.com"
          onChange={setUrl}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
        />
        {invalid && (
          <div id={`${id}-error`} role="alert" style={{ color: "var(--colorError)", marginTop: 6 }}>
            Enter a valid HTTP or HTTPS URL.
          </div>
        )}
      </SettingsField>
      <SettingsField id={`${id}-size`} label="Card size">
        <Select
          id={`${id}-size`}
          aria-label="Card size"
          styles={{ menuPortal: (base) => ({ ...base, zIndex: 12010 }) }}
          options={sizeOptions}
          value={size}
          isSearchable={false}
          isClearable={false}
          onChange={(option) => {
            if (option) setSize(option.value);
          }}
        />
      </SettingsField>
      <SettingsField id={`${id}-autorefresh`} label="Autorefresh">
        <Checkbox {...{ id: `${id}-autorefresh` }} value={autoRefresh} onChange={setAutoRefresh} />
      </SettingsField>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
        <Button label="Cancel" onClick={onClose} />
        <Button primary label={card ? "Save card" : "Add card"} onClick={save} />
      </div>
    </SettingsModal>
  );
}

function WebsiteIcon({ url, favicon }: { url: string; favicon?: string }) {
  const source = favicon || new URL("/favicon.ico", url).href;
  const [failedSource, setFailedSource] = useState<string>();
  return failedSource === source ? (
    <span aria-hidden="true">🌐</span>
  ) : (
    <img
      src={source}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailedSource(source)}
    />
  );
}

export const DashboardPreferences = observer(() => {
  const preferences = DashboardPreferencesStore.getInstanceOrCreate<DashboardPreferencesStore>();
  const [siteIcons, setSiteIcons] = useState<DashboardSiteIcon[]>([]);
  const cardIdentity = JSON.stringify(preferences.cards.map(({ id, url }) => ({ id, url })));
  useEffect(() => {
    let active = true;
    const refreshIcons = () =>
      void ipcRenderer
        .invoke(DASHBOARD_SITE_ICONS)
        .then((icons: DashboardSiteIcon[]) => {
          if (active && Array.isArray(icons)) setSiteIcons(icons);
        })
        .catch(() => {});
    refreshIcons();
    ipcRenderer.on(DASHBOARD_SITE_ICONS, refreshIcons);
    return () => {
      active = false;
      ipcRenderer.removeListener(DASHBOARD_SITE_ICONS, refreshIcons);
    };
  }, [cardIdentity]);
  const [editing, setEditing] = useState<DashboardCard | "new" | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function moveCard(card: DashboardCard, index: number) {
    preferences.moveCard(card.id, index);
    setAnnouncement(
      `${card.title} moved to position ${preferences.cards.findIndex((entry) => entry.id === card.id) + 1}`,
    );
  }

  function finishDrag() {
    setDraggingId(null);
    setDropId(null);
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="power-settings-hint">
        Display websites in responsive dashboard cards. Some websites block embedding.
      </div>
      <style>{`
        .power-dashboard-drag-handle { display: inline-flex; align-items: center; padding: 4px; border: 0; border-radius: 4px; background: transparent; color: var(--textColorSecondary); cursor: grab; flex-shrink: 0; }
        .power-dashboard-drag-handle:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
        .power-dashboard-drag-handle:active { cursor: grabbing; }
      `}</style>
      <div
        role="status"
        aria-live="polite"
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}
      >
        {announcement}
      </div>
      {preferences.cards.map((card, index) => (
        <div
          key={card.id}
          data-dashboard-card-id={card.id}
          onDragOver={(event) => {
            if (!draggingId || draggingId === card.id) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropId(card.id);
          }}
          onDrop={(event) => {
            if (!draggingId) return;
            event.preventDefault();
            const dragged = preferences.cards.find((entry) => entry.id === draggingId);
            if (dragged) moveCard(dragged, index);
            finishDrag();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            minWidth: 0,
            padding: "8px 0",
            borderBottom: "1px solid var(--borderFaintColor)",
            boxShadow:
              dropId === card.id && draggingId !== card.id
                ? `0 ${preferences.cards.findIndex((entry) => entry.id === draggingId) < index ? 2 : -2}px 0 var(--primary)`
                : undefined,
            opacity: draggingId === card.id ? 0.5 : 1,
          }}
        >
          <button
            type="button"
            className="power-dashboard-drag-handle"
            draggable
            aria-label={`Reorder ${card.title}`}
            title="Drag to reorder, or use the Up and Down arrow keys"
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", card.id);
              setDraggingId(card.id);
            }}
            onDragEnd={finishDrag}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              event.stopPropagation();
              moveCard(
                card,
                Math.max(0, Math.min(preferences.cards.length - 1, index + (event.key === "ArrowUp" ? -1 : 1))),
              );
            }}
          >
            <Icon material="drag_indicator" />
          </button>
          <WebsiteIcon
            key={card.url}
            url={card.url}
            favicon={
              siteIcons.find((icon) => icon.id === card.id && icon.pageUrl === normalizeDashboardUrl(card.url))?.dataUrl
            }
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              title={card.title}
              style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {card.title}
            </div>
            <div
              className="power-settings-hint"
              title={card.url}
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 3 }}
            >
              {card.url}
            </div>
          </div>
          <span
            aria-label={`Card size ${card.size.toUpperCase()}`}
            style={{
              flexShrink: 0,
              marginRight: 10,
              padding: "3px 7px",
              border: "1px solid var(--borderFaintColor)",
              borderRadius: 6,
              fontSize: 11,
              fontFamily: "var(--font-monospace, monospace)",
              lineHeight: "18px",
              color: "var(--textColorSecondary)",
            }}
          >
            Size: {card.size.toUpperCase()}
          </span>
          <SettingsIconAction material="edit" label={`Edit ${card.title}`} onClick={() => setEditing(card)} />
          <SettingsIconAction
            material="delete_outline"
            label={`Remove ${card.title}`}
            onClick={() => preferences.removeCard(card.id)}
          />
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button primary label="Add card" onClick={() => setEditing("new")} />
      </div>
      {editing && (
        <CardEditor
          card={editing === "new" ? undefined : editing}
          onSave={(value) => preferences.upsertCard(value)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
});
