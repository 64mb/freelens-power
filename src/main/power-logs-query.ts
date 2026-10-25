import { constants, DatabaseSync } from "node:sqlite";
import { POWER_LOGS_LIMITS as L, type LogCell, type LogQueryResult } from "../common/power-logs";

export type PowerLogsQuerySnapshot = { database: string; captureId: string; expiresAt: number };

const functions = new Set(
  `abs avg ceil ceiling char coalesce concat concat_ws count date datetime floor format glob group_concat hex if ifnull iif instr json json_array json_array_length json_error_position json_extract json_group_array json_group_object json_insert json_object json_patch json_pretty json_quote json_remove json_replace json_set json_type json_valid likelihood likely lower ltrim max min nullif octet_length pow power printf quote replace round rtrim sign strftime string_agg substr substring sum time timediff total trim typeof unicode unixepoch unlikely upper zeroblob length rank dense_rank row_number percent_rank cume_dist ntile lag lead first_value last_value nth_value`.split(
    " ",
  ),
);

// the scanner treats quoted text and comments as opaque before counting statements
function singleStatement(sql: string): boolean {
  let ended = false;
  let intent = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    if (ended) return false;
    if (!intent) {
      const word = /^[a-z]+/i.exec(sql.slice(i));
      if (!word || !/^(select|with|explain)$/i.test(word[0])) return false;
      intent = word[0];
    }
    if (c === ";") {
      ended = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const closing = c === "[" ? "]" : c;
      let closed = false;
      for (i++; i < sql.length; i++) {
        if (sql[i] !== closing) continue;
        if (closing !== "]" && sql[i + 1] === closing) {
          i++;
          continue;
        }
        i++;
        closed = true;
        break;
      }
      if (!closed) return false;
      continue;
    }
    i++;
  }
  return Boolean(intent);
}

function cell(value: unknown): LogCell {
  if (value == null) return null;
  if (typeof value === "bigint")
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  return typeof value === "string" ? value : String(value);
}

export function runPowerLogsQuery(path: string, sql: string): LogQueryResult {
  if (!singleStatement(sql)) throw new Error("Use a single SELECT or EXPLAIN statement");
  const started = Date.now();
  const database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    if (typeof database.setAuthorizer !== "function")
      return {
        columns: [],
        rows: [],
        truncated: false,
        elapsedMs: Date.now() - started,
        error: "Update Freelens to use secure Power Logs SQL queries. This runtime does not support SQL authorization.",
      };
    database.exec(
      "PRAGMA hard_heap_limit=134217728; PRAGMA cache_size=-16384; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0",
    );
    database.setAuthorizer((action, table, name, db) => {
      if (action === constants.SQLITE_SELECT || action === constants.SQLITE_RECURSIVE) return constants.SQLITE_OK;
      if (action === constants.SQLITE_READ && (db === "main" || db === null) && table === "logs")
        return constants.SQLITE_OK;
      if (
        action === constants.SQLITE_READ &&
        (db === "main" || db === null) &&
        table === "json_each" &&
        (name === "key" || name === "value" || name === "type")
      )
        return constants.SQLITE_OK;
      // SQLite uses an empty column and no database for constant projections from a CTE
      if (action === constants.SQLITE_READ && db === null && name === "" && table && !/^(sqlite_|pragma_)/i.test(table))
        return constants.SQLITE_OK;
      if (action === constants.SQLITE_FUNCTION && functions.has((name ?? "").toLowerCase())) return constants.SQLITE_OK;
      return constants.SQLITE_DENY;
    });
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const columns = statement.columns().map((column) => column.name);
    let bytes = Buffer.byteLength(JSON.stringify(columns));
    if (columns.length > 100 || bytes > L.resultBytes) throw new Error("Query result exceeds limit");
    const rows: LogCell[][] = [];
    let truncated = false;
    for (const row of statement.iterate()) {
      const converted = (row as unknown as unknown[]).map(cell);
      const size = Buffer.byteLength(JSON.stringify(converted));
      if (rows.length >= L.resultRows || bytes + size > L.resultBytes) {
        truncated = true;
        break;
      }
      rows.push(converted);
      bytes += size;
    }
    return { columns, rows, truncated, elapsedMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/not authorized|authorization denied|prohibited/i.test(message))
      throw new Error("Use read-only SELECT or EXPLAIN statements over logs");
    return {
      columns: [],
      rows: [],
      truncated: false,
      elapsedMs: Date.now() - started,
      error: "SQLite could not run this query. Check SQL syntax, column names and supported functions.",
    };
  } finally {
    database.close();
  }
}
