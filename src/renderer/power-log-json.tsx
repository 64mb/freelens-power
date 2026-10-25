import { clipboard } from "electron";
import { type ComponentType, type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type JsonField, jsonFieldLiteral, jsonFields, maxJsonTokens } from "./power-log-json-fields";

import type { JsonFieldFilter } from "../common/power-log-field-filters";

export interface LogJsonProps {
  text: string;
  fieldText?: string;
  fieldsEnabled?: boolean;
  Icon?: ComponentType<{ material: string; size?: number; tooltip?: string }>;
  onFilter?: (filter: JsonFieldFilter) => void;
}

const fieldButtonStyle: CSSProperties = {
  width: 20,
  height: 20,
  minHeight: 0,
  minWidth: 0,
  padding: 0,
  margin: 0,
  border: 0,
  borderRadius: 0,
  background: "transparent",
  color: "inherit",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

export function LogJson({ text, fieldText, fieldsEnabled = true, Icon, onFilter }: LogJsonProps) {
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const keepOpen = () => {
    clearTimeout(leaveTimer.current);
    clearTimeout(hoverTimer.current);
  };
  useEffect(
    () => () => {
      clearTimeout(leaveTimer.current);
      clearTimeout(hoverTimer.current);
    },
    [],
  );
  const identity = fieldText ?? text;
  const interactive = fieldsEnabled && Boolean(Icon || onFilter);
  const fields = useMemo(
    () => (interactive ? jsonFields(identity) : new Map<number, JsonField>()),
    [identity, interactive],
  );
  const [active, setActive] = useState<{ field: JsonField; text: string; x: number; y: number }>();
  const activeField = useRef(active);
  activeField.current = active;
  const [feedback, setFeedback] = useState("");
  const selected = fieldsEnabled && active?.text === identity ? active : undefined;
  const tokens = useMemo(() => {
    const tokens: ReactNode[] = [];
    const pattern = /"(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\[{]/g;
    let cursor = 0;
    let count = 0;
    for (const match of text.matchAll(pattern)) {
      if (++count > maxJsonTokens) break;
      const start = match.index!;
      tokens.push(text.slice(cursor, start));
      const value = match[0];
      const key = value.startsWith('"') && value.endsWith(":");
      const kind = key
        ? "key"
        : value.startsWith('"')
          ? "string"
          : /^(true|false|null)$/.test(value)
            ? "literal"
            : /^[\[{]$/.test(value)
              ? undefined
              : "number";
      const field = fields.get(start);
      const activate = (element: HTMLElement) => {
        if (!field) return;
        clearTimeout(leaveTimer.current);
        const rect = element.getBoundingClientRect();
        let lineRight = rect.right;
        const pre = element.closest("pre");
        if (pre) {
          const lineEnd = text.indexOf("\n", start);
          let remaining = lineEnd < 0 ? text.length : lineEnd;
          const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (remaining > (node.textContent?.length ?? 0)) {
              remaining -= node.textContent?.length ?? 0;
              continue;
            }
            const range = document.createRange();
            range.setStart(element, 0);
            range.setEnd(node, remaining);
            if (typeof range.getClientRects === "function") {
              for (const fragment of Array.from(range.getClientRects())) {
                if (Math.abs(fragment.top - rect.top) < Math.max(1, rect.height / 2)) {
                  lineRight = Math.max(lineRight, fragment.right);
                }
              }
            }
            break;
          }
        }
        const wrapperRight = element.closest(".power-log-json-fields")?.getBoundingClientRect().right;
        const visibleRight = Math.min(
          window.innerWidth,
          wrapperRight && wrapperRight > 0 ? wrapperRight : window.innerWidth,
        );
        setActive({
          field,
          text: identity,
          x: Math.max(4, Math.min(lineRight + 4, visibleRight - 64)),
          y: Math.max(0, Math.min(rect.top, window.innerHeight - 20)),
        });
        setFeedback("");
      };
      tokens.push(
        <span
          key={start}
          data-token={kind}
          tabIndex={field ? 0 : undefined}
          onMouseEnter={
            field
              ? (event) => {
                  keepOpen();
                  const element = event.currentTarget;
                  if (activeField.current?.text === identity && activeField.current.field !== field) {
                    hoverTimer.current = setTimeout(() => activate(element), 180);
                  } else activate(element);
                }
              : undefined
          }
          onMouseLeave={field ? () => clearTimeout(hoverTimer.current) : undefined}
          onFocus={
            field
              ? (event) => {
                  keepOpen();
                  activate(event.currentTarget);
                }
              : undefined
          }
          onKeyDown={
            field
              ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    event.currentTarget
                      .closest(".power-log-json-fields")
                      ?.querySelector<HTMLButtonElement>('[role="toolbar"] button')
                      ?.focus();
                  }
                }
              : undefined
          }
        >
          {key ? value.slice(0, -1) : value}
        </span>,
      );
      if (key) tokens.push(":");
      cursor = start + value.length;
    }
    tokens.push(text.slice(cursor));
    return tokens;
  }, [text, fields, identity]);
  const pre = <pre className="power-log-json">{tokens}</pre>;
  if (!Icon && !onFilter) return pre;
  return (
    <div
      className="power-log-json-fields"
      style={{ paddingRight: 76 }}
      onMouseEnter={keepOpen}
      onMouseLeave={() => {
        leaveTimer.current = setTimeout(() => setActive(undefined), 150);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setActive(undefined);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setActive(undefined);
        }
      }}
    >
      {pre}
      {selected && (
        <div
          role="toolbar"
          aria-label="JSON field actions"
          style={{
            position: "fixed",
            left: selected.x,
            top: selected.y,
            zIndex: 1000,
            display: "flex",
            gap: 2,
            padding: 0,
            background: "transparent",
            border: 0,
            alignItems: "center",
            height: 20,
          }}
          onMouseEnter={keepOpen}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") setActive(undefined);
          }}
        >
          <button
            type="button"
            style={fieldButtonStyle}
            title={Icon ? undefined : "Copy value"}
            aria-label="Copy value"
            onClick={() => {
              try {
                const value = selected.field.value;
                clipboard.writeText(typeof value === "string" ? value : jsonFieldLiteral(identity, selected.field));
                setFeedback("Copied");
              } catch {
                setFeedback("Copy failed");
              }
            }}
          >
            {Icon ? <Icon material="content_copy" size={14} tooltip="Copy value" /> : "⧉"}
          </button>
          {onFilter && (
            <>
              <button
                type="button"
                style={fieldButtonStyle}
                title={Icon ? undefined : "Include value"}
                aria-label="Include value"
                onClick={() => onFilter({ path: selected.field.path, value: selected.field.value, operator: "eq" })}
              >
                {Icon ? <Icon material="filter_alt" size={14} tooltip="Include value" /> : "="}
              </button>
              <button
                type="button"
                style={fieldButtonStyle}
                title={Icon ? undefined : "Exclude value"}
                aria-label="Exclude value"
                onClick={() => onFilter({ path: selected.field.path, value: selected.field.value, operator: "neq" })}
              >
                {Icon ? <Icon material="filter_alt_off" size={14} tooltip="Exclude value" /> : "!="}
              </button>
            </>
          )}
          {feedback && (
            <span role="status" style={{ position: "absolute", top: 22, right: 0, whiteSpace: "nowrap" }}>
              {feedback}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
