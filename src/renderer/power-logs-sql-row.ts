import type { LogCell, LogLevel, LogRecord } from "../common/power-logs";

const levels = new Set<LogLevel>(["trace", "debug", "info", "warn", "error", "fatal", "unknown"]);

export function sqlRowDetails(columns: string[], row: LogCell[]): { record: LogRecord; jsonColumn?: string } {
  const cells = new Map(columns.map((column, index) => [column, row[index]]));
  const stringCell = (name: string) => (typeof cells.get(name) === "string" ? (cells.get(name) as string) : "");
  let fieldsJson: string | null = null;
  let jsonColumn: string | undefined;
  let largestBytes = -1;
  const encoder = new TextEncoder();
  columns.forEach((column, index) => {
    const value = row[index];
    if (typeof value !== "string") return;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null || typeof parsed !== "object") return;
      const bytes = encoder.encode(value).byteLength;
      if (bytes > largestBytes) {
        largestBytes = bytes;
        fieldsJson = value;
        jsonColumn = column;
      }
    } catch {
      // malformed JSON remains available in the row fallback
    }
  });
  const timestamp = cells.get("timestamp");
  const level = stringCell("level");
  const previous = cells.get("previous");
  return {
    record: {
      timestamp: typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null,
      pod: stringCell("pod"),
      podUid: stringCell("podUid"),
      container: stringCell("container"),
      level: levels.has(level as LogLevel) ? (level as LogLevel) : "unknown",
      message:
        fieldsJson === null
          ? JSON.stringify(Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null])), null, 2)
          : stringCell("message"),
      fieldsJson,
      previous: previous === true || previous === 1,
    },
    ...(jsonColumn === undefined ? {} : { jsonColumn }),
  };
}
