import { extractJsonPath, type JsonPath } from "../common/power-log-field-filters";
import { jsonHasDuplicateKeys } from "./power-log-json-fields";

import type { LogRecord } from "../common/power-logs";

export function logColumnLabel(path: JsonPath): string {
  return `$${path.map((part) => `[${typeof part === "number" ? part : JSON.stringify(part)}]`).join("")}`;
}

function suffixName(path: JsonPath, depth: number): string {
  if (!path.length) return "$";
  const suffix = path.slice(-depth);
  if (suffix.length === 1) return typeof suffix[0] === "number" ? `[${suffix[0]}]` : suffix[0] || '\"\"';
  return suffix
    .map((part, index) => {
      if (typeof part === "number") return `[${part}]`;
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) return `${index ? "." : ""}${part}`;
      return `[${JSON.stringify(part)}]`;
    })
    .join("");
}

export function logColumnNames(paths: readonly JsonPath[]): string[] {
  const depths = paths.map(() => 1);
  for (let left = 0; left < paths.length; left++) {
    for (let right = left + 1; right < paths.length; right++) {
      let shared = 0;
      while (
        shared < Math.min(paths[left].length, paths[right].length) &&
        paths[left].at(-shared - 1) === paths[right].at(-shared - 1)
      )
        shared++;
      if (!shared) continue;
      depths[left] = Math.max(depths[left], Math.min(paths[left].length, shared + 1));
      depths[right] = Math.max(depths[right], Math.min(paths[right].length, shared + 1));
    }
  }
  const canonical = new Set<number>();
  let names = paths.map((path, index) => suffixName(path, depths[index]));
  for (;;) {
    const groups = new Map<string, number[]>();
    names.forEach((name, index) => groups.set(name, [...(groups.get(name) ?? []), index]));
    let changed = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const canExtend =
        group.every((index) => !canonical.has(index)) && group.some((index) => depths[index] < paths[index].length);
      for (const index of group) {
        if (canExtend) depths[index]++;
        else canonical.add(index);
        const next = canonical.has(index) ? logColumnLabel(paths[index]) : suffixName(paths[index], depths[index]);
        if (next !== names[index]) changed = true;
        names[index] = next;
      }
    }
    if (!changed) return names;
  }
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
