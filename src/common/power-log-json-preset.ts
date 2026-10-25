export const JSON_KEY_DISCOVERY_SQL = `SELECT DISTINCT field.key
FROM (SELECT fieldsJson FROM logs WHERE fieldsJson IS NOT NULL ORDER BY timestamp DESC NULLS LAST LIMIT 100) AS recent
JOIN json_each(recent.fieldsJson) AS field
WHERE typeof(field.key) = 'text'
LIMIT 65`;

export function buildJsonProjectionSql(keys: string[], options: { recent?: boolean } = {}): string {
  if (options.recent)
    return "SELECT message, level, container, pod, timestamp FROM logs ORDER BY timestamp DESC NULLS LAST LIMIT 200";
  const fallbackSql = "SELECT fieldsJson FROM logs WHERE fieldsJson IS NOT NULL LIMIT 100";
  if (!keys.length || keys.length > 64) return fallbackSql;
  const usable = (key: string) => typeof key === "string" && key.length <= 128 && !key.includes("\0");
  const key =
    ["message", "msg", "text", "Message", "RenderedMessage", "@m", "@mt", "body", "Body"].find((preferred) =>
      keys.includes(preferred),
    ) ?? keys.find(usable);
  if (key === undefined || !usable(key)) return fallbackSql;
  const literal = `'${key.replace(/'/g, "''")}'`;
  const identifier = `"${key.replace(/"/g, '""')}"`;
  const value = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `json_extract(logs.fieldsJson, '$.${key}')`
    : `(SELECT value FROM json_each(logs.fieldsJson) WHERE key = ${literal} LIMIT 1)`;
  const tail = "WHERE fieldsJson IS NOT NULL\nORDER BY logs.timestamp DESC NULLS LAST\nLIMIT 100";
  return `SELECT\n  ${value} AS ${identifier}\nFROM logs\n${tail}`;
}
