import { boundedAiJson } from "./ai-attachments";
import { redactAiTerminalText } from "./ai-terminal-context";

import type { LogCapture, LogQueryResult, LogRecord, LogTarget } from "./power-logs";

function project(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested content omitted]";
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && (typeof parsed === "object" || typeof parsed === "string"))
        return project(parsed, depth + 1);
    } catch {
      /* plain text uses the shared redactor */
    }
    return redactAiTerminalText(value);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => project(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [key, project(item, depth + 1)]),
    );
  return value;
}

export function powerLogLineEvidence(target: LogTarget | undefined, record: LogRecord): string {
  const { timestamp, pod, podUid, container, level, message, fieldsJson, previous } = record;
  return boundedAiJson(
    project({
      observedAt: new Date().toISOString(),
      target,
      line: { timestamp, pod, podUid, container, level, message, fieldsJson, previous },
    }),
    6000,
  );
}

export function powerLogQueryEvidence(capture: LogCapture, sql: string, result: LogQueryResult): string {
  const rows = result.rows.slice(0, 30).map((row) =>
    row.map((value, index) => ({
      column: result.columns[index],
      value: value,
    })),
  );
  return boundedAiJson(
    project({
      observedAt: new Date().toISOString(),
      capture: { target: capture.target, createdAt: capture.createdAt, state: capture.state, notes: capture.notes },
      ...(result.error ? { state: "Query failed", error: result.error } : {}),
      sql,
      rows,
      truncated: result.truncated || result.rows.length > 30,
    }),
    6000,
  );
}
