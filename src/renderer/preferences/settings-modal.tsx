import { Renderer } from "@freelensapp/extensions";
import { type ReactNode, useEffect } from "react";

export function SettingsModal({
  id,
  title,
  onClose,
  children,
}: {
  id: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose]);
  return (
    <Renderer.Component.Dialog isOpen close={onClose} modal className="power-dashboard-dialog power-settings-dialog">
      <style>{`
        .Dialog.power-settings-dialog { background: rgb(0 0 0 / 55%); z-index: 12000; }
        .power-settings-dialog > .box { border-radius: 14px; background: var(--mainBackground, #252a2e); border: 1px solid var(--borderFaintColor, #555); box-shadow: 0 20px 70px rgb(0 0 0 / 45%); overflow: visible; }
        .power-settings-dialog .power-ai-prompt { width: 100%; min-height: 120px; padding: 12px; box-sizing: border-box; border: 1px solid var(--borderFaintColor); border-radius: 8px; background: var(--contentColor); color: var(--textColorPrimary); font: inherit; resize: vertical; }
        .power-settings-dialog .power-ai-prompt:focus { outline: 1px solid var(--primary); border-color: var(--primary); }
        @media (max-width: 600px) { .power-settings-dialog .power-settings-row { align-items: stretch !important; flex-direction: column; gap: 8px !important; } .power-settings-dialog .power-settings-row > div { width: 100% !important; } }
      `}</style>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-heading`}
        style={{ display: "grid", gap: 16, padding: 24, width: 560, maxWidth: "calc(100vw - 48px)" }}
      >
        <h2 id={`${id}-heading`} style={{ margin: 0 }}>
          {title}
        </h2>
        {children}
      </div>
    </Renderer.Component.Dialog>
  );
}

export function SettingsField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div
      className="power-settings-row"
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20 }}
    >
      <label htmlFor={id}>{label}</label>
      <div style={{ width: 340, maxWidth: "100%", flexShrink: 0 }}>{children}</div>
    </div>
  );
}
