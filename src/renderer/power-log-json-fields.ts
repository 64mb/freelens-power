import { extractJsonPath, type JSONValue, type JsonPath } from "../common/power-log-field-filters";

export interface JsonField {
  path: JsonPath;
  value: JSONValue;
  valueOffset: number;
}

// bound token and path allocation for unusually large or deeply nested previews
export const maxJsonTokens = 20_000;
// fail closed when the source exceeds the inspection budget
export function jsonHasDuplicateKeys(text: string): boolean {
  if (text.length > 2 * 1024 * 1024) return true;
  const stack: { keys?: Set<string>; expectingKey: boolean }[] = [];
  const pattern = /"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/g;
  let count = 0;
  try {
    for (const token of text.matchAll(pattern)) {
      if (++count > maxJsonTokens || stack.length > 256) return true;
      const raw = token[0];
      const frame = stack.at(-1);
      if (raw === "{" || raw === "[") {
        stack.push({ keys: raw === "{" ? new Set() : undefined, expectingKey: raw === "{" });
      } else if (raw === "}" || raw === "]") {
        stack.pop();
      } else if (raw === ",") {
        if (frame?.keys) frame.expectingKey = true;
      } else if (frame?.keys && frame.expectingKey && raw.startsWith('"')) {
        const key: string = JSON.parse(raw);
        if (frame.keys.has(key)) return true;
        frame.keys.add(key);
        frame.expectingKey = false;
      }
    }
  } catch {
    return true;
  }
  return false;
}

export function compactJsonLiteral(text: string): string {
  return text.replace(/"(?:\\.|[^"\\])*"|\s+/g, (token) => (token.startsWith('"') ? token : ""));
}

export function jsonFields(text: string): Map<number, JsonField> {
  const fields = new Map<number, JsonField>();
  if (jsonHasDuplicateKeys(text)) return fields;
  try {
    const root: unknown = JSON.parse(text);
    const stack: { path: JsonPath; array: boolean; index: number; key?: string }[] = [];
    const pattern = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g;
    let count = 0;
    for (const token of text.matchAll(pattern)) {
      if (++count > maxJsonTokens || stack.length > 256) return new Map();
      const raw = token[0];
      const frame = stack.at(-1);
      if (raw === ":") continue;
      if (raw === ",") {
        if (frame?.array) frame.index++;
        else if (frame) frame.key = undefined;
        continue;
      }
      if (raw === "}" || raw === "]") {
        stack.pop();
        continue;
      }
      const isKey = frame && !frame.array && frame.key === undefined && raw.startsWith('"');
      if (isKey) frame.key = JSON.parse(raw);
      const path = frame ? [...frame.path, frame.array ? frame.index : frame.key!] : [];
      const resolved = extractJsonPath(root, path);
      if (path.length && resolved.found && !(typeof resolved.value === "number" && !Number.isFinite(resolved.value))) {
        let valueOffset = token.index!;
        if (isKey) {
          valueOffset += raw.length;
          while (/\s/.test(text[valueOffset] ?? "")) valueOffset++;
          valueOffset++;
          while (/\s/.test(text[valueOffset] ?? "")) valueOffset++;
        }
        fields.set(token.index!, { path, value: resolved.value as JSONValue, valueOffset });
      }
      if (raw === "{" || raw === "[") stack.push({ path, array: raw === "[", index: 0 });
    }
  } catch {
    return new Map();
  }
  return fields;
}

export function jsonFieldLiteral(text: string, field: JsonField): string {
  if (text.length > 2 * 1024 * 1024) throw new Error("JSON field exceeds copy budget");
  const start = field.valueOffset;
  const pattern = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/gy;
  pattern.lastIndex = start;
  let depth = 0;
  let count = 0;
  while (pattern.lastIndex < text.length) {
    while (/\s/.test(text[pattern.lastIndex] ?? "")) pattern.lastIndex++;
    const match = pattern.exec(text);
    if (!match || ++count > maxJsonTokens) break;
    const raw = match[0];
    if (raw === "{" || raw === "[") depth++;
    else if (raw === "}" || raw === "]") depth--;
    if (depth === 0) return text.slice(start, pattern.lastIndex);
  }
  throw new Error("Unable to extract JSON field");
}

export function formatJsonLiteral(text: string): string {
  if (text.length > 2 * 1024 * 1024) return text;
  try {
    JSON.parse(text);
  } catch {
    return text;
  }
  const pattern = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g;
  const tokens: string[] = [];
  for (const match of text.matchAll(pattern)) {
    if (tokens.length >= maxJsonTokens) return text;
    tokens.push(match[0]);
  }
  const parts: string[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "{" || token === "[") {
      if (++depth > 256) return text;
      parts.push(token);
      if (tokens[index + 1] !== "}" && tokens[index + 1] !== "]") parts.push("\n", "  ".repeat(depth));
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[index - 1] !== "{" && tokens[index - 1] !== "[") parts.push("\n", "  ".repeat(depth));
      parts.push(token);
    } else if (token === ",") parts.push(",\n", "  ".repeat(depth));
    else if (token === ":") parts.push(": ");
    else parts.push(token);
  }
  return parts.join("");
}
