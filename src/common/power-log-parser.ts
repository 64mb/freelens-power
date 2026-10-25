import { plainLogLevel, structuredLogFields } from "./power-log-level";
import { type LogLevel, type LogRecord, type LogSource, POWER_LOGS_LIMITS } from "./power-logs";

const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
export function parseLogLine(line: string, source: LogSource): LogRecord {
  let message = line.replace(ansi, "").replace(/\r$/, "").replace(/\x00/g, "");
  let timestamp: number | null = null;
  const prefix = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d))\s/.exec(message);
  if (prefix) {
    const value = Date.parse(prefix[1]);
    if (Number.isFinite(value)) timestamp = value;
    message = message.slice(prefix[0].length);
  }
  let fieldsJson: string | null = null;
  let level: LogLevel = "unknown";
  let structured = false;
  try {
    const fields: unknown = JSON.parse(message);
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      const object = fields as Record<string, unknown>;
      structured = true;
      const extracted = structuredLogFields(object);
      level = extracted.level;
      if (extracted.message !== undefined) message = extracted.message.replace(ansi, "").replace(/\x00/g, "");
      const serialized = JSON.stringify(fields);
      if (Buffer.byteLength(serialized) <= POWER_LOGS_LIMITS.recordBytes / 2) fieldsJson = serialized;
    }
  } catch {
    /* malformed structured lines remain plain text */
  }
  if (!structured) level = plainLogLevel(message);
  const record: LogRecord = {
    timestamp,
    pod: source.pod,
    podUid: source.podUid,
    container: source.container,
    level,
    message,
    fieldsJson,
    previous: source.previous === true,
  };
  const serializedBytes = () => Buffer.byteLength(JSON.stringify(record));
  if (serializedBytes() > POWER_LOGS_LIMITS.recordBytes && record.fieldsJson !== null) {
    record.fieldsJson = null;
    record.message += " [structured fields omitted]";
  }
  if (serializedBytes() > POWER_LOGS_LIMITS.recordBytes) {
    const characters = Array.from(record.message);
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      record.message = `${characters.slice(0, middle).join("")} [truncated]`;
      if (serializedBytes() <= POWER_LOGS_LIMITS.recordBytes) low = middle;
      else high = middle - 1;
    }
    record.message = `${characters.slice(0, low).join("")} [truncated]`;
  }
  return record;
}

export class LogLineDecoder {
  private decoder = new TextDecoder();
  private pending = "";
  private dropping = false;
  truncated = false;
  push(chunk: Uint8Array | string, final = false): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: !final });
    const lines: string[] = [];
    for (const part of text.split(/(?<=\n)/)) {
      const ended = part.endsWith("\n");
      if (!this.dropping) this.pending += part;
      if (Buffer.byteLength(this.pending) > POWER_LOGS_LIMITS.recordBytes) {
        this.pending = "";
        this.dropping = true;
        this.truncated = true;
      }
      if (ended) {
        if (!this.dropping) lines.push(this.pending.replace(/\r?\n$/, ""));
        this.pending = "";
        this.dropping = false;
      }
    }
    if (final && this.pending && !this.dropping) {
      lines.push(this.pending);
      this.pending = "";
    }
    return lines;
  }
}
