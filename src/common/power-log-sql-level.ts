import { structuredLogFields } from "./power-log-level";

import type { LogCell, LogLevel } from "./power-logs";

const levelColumns = new Map(
  [
    "level",
    "severity",
    "loglevel",
    "log_level",
    "levelname",
    "level_name",
    "severityText",
    "severity_text",
    "severityNumber",
    "severity_number",
    "levelno",
    "@l",
    "log.level",
  ].map((key) => [key.toLowerCase(), key]),
);

export function sqlCellLevel(column: string, rawValue: LogCell): LogLevel {
  const key = levelColumns.get(column.toLowerCase());
  return key ? structuredLogFields({ [key]: rawValue }).level : "unknown";
}
