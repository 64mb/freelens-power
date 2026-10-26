import { clipboard } from "electron";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { formatDateTime } from "../common/date-time";
import { sqlCellLevel } from "../common/power-log-sql-level";
import { NativeTooltip } from "./native-tooltip";
import { LogJson } from "./power-log-json";
import { compactJsonLiteral, formatJsonLiteral } from "./power-log-json-fields";
import { LogMessage } from "./power-log-message";

import type { LogCell } from "../common/power-logs";

export function LogJsonCell({
  value,
  column,
  rawValue,
  Icon,
}: {
  value: string | null;
  message?: boolean;
  column?: string;
  rawValue?: LogCell;
  Icon: ComponentType<{ material: string; size?: number }>;
}) {
  const preview = useMemo(() => {
    if (value === null || !/^[\s]*[\[{]/.test(value)) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object") return null;
      const compact = compactJsonLiteral(value);
      return {
        text: compact.length > 2048 ? `${compact.slice(0, 2048)}…` : compact,
      };
    } catch {
      return null;
    }
  }, [value]);
  const [feedback, setFeedback] = useState("");
  useEffect(() => setFeedback(""), [value]);
  if (
    (column?.toLowerCase() === "timestamp" || column?.toLowerCase() === "minute") &&
    typeof rawValue === "number" &&
    Number.isFinite(new Date(rawValue).getTime())
  ) {
    const formatted = formatDateTime(rawValue);
    return (
      <NativeTooltip title={`${formatted} · ${rawValue}`}>
        <span className="power-logs-cell">
          {column?.toLowerCase() === "minute" ? formatted.slice(0, -3) : formatted.slice(-8)}
        </span>
      </NativeTooltip>
    );
  }
  if (preview === null) {
    const level = sqlCellLevel(column ?? "", rawValue === undefined ? value : rawValue);
    return (
      <NativeTooltip title={value ?? "NULL"}>
        <span className="power-logs-cell">
          {value === null ? (
            "NULL"
          ) : level !== "unknown" ? (
            <span className="power-logs-level-label" data-level={level}>
              {typeof rawValue === "number" ? value : value.toUpperCase()}
            </span>
          ) : (
            <LogMessage text={value} />
          )}
        </span>
      </NativeTooltip>
    );
  }
  return (
    <div className="power-logs-cell power-logs-json-cell">
      <LogJson text={preview.text} />
      <NativeTooltip title={feedback || "Copy JSON"}>
        <button
          type="button"
          className="power-logs-json-copy"
          aria-label="Copy JSON"
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            try {
              clipboard.writeText(formatJsonLiteral(value!));
              setFeedback("Copied");
            } catch {
              setFeedback("Unable to copy JSON");
            }
          }}
        >
          <Icon material={feedback === "Copied" ? "check" : "content_copy"} size={14} />
        </button>
      </NativeTooltip>
      <span className="power-logs-json-copy-feedback" role="status" aria-live="polite">
        {feedback}
      </span>
    </div>
  );
}
