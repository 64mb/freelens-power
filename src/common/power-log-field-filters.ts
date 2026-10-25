export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type JsonPath = (string | number)[];
export interface JsonFieldFilter {
  path: JsonPath;
  operator: "eq" | "neq";
  value: JSONValue;
}
export type JsonPathResult = { found: false } | { found: true; value: unknown };

const maxNodes = 200_000;

function validPath(path: unknown): path is JsonPath {
  if (!Array.isArray(path) || path.length > maxNodes) return false;
  for (const part of path) {
    if (typeof part !== "string" && !(typeof part === "number" && Number.isSafeInteger(part) && part >= 0))
      return false;
  }
  return true;
}

export function extractJsonPath(fields: unknown, path: JsonPath): JsonPathResult {
  if (!validPath(path)) return { found: false };
  let value = fields;
  for (const part of path) {
    if (value === null || typeof value !== "object") return { found: false };
    if (Array.isArray(value) ? typeof part !== "number" || part >= value.length : typeof part !== "string") {
      return { found: false };
    }
    const property = Object.getOwnPropertyDescriptor(value, part);
    if (!property || !("value" in property)) return { found: false };
    value = property.value;
  }
  return { found: true, value };
}

function validJson(value: unknown): value is JSONValue {
  const pending: { value: unknown; leaving?: boolean }[] = [{ value }];
  const ancestors = new WeakSet<object>();
  let visited = 0;
  while (pending.length) {
    const item = pending.pop()!;
    const current = item.value;
    if (item.leaving) {
      ancestors.delete(current as object);
      continue;
    }
    if (++visited > maxNodes) return false;
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object" || ancestors.has(current)) return false;
    if (!Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current))) return false;
    ancestors.add(current);
    pending.push({ value: current, leaving: true });
    const keys = Object.keys(current);
    if (keys.length > maxNodes || (Array.isArray(current) && keys.length !== current.length)) return false;
    for (const key of keys) {
      if (Array.isArray(current) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length)) return false;
      const property = Object.getOwnPropertyDescriptor(current, key)!;
      if (!("value" in property)) return false;
      pending.push({ value: property.value });
    }
  }
  return true;
}

function equalValues(left: JSONValue, right: JSONValue): boolean {
  const pending: [JSONValue, JSONValue][] = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      const other = Object.getOwnPropertyDescriptor(b, key);
      if (!other) return false;
      pending.push([Object.getOwnPropertyDescriptor(a, key)!.value, other.value]);
    }
  }
  return true;
}

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return validJson(left) && validJson(right) && equalValues(left, right);
}

export function compileJsonFilters(filters: readonly JsonFieldFilter[]): (fields: unknown) => boolean {
  if (
    !Array.isArray(filters) ||
    filters.length > 32 ||
    filters.some(
      (filter) =>
        !filter || !validPath(filter.path) || !["eq", "neq"].includes(filter.operator) || !validJson(filter.value),
    )
  )
    return () => false;
  return (fields) =>
    filters.every((filter) => {
      const result = extractJsonPath(fields, filter.path);
      const actual = result.found ? result.value : undefined;
      const equal =
        result.found &&
        (actual === filter.value ||
          (actual !== null &&
            filter.value !== null &&
            typeof actual === "object" &&
            typeof filter.value === "object" &&
            validJson(actual) &&
            equalValues(actual, filter.value)));
      return filter.operator === "eq" ? equal : !equal;
    });
}

export function matchesAllJsonFilters(fields: unknown, filters: readonly JsonFieldFilter[]): boolean {
  return compileJsonFilters(filters)(fields);
}
