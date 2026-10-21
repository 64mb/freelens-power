import { type HistoryPoint, type HistoryQuery, type HistorySample } from "../common/monitoring-history";

export class MonitoringHistoryDatabase {
  private db: import("node:sqlite").DatabaseSync;
  constructor(
    private path: string,
    private maxBytes = 100 * 1024 * 1024,
  ) {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048; PRAGMA auto_vacuum=FULL;
      CREATE TABLE IF NOT EXISTS points (cluster TEXT, scope TEXT, uid TEXT, metric TEXT, resolution INTEGER, time INTEGER, min REAL, max REAL, total REAL, count INTEGER, first INTEGER, last INTEGER, PRIMARY KEY(cluster,scope,uid,metric,resolution,time)) WITHOUT ROWID;`);
    this.db.exec(`PRAGMA max_page_count=${Math.max(8, Math.floor(this.maxBytes / 3 / 4096))}`);
    this.prune();
  }
  append(samples: HistorySample[], now = Date.now()): void {
    const put = this.db.prepare(
      `INSERT INTO points VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cluster,scope,uid,metric,resolution,time) DO UPDATE SET min=MIN(min,excluded.min), max=MAX(max,excluded.max),total=total+excluded.total,count=count+1,first=MIN(first,excluded.first),last=MAX(last,excluded.last) WHERE excluded.last > last`,
    );
    this.prune(now);
    for (const sample of samples) {
      let saved = false;
      for (let attempt = 0; attempt < 8 && !saved; attempt++) {
        this.db.exec("BEGIN");
        try {
          for (const [metric, value] of Object.entries(sample.values))
            for (const resolution of [30_000, 300_000, 1_800_000]) {
              put.run(
                sample.clusterId,
                sample.scope,
                sample.uid,
                metric,
                resolution,
                Math.floor(sample.time / resolution) * resolution,
                value,
                value,
                value,
                1,
                sample.time,
                sample.time,
              );
            }
          this.db.exec("COMMIT");
          saved = true;
        } catch (error) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            /* sqlite can roll back a full transaction automatically */
          }
          if ((error as { errcode?: number }).errcode !== 13) throw error;
          if (!this.evictOldest()) throw new Error("History storage cannot fit a numeric sample");
        }
      }
      if (!saved) throw new Error("History storage is full");
    }
    this.prune(now);
  }
  prune(now = Date.now()): void {
    this.db
      .prepare(
        "DELETE FROM points WHERE time < ? OR (resolution=30000 AND time < ?) OR (resolution=300000 AND time < ?)",
      )
      .run(now - 604_800_000, now - 7_200_000, now - 86_400_000);
    // reserve room for rollback journals and compaction without dropping all history
    while (this.occupiedBytes() > this.maxBytes / 4) {
      if (!this.evictOldest()) break;
    }
  }
  private occupiedBytes(): number {
    const pages = Number(this.db.prepare("PRAGMA page_count").get()?.page_count ?? 0);
    const free = Number(this.db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0);
    return (pages - free) * Number(this.db.prepare("PRAGMA page_size").get()?.page_size ?? 4096);
  }
  private evictOldest(): boolean {
    const count = Number(this.db.prepare("SELECT count(*) AS count FROM points").get()?.count ?? 0);
    if (!count) return false;
    const limit = Math.min(256, Math.max(1, Math.ceil(count / 8)));
    this.db
      .prepare(
        "DELETE FROM points WHERE (cluster,scope,uid,metric,resolution,time) IN (SELECT cluster,scope,uid,metric,resolution,time FROM points ORDER BY time LIMIT ?)",
      )
      .run(limit);
    const pages = Number(this.db.prepare("PRAGMA page_count").get()?.page_count ?? 0);
    const free = Number(this.db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0);
    if (free > pages / 4) this.db.exec("VACUUM");
    return true;
  }

  query(query: HistoryQuery, now = Date.now()): HistoryPoint[] {
    this.prune(now);
    const rows = this.db
      .prepare(
        `SELECT time,resolution,metric,min,max,total/count AS avg,count,first,last FROM points WHERE cluster=? AND scope=? AND uid=? AND (CASE WHEN resolution=30000 THEN last ELSE time+resolution-1 END)>=? AND (CASE WHEN resolution=30000 THEN last ELSE time END)<=? AND ((time>=? AND resolution=30000) OR (time<? AND time>=? AND resolution=300000) OR (time<? AND resolution=1800000)) ORDER BY time LIMIT 20000`,
      )
      .all(
        query.clusterId,
        query.scope,
        query.uid,
        query.from,
        query.to,
        now - 7_200_000,
        now - 7_200_000,
        now - 86_400_000,
        now - 86_400_000,
      );
    return rows.map((row) => ({
      time: Number(row.resolution) === 30_000 ? Number(row.last) : Number(row.time),
      resolution: Number(row.resolution),
      metric: row.metric as HistoryPoint["metric"],
      min: Number(row.min),
      max: Number(row.max),
      avg: Number(row.avg),
      count: Number(row.count),
      gap:
        Number(row.last) - Number(row.first) > Number(row.count) * 30_000 ||
        Number(row.count) * 30_000 < Number(row.resolution),
    }));
  }
  bytes(): number {
    return [this.path, `${this.path}-journal`, `${this.path}-wal`, `${this.path}-shm`].reduce((sum, path) => {
      try {
        return sum + require("node:fs").statSync(path).size;
      } catch {
        return sum;
      }
    }, 0);
  }
  status() {
    this.prune();
    return {
      bytes: this.bytes(),
      samples: Number(this.db.prepare("SELECT count(*) AS count FROM points").get()?.count ?? 0),
    };
  }
  clear(): void {
    this.db.exec("DELETE FROM points; VACUUM");
  }
  close(): void {
    this.db.close();
  }
}
