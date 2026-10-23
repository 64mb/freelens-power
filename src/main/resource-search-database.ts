import type { SearchDocument, SearchIndexRequest, SearchQueryResult } from "../common/resource-search";

export class ResourceSearchDatabase {
  private db: import("node:sqlite").DatabaseSync;

  constructor(
    private path: string,
    maxBytes = 256 * 1024 * 1024,
  ) {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA cache_size=-4096;
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY, cluster TEXT NOT NULL, context TEXT NOT NULL,
        path TEXT NOT NULL, scope TEXT NOT NULL, scan TEXT NOT NULL,
        name TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL, text TEXT NOT NULL,
        UNIQUE(cluster, context, path)
      );
      CREATE INDEX IF NOT EXISTS document_scope ON documents(cluster,context,scope);
      CREATE TABLE IF NOT EXISTS scans (cluster TEXT,context TEXT,scope TEXT,scan TEXT,
        PRIMARY KEY(cluster,context,scope)) WITHOUT ROWID;
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text,content=documents,content_rowid=id,tokenize=trigram);
      CREATE TRIGGER IF NOT EXISTS document_insert AFTER INSERT ON documents BEGIN
        INSERT INTO search(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS document_delete AFTER DELETE ON documents BEGIN
        INSERT INTO search(search,rowid,text) VALUES('delete',old.id,old.text); END;
      CREATE TRIGGER IF NOT EXISTS document_update AFTER UPDATE ON documents BEGIN
        INSERT INTO search(search,rowid,text) VALUES('delete',old.id,old.text);
        INSERT INTO search(rowid,text) VALUES(new.id,new.text); END;
      CREATE TABLE IF NOT EXISTS name_terms (
        document INTEGER REFERENCES documents(id) ON DELETE CASCADE,term TEXT,
        PRIMARY KEY(document,term)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS term_length ON name_terms(length(term));`);
    const pageSize = Number(this.db.prepare("PRAGMA page_size").get()?.page_size ?? 4096);
    this.db.exec(`PRAGMA max_page_count=${Math.max(64, Math.floor(maxBytes / 2 / pageSize))}`);
    this.db.function("search_distance", { deterministic: true }, (left, right, limit) =>
      this.distance(String(left), String(right), Number(limit)),
    );
    this.db.function("search_parts", { deterministic: true }, (name, token) => this.parts(String(name), String(token)));
    try {
      require("node:fs").chmodSync(path, 0o600);
    } catch {
      /* in-memory databases have no file */
    }
  }

  private distance(left: string, right: string, limit: number): number {
    if (left.length > 64 || right.length > 64 || Math.abs(left.length - right.length) > limit) return limit + 1;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    let beforePrevious = previous;
    for (let row = 1; row <= left.length; row++) {
      const current = Array<number>(right.length + 1).fill(limit + 1);
      current[0] = row;
      let minimum = limit + 1;
      for (let column = Math.max(1, row - limit); column <= Math.min(right.length, row + limit); column++) {
        current[column] = Math.min(
          previous[column] + 1,
          current[column - 1] + 1,
          previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
        );
        if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1])
          current[column] = Math.min(current[column], beforePrevious[column - 2] + 1);
        minimum = Math.min(minimum, current[column]);
      }
      if (minimum > limit) return limit + 1;
      beforePrevious = previous;
      previous = current;
    }
    return previous[right.length];
  }

  private parts(name: string, token: string): number {
    if (!/^[a-z0-9]+(?:[-._][a-z0-9]+)+$/.test(token)) return 0;
    const wanted = token.split(/[-._]/);
    if (wanted.length > 16) return 0;
    let offset = 0;
    for (const part of name.toLocaleLowerCase().split(/[-._]/).filter(Boolean).slice(0, 16))
      if (part === wanted[offset]) offset++;
    return offset === wanted.length ? 1 : 0;
  }

  run(request: SearchIndexRequest): unknown {
    const { clusterId, contextId } = request;
    this.db.prepare("DELETE FROM documents WHERE cluster=? AND context<>?").run(clusterId, contextId);
    this.db.prepare("DELETE FROM scans WHERE cluster=? AND context<>?").run(clusterId, contextId);
    if (request.operation === "query") return this.query(clusterId, contextId, request.query, request.limit, request);
    if (request.operation === "status")
      return {
        available: true,
        count: Number(
          this.db
            .prepare("SELECT count(*) AS count FROM documents WHERE cluster=? AND context=?")
            .get(clusterId, contextId)?.count ?? 0,
        ),
        bytes: this.bytes(),
      };
    if (request.operation === "clear") {
      this.db.prepare("DELETE FROM documents WHERE cluster=?").run(clusterId);
      this.db.prepare("DELETE FROM scans WHERE cluster=?").run(clusterId);
      this.db.exec("VACUUM");
      return true;
    }
    if (request.operation === "permit") return true;
    if (request.operation === "reconcile") {
      const catalog = JSON.stringify(request.resources);
      this.db
        .prepare(`DELETE FROM documents WHERE cluster=? AND context=? AND
        json_extract(json,'$.group')||'/'||json_extract(json,'$.resource') NOT IN (SELECT value FROM json_each(?))`)
        .run(clusterId, contextId, catalog);
      this.db
        .prepare(`DELETE FROM scans WHERE cluster=? AND context=? AND NOT EXISTS
        (SELECT 1 FROM json_each(?) WHERE substr(scope,1,length(value)+1)=value||'/')`)
        .run(clusterId, contextId, catalog);
      return true;
    }
    const { scope } = request;
    const prefix = scope.endsWith("/*") ? scope.slice(0, -1) : scope;
    const scopeCondition = scope.endsWith("/*") ? "substr(scope,1,length(?))=?" : "scope=?";
    const scopeArgs = scope.endsWith("/*") ? [prefix, prefix] : [scope];
    if (request.operation === "invalidate") {
      this.db
        .prepare(`DELETE FROM documents WHERE cluster=? AND context=? AND ${scopeCondition}`)
        .run(clusterId, contextId, ...scopeArgs);
      this.db
        .prepare(`DELETE FROM scans WHERE cluster=? AND context=? AND ${scopeCondition}`)
        .run(clusterId, contextId, ...scopeArgs);
      return true;
    }
    if (request.operation === "begin") {
      this.db
        .prepare(
          "INSERT INTO scans VALUES(?,?,?,?) ON CONFLICT(cluster,context,scope) DO UPDATE SET scan=excluded.scan",
        )
        .run(clusterId, contextId, scope, request.scanId);
      return true;
    }
    const scan = this.db
      .prepare("SELECT scan FROM scans WHERE cluster=? AND context=? AND scope=?")
      .get(clusterId, contextId, scope)?.scan;
    if (scan !== request.scanId) throw new Error("Search scan superseded");
    if (request.operation === "complete") {
      this.db
        .prepare(`DELETE FROM documents WHERE cluster=? AND context=? AND ${scopeCondition} AND scan<>?`)
        .run(clusterId, contextId, ...scopeArgs, request.scanId);
      this.db
        .prepare(`DELETE FROM scans WHERE cluster=? AND context=? AND ${scopeCondition}`)
        .run(clusterId, contextId, ...scopeArgs);
      return true;
    }
    this.db.exec("BEGIN");
    try {
      const insert = this.db.prepare(`INSERT INTO documents(cluster,context,path,scope,scan,name,kind,json,text)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(cluster,context,path) DO UPDATE SET scope=excluded.scope,
        scan=excluded.scan,name=excluded.name,kind=excluded.kind,json=excluded.json,text=excluded.text RETURNING id`);
      const term = this.db.prepare("INSERT OR IGNORE INTO name_terms VALUES(?,?)");
      for (const document of request.documents) {
        const text = [
          document.name,
          document.kind,
          document.namespace ?? "",
          ...(document.aliases ?? []),
          ...Object.entries(document.labels).map(([key, value]) => `${key}=${value}`),
          ...(document.fields ?? []).map((field) => field.text),
        ]
          .join(" ")
          .toLocaleLowerCase();
        const row = insert.get(
          clusterId,
          contextId,
          document.path,
          scope,
          request.scanId,
          document.name,
          document.kind,
          JSON.stringify(document),
          text,
        );
        this.db.prepare("DELETE FROM name_terms WHERE document=?").run(row!.id);
        for (const part of new Set(
          [document.name, ...document.name.split(/[-._]/)].map((part) => part.toLocaleLowerCase()),
        ))
          if (part.length >= 3 && part.length <= 64) term.run(row!.id, part);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* sqlite can roll back a full transaction automatically */
      }
      throw error;
    }
    return true;
  }

  query(
    cluster: string,
    context: string,
    query: string,
    requestedLimit = 200,
    filters: { kind?: string; namespace?: string } = {},
  ): SearchQueryResult {
    const limit = Math.max(1, Math.min(1000, Math.floor(requestedLimit)));
    const tokens = query.slice(0, 300).toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const args: (string | number)[] = [cluster, context];
    const filtersSql: string[] = [];
    if (filters.kind !== undefined) {
      filtersSql.push("LOWER(d.kind)=LOWER(?)");
      args.push(filters.kind);
    }
    if (filters.namespace !== undefined) {
      filtersSql.push("COALESCE(json_extract(d.json,'$.namespace'),'')=?");
      args.push(filters.namespace);
    }
    const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");
    const conditions = tokens.map((token) => {
      const clauses: string[] = [];
      if ([...token].length >= 3) {
        clauses.push("d.id IN (SELECT rowid FROM search WHERE search MATCH ?)");
        args.push(`"${token.replace(/"/g, '""')}"`);
      } else {
        clauses.push("d.text LIKE ? ESCAPE '\\'");
        args.push(`%${escapeLike(token)}%`);
      }
      const parts = token.split(/[-._]/).filter(Boolean);
      if (parts.length > 1) {
        clauses.push("search_parts(d.name,?)=1");
        args.push(token);
      }
      const distance = token.length >= 7 && token.length <= 64 ? 2 : token.length >= 4 && token.length <= 6 ? 1 : 0;
      if (distance) {
        clauses.push(
          "EXISTS (SELECT 1 FROM name_terms t WHERE t.document=d.id AND length(t.term) BETWEEN ? AND ? AND search_distance(t.term,?,?)<=?)",
        );
        args.push(token.length - distance, token.length + distance, token, distance, distance);
      }
      return `(${clauses.join(" OR ")})`;
    });
    const rankingArgs: (string | number)[] = [];
    const penalties = tokens.map((token) => {
      const distance = token.length >= 7 && token.length <= 64 ? 2 : token.length >= 4 && token.length <= 6 ? 1 : 0;
      rankingArgs.push(token, token);
      const fallback = distance
        ? `(SELECT 10*min(search_distance(t.term,?,?)) FROM name_terms t WHERE t.document=d.id AND length(t.term) BETWEEN ? AND ?)`
        : "100";
      if (distance) rankingArgs.push(token, distance, token.length - distance, token.length + distance);
      return `CASE WHEN instr(d.text,?)>0 THEN 0 WHEN search_parts(d.name,?)=1 THEN 1 ELSE COALESCE(${fallback},100) END`;
    });
    const name = query.toLocaleLowerCase().trim();
    const rows = this.db
      .prepare(`SELECT d.json,count(*) OVER() AS total FROM documents d
      WHERE d.cluster=? AND d.context=? ${[...filtersSql, ...conditions].length ? `AND ${[...filtersSql, ...conditions].join(" AND ")}` : ""}
      ORDER BY ${penalties.length ? penalties.map((penalty) => `(${penalty})`).join("+") : "NULL"},
      CASE WHEN LOWER(d.name)=? THEN 0 WHEN LOWER(d.name) LIKE ? ESCAPE '\\' THEN 1
      WHEN LOWER(d.kind)=? THEN 2 WHEN instr(LOWER(d.name),?)>0 THEN 3 ELSE 4 END,d.kind,d.name,d.path LIMIT ?`)
      .all(...args, ...rankingArgs, name, `${escapeLike(name)}%`, name, name, limit);
    const total = Number(rows[0]?.total ?? 0);
    return {
      documents: rows.map((row) => JSON.parse(String(row.json)) as SearchDocument),
      total,
      hasMore: total > rows.length,
    };
  }

  private bytes(): number {
    return [this.path, `${this.path}-journal`].reduce((sum, path) => {
      try {
        return sum + require("node:fs").statSync(path).size;
      } catch {
        return sum;
      }
    }, 0);
  }

  close(): void {
    this.db.close();
  }
}
