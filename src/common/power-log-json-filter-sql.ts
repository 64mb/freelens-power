import { type JsonFieldFilter, jsonValuesEqual } from "./power-log-field-filters";

export interface SqlJsonFieldFilter extends JsonFieldFilter {
  column: string;
}

const maxSqlLength = 65536;
const normalizedType = (type: string) => `CASE WHEN ${type} IN ('integer', 'real') THEN 'number' ELSE ${type} END`;
const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
const literal = (value: string): string =>
  value
    .split("\0")
    .map((part) => `'${part.replace(/'/g, "''")}'`)
    .join(" || char(0) || ");
const tree = (name: string) => `SELECT path, ${normalizedType("type")}, CASE
  WHEN type IN ('object', 'array') THEN NULL
  WHEN type IN ('integer', 'real') THEN CAST(value AS REAL)
  ELSE value END FROM ${name}`;
const descendants = (name: string, root: string) => `${name}(path, value, type) AS (
    ${root}
    UNION ALL
    SELECT json_insert(parent.path, '$[#]', j.key), j.value, j.type
    FROM ${name} AS parent, json_each(CASE WHEN parent.type IN ('object', 'array') THEN parent.value ELSE NULL END) AS j
  )`;

function predicate(filter: SqlJsonFieldFilter): string {
  if (
    !filter ||
    typeof filter.column !== "string" ||
    !filter.column ||
    filter.column.includes("\0") ||
    !Array.isArray(filter.path) ||
    filter.path.length > 128 ||
    (filter.operator !== "eq" && filter.operator !== "neq") ||
    !jsonValuesEqual(filter.value, filter.value)
  )
    throw new Error("Invalid JSON field filter");
  const simplePath = filter.path.every(
    (part) =>
      (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) ||
      (typeof part === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(part)),
  );
  if (simplePath && (filter.value === null || typeof filter.value !== "object")) {
    const source = `"__power_rows".${quoteIdentifier(filter.column)}`;
    const path = literal(
      "$" + filter.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`)).join(""),
    );
    const type = `json_type(${source}, ${path})`;
    const value = `json_extract(${source}, ${path})`;
    let equal: string;
    if (filter.value === null) equal = `${type} IS 'null'`;
    else if (typeof filter.value === "boolean") equal = `${type} IS '${filter.value}'`;
    else if (typeof filter.value === "number")
      equal = `(${type} IN ('integer', 'real') AND CAST(${value} AS REAL) IS ${filter.value})`;
    else equal = `(${type} IS 'text' AND ${value} IS ${literal(filter.value)})`;
    return `${filter.operator === "neq" ? "NOT " : ""}(CASE WHEN json_valid(${source}) THEN ${equal} ELSE 0 END)`;
  }
  const steps: string[] = [];
  for (const [depth, part] of filter.path.entries()) {
    if (typeof part !== "string" && !(typeof part === "number" && Number.isSafeInteger(part) && part >= 0)) {
      throw new Error("Invalid JSON field path");
    }
    steps.push(
      `(walk.depth = ${depth} AND typeof(j.key) = '${typeof part === "string" ? "text" : "integer"}' AND j.key = ${typeof part === "string" ? literal(part) : part})`,
    );
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(filter.value);
  } catch {
    throw new Error("JSON field filter value cannot be encoded");
  }
  const source = `"__power_rows".${quoteIdentifier(filter.column)}`;
  const safe = `CASE WHEN json_valid(${source}) THEN ${source} ELSE NULL END`;
  const recursion = steps.length
    ? `
    UNION ALL
    SELECT walk.depth + 1, j.value, j.type
    FROM walk, json_each(CASE WHEN walk.type IN ('object', 'array') THEN walk.value ELSE NULL END) AS j
    WHERE ${steps.join(" OR ")}`
    : "";
  const leftTree = tree("actual_tree");
  const rightTree = tree("expected_tree");
  const equal = `EXISTS (
    SELECT 1 FROM walk, wanted WHERE walk.depth = ${filter.path.length}
    AND CASE
      WHEN walk.type IS NULL OR ${normalizedType("walk.type")} != ${normalizedType("wanted.type")} THEN 0
      WHEN walk.type IN ('object', 'array') THEN
        NOT EXISTS (${leftTree} EXCEPT ${rightTree}) AND NOT EXISTS (${rightTree} EXCEPT ${leftTree})
      WHEN walk.type IN ('integer', 'real') THEN CAST(walk.value AS REAL) IS CAST(wanted.value AS REAL)
      ELSE walk.value IS wanted.value
    END
  )`;
  return `(WITH RECURSIVE walk(depth, value, type) AS (
    SELECT 0, json_extract(${safe}, '$'), json_type(${safe})${recursion}
  ), wanted(value, type) AS (
    SELECT json_extract(${literal(encoded)}, '$'), json_type(${literal(encoded)})
  ), ${descendants("actual_tree", `SELECT json_array(), value, type FROM walk WHERE depth = ${filter.path.length}`)},
  ${descendants("expected_tree", "SELECT json_array(), value, type FROM wanted")}
  SELECT ${filter.operator === "neq" ? "NOT " : ""}${equal})`;
}

function withoutFinalSemicolon(sql: string): string {
  let lastCode = -1;
  for (let index = 0; index < sql.length; ) {
    const character = sql[index];
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 2;
      continue;
    }
    lastCode = index;
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const closing = character === "[" ? "]" : character;
      for (index++; index < sql.length; index++) {
        if (sql[index] !== closing) continue;
        if (closing !== "]" && sql[index + 1] === closing) {
          index++;
          continue;
        }
        index++;
        break;
      }
    } else index++;
  }
  return sql[lastCode] === ";" ? sql.slice(0, lastCode) + sql.slice(lastCode + 1) : sql;
}

export function buildJsonFilterSql(baseSql: string, filters: SqlJsonFieldFilter[]): string {
  if (typeof baseSql !== "string" || !Array.isArray(filters)) throw new Error("Invalid JSON filter query");
  if (!filters.length) return baseSql;
  const base = withoutFinalSemicolon(baseSql.trim());
  if (!base) throw new Error("JSON filter query must not be empty");
  let sql = `SELECT * FROM (${base}\n) AS "__power_rows" WHERE `;
  for (const [index, filter] of filters.entries()) {
    sql += `${index ? " AND " : ""}${predicate(filter)}`;
    if (sql.length > maxSqlLength) throw new Error("JSON filter query exceeds 65536 characters");
  }
  return sql;
}
