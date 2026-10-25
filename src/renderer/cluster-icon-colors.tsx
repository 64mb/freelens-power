import { useEffect, useRef, useState } from "react";
import { ACCENT_COLOR_OPTIONS } from "../common/store/appearance-preferences-store";
import { NativeTooltip } from "./native-tooltip";

export const MATCHING_ICON_COLORS = [
  { name: "Lavender", color: "#b49aff" },
  { name: "Sky", color: "#64c9ff" },
  { name: "Mint", color: "#6bdbb1" },
  { name: "Amber", color: "#f2bd55" },
  { name: "Coral", color: "#ef7070" },
  { name: "Rose", color: "#e59cce" },
  { name: "Slate", color: "#9da7c2" },
  { name: "Cyan", color: "#78dce8" },
];

// material design 2014 primary palette, shade [500]: https://m1.material.io/style/color.html
const materialColors = [
  ["Red", "#f44336"],
  ["Pink", "#e91e63"],
  ["Purple", "#9c27b0"],
  ["Deep purple", "#673ab7"],
  ["Indigo", "#3f51b5"],
  ["Blue", "#2196f3"],
  ["Light blue", "#03a9f4"],
  ["Cyan", "#00bcd4"],
  ["Teal", "#009688"],
  ["Green", "#4caf50"],
  ["Light green", "#8bc34a"],
  ["Lime", "#cddc39"],
  ["Yellow", "#ffeb3b"],
  ["Amber", "#ffc107"],
  ["Orange", "#ff9800"],
  ["Deep orange", "#ff5722"],
  ["Brown", "#795548"],
  ["Grey", "#9e9e9e"],
  ["Blue grey", "#607d8b"],
].map(([name, color]) => ({ name, color }));

const materialHexes = new Set(materialColors.map(({ color }) => color));

const groups = [
  { name: "Power", colors: MATCHING_ICON_COLORS },
  {
    name: "Freelens",
    colors: ACCENT_COLOR_OPTIONS.filter(({ color }) => !materialHexes.has(color.toLowerCase())).map(
      ({ label, color }) => ({
        name: label,
        color,
      }),
    ),
  },
  { name: "Material", colors: materialColors },
];

const styles = `
.power-icon-palette { position: relative; }
.power-icon-palette button { font: inherit; cursor: pointer; }
.power-icon-palette button:disabled { cursor: default; opacity: .5; }
.power-icon-palette button:focus-visible, .power-icon-palette input:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.power-icon-palette-trigger { display: flex; align-items: center; gap: 9px; padding: 5px 7px; border: 1px solid var(--borderFaintColor); border-radius: 7px; background: var(--contentColor); color: var(--textColorSecondary); }
.power-icon-palette-trigger code { font: 11px var(--font-monospace,monospace); }
.power-icon-palette-well { width: 22px; height: 22px; border-radius: 5px; border: 1px solid rgb(255 255 255 / 15%); }
.power-icon-palette-panel { position: absolute; z-index: 4; right: 0; top: calc(100% + 7px); box-sizing: border-box; width: 280px; max-width: calc(100vw - 72px); padding: 14px; border: 1px solid var(--borderFaintColor); border-radius: 11px; background: var(--mainBackground); color: var(--textColorPrimary); box-shadow: 0 12px 36px rgb(0 0 0 / 35%); display: grid; gap: 14px; }
.power-icon-palette-heading { font-size: 11px; color: var(--textColorSecondary); margin-bottom: 8px; }
.power-icon-palette-grid { display: grid; grid-template-columns: repeat(8,minmax(0,1fr)); gap: 6px; }
.power-icon-palette-swatch { width: 100%; max-width: 23px; height: auto; aspect-ratio: 1; min-width: 0; padding: 0; border: 1px solid rgb(255 255 255 / 18%); border-radius: 6px; }
.power-icon-palette-swatch[aria-pressed=true] { outline: 2px solid var(--textColorPrimary); outline-offset: 2px; }
`;

export function IconColorPicker({
  label,
  value,
  onChange,
  disabled = false,
  onOpenChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const notify = useRef(onOpenChange);
  notify.current = onOpenChange;
  const changeOpen = (next: boolean) => {
    notify.current?.(next);
    setOpen(next);
  };
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>(".power-icon-palette-swatch")?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) changeOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      changeOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  useEffect(() => () => notify.current?.(false), []);
  useEffect(() => {
    if (disabled) changeOpen(false);
  }, [disabled]);
  const choose = (hex: string) => {
    if (disabled || !/^#[\da-f]{6}$/i.test(hex)) return;
    onChange(hex.toLowerCase());
    changeOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="power-icon-palette" ref={root}>
      <style>{styles}</style>
      <button
        ref={trigger}
        type="button"
        className="power-icon-palette-trigger"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => changeOpen(!open)}
      >
        <code>{value}</code>
        <span className="power-icon-palette-well" style={{ backgroundColor: value }} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="power-icon-palette-panel"
          role="group"
          aria-label={`${label} palette`}
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) changeOpen(false);
          }}
        >
          {groups.map((group) => (
            <div key={group.name} role="group" aria-label={group.name}>
              <div className="power-icon-palette-heading">{group.name}</div>
              <div className="power-icon-palette-grid">
                {group.colors.map((color) => (
                  <NativeTooltip key={color.name} title={`${color.name} ${color.color}`}>
                    <button
                      type="button"
                      className="power-icon-palette-swatch"
                      style={{ backgroundColor: color.color }}
                      aria-label={`${group.name} ${color.name} ${color.color}`}
                      aria-pressed={value.toLowerCase() === color.color}
                      onClick={() => choose(color.color)}
                    />
                  </NativeTooltip>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
