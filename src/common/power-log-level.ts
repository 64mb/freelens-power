import type { LogLevel } from "./power-logs";

const names: Record<string, LogLevel> = {
  trace: "trace",
  verbose: "trace",
  vrb: "trace",
  trc: "trace",
  trce: "trace",
  fine: "debug",
  finer: "trace",
  finest: "trace",
  debug: "debug",
  dbg: "debug",
  dbug: "debug",
  info: "info",
  information: "info",
  informational: "info",
  notice: "info",
  inf: "info",
  success: "info",
  warn: "warn",
  warning: "warn",
  wrn: "warn",
  error: "error",
  err: "error",
  severe: "error",
  fail: "error",
  dpanic: "error",
  fatal: "fatal",
  critical: "fatal",
  crit: "fatal",
  ftl: "fatal",
  panic: "fatal",
  alert: "fatal",
  emerg: "fatal",
  emergency: "fatal",
};
const pino: Record<number, LogLevel> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
const python: Record<number, LogLevel> = { 10: "debug", 20: "info", 30: "warn", 40: "error", 50: "fatal" };
const oldKeys = ["level", "severity", "loglevel", "log_level", "levelname"];
const textKeys = [
  "level_name",
  "Level",
  "LogLevel",
  "severityText",
  "severity_text",
  "SeverityText",
  "log.level",
  "@l",
];
const numberKeys = ["severityNumber", "severity_number", "SeverityNumber"];

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function named(value: unknown): LogLevel {
  if (typeof value !== "string") return "unknown";
  const key = value.trim().toLowerCase();
  return Object.hasOwn(names, key) ? names[key] : "unknown";
}
function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}
function ownValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
}

export function structuredLogFields(record: Record<string, unknown>): { level: LogLevel; message?: string } {
  const nested = object(record.record);
  const loguruLevel = object(nested?.level);
  if (typeof record.text === "string" && nested && loguruLevel) {
    const level =
      typeof loguruLevel.name === "string"
        ? named(loguruLevel.name)
        : typeof loguruLevel.no === "number"
          ? (({ 5: "trace", ...python, 25: "info" } as Record<number, LogLevel>)[loguruLevel.no] ?? "unknown")
          : "unknown";
    return { level, message: firstString(nested.message, record.text) };
  }
  const primary = ownValue(record, oldKeys);
  const explicit =
    ownValue(record, textKeys) ??
    oldKeys
      .slice(1)
      .map((key) => record[key])
      .find((value) => typeof value === "string") ??
    object(record.log)?.level;
  let level: LogLevel = "unknown";
  if (typeof primary === "string") level = named(primary);
  else if (explicit !== undefined) level = named(explicit);
  else if (numberKeys.some((key) => record[key] !== undefined)) {
    const value = ownValue(record, numberKeys);
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 24)
      level = (["trace", "debug", "info", "warn", "error", "fatal"] as LogLevel[])[Math.floor((value - 1) / 4)];
  } else if (record.levelno !== undefined) {
    if (typeof record.levelno === "number") level = python[record.levelno] ?? "unknown";
  } else if (typeof record.level === "number") level = pino[record.level] ?? "unknown";
  else if (typeof record["@t"] === "string" && (typeof record["@m"] === "string" || typeof record["@mt"] === "string"))
    level = "info";
  const body = record.body ?? record.Body;
  return {
    level,
    message: firstString(
      record.message,
      record.msg,
      record.text,
      record.Message,
      record.RenderedMessage,
      record["@m"],
      record["@mt"],
      object(record.fields)?.message,
      numberKeys.some((key) => record[key] !== undefined) ||
        ["severityText", "severity_text", "SeverityText"].some((key) => record[key] !== undefined)
        ? typeof body === "string"
          ? body
          : object(body)?.stringValue
        : undefined,
    ),
  };
}

export function plainLogLevel(message: string): LogLevel {
  const klog = /^([IWEF])\d{4}\s\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+[^\s]+:\d+\]/.exec(message);
  if (klog) return ({ I: "info", W: "warn", E: "error", F: "fatal" } as Record<string, LogLevel>)[klog[1]];
  const syslog = /^<(\d{1,3})>(?=\d{1,2}\s|[A-Z][a-z]{2} \d)/.exec(message);
  if (syslog && Number(syslog[1]) <= 191)
    return (["fatal", "fatal", "fatal", "error", "warn", "info", "info", "debug"] as LogLevel[])[Number(syslog[1]) % 8];
  const field = /\s*([A-Za-z_][A-Za-z0-9_.]*)=("(?:\\.|[^"\\])*"|[^"\s]+)(?=\s|$)/y;
  let cursor = 0;
  for (let count = 0; count < 256; count++) {
    field.lastIndex = cursor;
    const match = field.exec(message);
    if (!match) break;
    cursor = field.lastIndex;
    if ([...oldKeys, ...textKeys].includes(match[1])) {
      try {
        return named(match[2].startsWith('"') ? JSON.parse(match[2]) : match[2]);
      } catch {
        return "unknown";
      }
    }
  }
  const header =
    /^\s*(\[)?(?:(\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?)\s*[| ]\s*)?([A-Za-z]+)(?=$|[\s\]:|,-])/.exec(
      message,
    );
  if (!header) return "unknown";
  const word = header[3];
  const delimiter = message.slice(header[0].length).trimStart()[0];
  if (!header[1] && !header[2] && word !== word.toUpperCase() && delimiter !== ":") return "unknown";
  return named(word);
}
