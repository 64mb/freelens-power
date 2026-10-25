import { clipboard } from "electron";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";
import { type JsonField, jsonFieldLiteral, jsonFields, maxJsonTokens } from "./power-log-json-fields";

import type { JsonFieldFilter } from "../common/power-log-field-filters";

export interface LogJsonProps {
  text: string;
  fieldText?: string;
  fieldsEnabled?: boolean;
  Icon?: ComponentType<{ material: string; size?: number }>;
  onFilter?: (filter: JsonFieldFilter) => void;
}

export function LogJson({ text, fieldText, fieldsEnabled = true, Icon, onFilter }: LogJsonProps) {
  const identity = fieldText ?? text;
  const interactive = fieldsEnabled && Boolean(Icon || onFilter);
  const fields = useMemo(
    () => (interactive ? jsonFields(identity) : new Map<number, JsonField>()),
    [identity, interactive],
  );
  const [active, setActive] = useState<{ field: JsonField; text: string; x: number; y: number }>();
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
        const rect = element.getBoundingClientRect();
        setActive({
          field,
          text: identity,
          x: Math.max(4, Math.min(rect.left, window.innerWidth - 250)),
          y: Math.max(4, Math.min(rect.bottom, window.innerHeight - 40)),
        });
        setFeedback("");
      };
      tokens.push(
        <span
          key={start}
          data-token={kind}
          tabIndex={field ? 0 : undefined}
          onMouseEnter={field ? (event) => activate(event.currentTarget) : undefined}
          onFocus={field ? (event) => activate(event.currentTarget) : undefined}
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
      onMouseLeave={() => setActive(undefined)}
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
            gap: 4,
            padding: 4,
            background: "var(--mainBackground, #252525)",
            border: "1px solid var(--borderColor, #666)",
            borderRadius: 4,
          }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") setActive(undefined);
          }}
        >
          <button
            type="button"
            title="Copy value"
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
            {Icon ? <Icon material="content_copy" size={14} /> : "⧉"}
          </button>
          {onFilter && (
            <>
              <button
                type="button"
                title="Include value"
                aria-label="Include value"
                onClick={() => onFilter({ path: selected.field.path, value: selected.field.value, operator: "eq" })}
              >
                =
              </button>
              <button
                type="button"
                title="Exclude value"
                aria-label="Exclude value"
                onClick={() => onFilter({ path: selected.field.path, value: selected.field.value, operator: "neq" })}
              >
                !=
              </button>
            </>
          )}
          {feedback && <span role="status">{feedback}</span>}
        </div>
      )}
    </div>
  );
}
