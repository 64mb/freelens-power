import { extractJsonPath, type JsonPath } from "../common/power-log-field-filters";
import { jsonHasDuplicateKeys } from "./power-log-json-fields";

import type { LogRecord } from "../common/power-logs";

export function logColumnLabel(path: JsonPath): string {
  return `$${path.map((part) => `[${typeof part === "number" ? part : JSON.stringify(part)}]`).join("")}`;
}

const previewLength = 256;

function preview(value: unknown): string {
  if (typeof value === "string") return value ? truncate(value) : '""';
  let nodes = 0;
  let result = "";
  let stopped = false;
  function append(text: string) {
    if (result.length + text.length > previewLength) stopped = true;
    result += text.slice(0, previewLength - result.length);
  }
  function visit(current: unknown, depth: number): void {
    if (stopped) return;
    if (++nodes > 64 || depth > 6) {
      append("…");
      return;
    }
    if (current === null || typeof current !== "object") {
      append(JSON.stringify(typeof current === "string" ? current.slice(0, previewLength + 1) : current));
      return;
    }
    const array = Array.isArray(current);
    append(array ? "[" : "{");
    let count = 0;
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      if (stopped) break;
      if (count++) append(",");
      if (nodes >= 64) {
        append("…");
        break;
      }
      if (!array) {
        append(JSON.stringify(key.slice(0, previewLength + 1)));
        append(":");
      }
      visit(Object.getOwnPropertyDescriptor(current, key)!.value, depth + 1);
    }
    if (!stopped) append(array ? "]" : "}");
  }
  visit(value, 0);
  return stopped ? `${result.slice(0, previewLength - 1)}…` : result;
}

function truncate(text: string): string {
  return text.length > previewLength ? `${text.slice(0, previewLength - 1)}…` : text;
}

export function createLogColumnReader(): (record: LogRecord, path: JsonPath) => string {
  const parsedRecords = new WeakMap<LogRecord, { value: unknown }>();
  return (record, path) => {
    let parsed = parsedRecords.get(record);
    if (!parsed) {
      parsed = { value: undefined };
      const source = record.fieldsJson;
      if (source && !jsonHasDuplicateKeys(source)) {
        try {
          parsed.value = JSON.parse(source);
        } catch {
          // invalid or truncated records have no selectable fields
        }
      }
      parsedRecords.set(record, parsed);
    }
    const result = extractJsonPath(parsed.value, path);
    if (!result.found || result.value === undefined) return "—";
    if (typeof result.value === "number" && !Number.isFinite(result.value)) return "—";
    return preview(result.value);
  };
}
