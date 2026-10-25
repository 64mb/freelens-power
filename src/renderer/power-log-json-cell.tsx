import { clipboard } from "electron";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { sqlCellLevel } from "../common/power-log-sql-level";
import { LogJson } from "./power-log-json";
import { compactJsonLiteral, jsonHasDuplicateKeys } from "./power-log-json-fields";
import { LogMessage } from "./power-log-message";

import type { JsonFieldFilter } from "../common/power-log-field-filters";
import type { LogCell } from "../common/power-logs";

export function LogJsonCell({
  value,
  column,
  rawValue,
  Icon,
  onFilter,
}: {
  value: string | null;
  message?: boolean;
  column?: string;
  rawValue?: LogCell;
  onFilter?: (filter: JsonFieldFilter) => void;
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
        full: compact,
        fieldsEnabled: !jsonHasDuplicateKeys(value),
      };
    } catch {
      return null;
    }
  }, [value]);
  const [feedback, setFeedback] = useState("");
  useEffect(() => setFeedback(""), [value]);
  if (preview === null) {
    const level = sqlCellLevel(column ?? "", rawValue === undefined ? value : rawValue);
    return (
      <span className="power-logs-cell" title={value ?? "NULL"}>
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
    );
  }
  return (
    <div className="power-logs-cell power-logs-json-cell">
      <LogJson
        text={preview.text}
        fieldText={preview.full}
        fieldsEnabled={preview.fieldsEnabled}
        Icon={Icon}
        onFilter={onFilter}
      />
      <button
        type="button"
        className="power-logs-json-copy"
        aria-label="Copy JSON"
        title={feedback || "Copy JSON"}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          try {
            clipboard.writeText(value!);
            setFeedback("Copied");
          } catch {
            setFeedback("Unable to copy JSON");
          }
        }}
      >
        <Icon material={feedback === "Copied" ? "check" : "content_copy"} size={14} />
      </button>
      <span className="power-logs-json-copy-feedback" role="status" aria-live="polite">
        {feedback}
      </span>
    </div>
  );
}
