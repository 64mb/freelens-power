import { isIP } from "node:net";

export interface LogMessageToken {
  start: number;
  end: number;
  kind: "http-method" | "uuid" | "url" | "trace-id" | "address" | "http-status" | "duration";
  statusClass?: string;
}

const identifier = /[\p{L}\p{N}_]/u;
const candidate =
  /(?<![\p{L}\p{N}_.])(?:https?:\/\/[^\s<>"']+|(?:trace_id|traceId|span_id|spanId|traceparent|ip|client_ip|remote_addr|clientIp|remoteAddr|http_status|status_code|statusCode|http\.status_code|http\.response\.status_code)["']?\s*[:=]\s*["']?[^\s,"'<>]+|HTTP\/\d(?:\.\d)?\s+\d+|\[[\da-fA-F:.]+\]:\d+|\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}|[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}|(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)|\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|s))/gu;

function validAddress(value: string): boolean {
  const socket = /^(?:\[([^\]]+)\]|(\d+(?:\.\d+){3})):(\d+)$/.exec(value);
  return socket
    ? isIP(socket[1] ?? socket[2]) === (socket[1] ? 6 : 4) && Number(socket[3]) <= 65535
    : isIP(value) !== 0;
}

export function messageTokens(text: string): LogMessageToken[] {
  const tokens: LogMessageToken[] = [];
  // cap scanning as well as output nodes for oversized records
  const limit = Math.min(text.length, 65536);
  const input = text.slice(0, limit);
  for (const match of input.matchAll(candidate)) {
    let value = match[0];
    let start = match.index!;
    const end = start + value.length;
    if (identifier.test(text[start - 1] ?? "") || identifier.test(text[end] ?? "")) continue;
    let kind: LogMessageToken["kind"] | undefined;
    if (value.startsWith("http://") || value.startsWith("https://")) {
      // URLs remain opaque even when validation fails
      if (value.length <= 4096 && !/[.,;!?)]$/.test(value)) {
        try {
          const url = new URL(value);
          if (url.hostname) kind = "url";
        } catch {
          /* invalid URLs stay plain */
        }
      }
    } else {
      const label = /^(.*?)['"]?\s*[:=]\s*['"]?(.*)$/.exec(value);
      if (label && !value.startsWith("[") && !/^\d/.test(value)) {
        const name = label[1].replace(/["']$/, "");
        value = label[2];
        start = end - value.length;
        if (/^(trace_id|traceId|span_id|spanId)$/.test(name)) {
          const size = name.startsWith("span") ? 16 : 32;
          if (new RegExp(`^[a-fA-F0-9]{${size}}$`).test(value) && /[1-9a-f]/i.test(value)) kind = "trace-id";
        } else if (name === "traceparent") {
          // version [00] follows W3C Trace Context's lowercase and nonzero ID rules
          const trace = /^00-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec(value);
          if (trace && /[1-9a-f]/.test(trace[1]) && /[1-9a-f]/.test(trace[2])) kind = "trace-id";
        } else if (/^(ip|client_ip|remote_addr|clientIp|remoteAddr)$/.test(name)) {
          if (validAddress(value)) kind = "address";
        } else if (/^[1-5]\d{2}$/.test(value)) kind = "http-status";
      } else if (value.startsWith("HTTP/")) {
        value = /\d+$/.exec(value)![0];
        start = end - value.length;
        if (/^[1-5]\d{2}$/.test(value)) kind = "http-status";
      } else if (validAddress(value)) kind = "address";
      else if (/^[\da-fA-F]{8}-/.test(value)) kind = "uuid";
      else if (/^[A-Z]+$/.test(value)) kind = "http-method";
      else if (
        /^\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|s)$/.test(value) &&
        Number.parseFloat(value) > 0 &&
        !/[.\-+]/.test(text[start - 1] ?? "")
      )
        kind = "duration";
    }
    if (kind) tokens.push({ start, end, kind, ...(kind === "http-status" ? { statusClass: value[0] } : {}) });
    if (tokens.length === 80) break;
  }
  return tokens;
}
