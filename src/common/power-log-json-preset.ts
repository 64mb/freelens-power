export const JSON_KEY_DISCOVERY_SQL = `WITH recent AS (
  SELECT fieldsJson FROM logs ORDER BY timestamp DESC NULLS LAST LIMIT 200
), json_recent AS (
  SELECT fieldsJson FROM logs WHERE fieldsJson IS NOT NULL ORDER BY timestamp DESC NULLS LAST LIMIT 100
), samples AS (
  SELECT fieldsJson FROM recent UNION ALL SELECT fieldsJson FROM json_recent
)
SELECT field.key FROM samples JOIN json_each(samples.fieldsJson) AS field
WHERE typeof(field.key) = 'text'
UNION
SELECT 'message' FROM recent WHERE fieldsJson IS NULL
LIMIT 65`;

export function buildJsonProjectionSql(keys: string[], options: { recent?: boolean } = {}): string {
  const fallbackSql = options.recent
    ? "SELECT fieldsJson, message, level, container, pod, timestamp FROM logs ORDER BY timestamp DESC NULLS LAST LIMIT 200"
    : "SELECT fieldsJson FROM logs WHERE fieldsJson IS NOT NULL LIMIT 100";
  if (!keys.length || keys.length > 64) return fallbackSql;
  const aliases = new Set<string>();
  for (const key of keys) {
    const alias = key.replace(/[A-Z]/g, (character) => character.toLowerCase());
    if (key.length > 128 || key.includes("\0") || aliases.has(alias)) return fallbackSql;
    aliases.add(alias);
  }
  const columns = keys.map((key) => {
    const literal = `'${key.replace(/'/g, "''")}'`;
    const identifier = `"${key.replace(/"/g, '""')}"`;
    const lookup = `(SELECT value FROM json_each(logs.fieldsJson) WHERE key = ${literal} LIMIT 1)`;
    const value =
      options.recent && key === "message"
        ? `CASE WHEN logs.fieldsJson IS NULL THEN logs.message ELSE ${lookup} END`
        : lookup;
    return `${value} AS ${identifier}`;
  });
  const tail = options.recent
    ? "ORDER BY logs.timestamp DESC NULLS LAST\nLIMIT 200"
    : "WHERE fieldsJson IS NOT NULL\nORDER BY logs.timestamp DESC NULLS LAST\nLIMIT 100";
  return `SELECT\n  ${columns.join(",\n  ")}\nFROM logs\n${tail}`;
}
