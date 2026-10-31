import type { LogCapture } from "../common/power-logs";

type Draft = { sql: string; version: number; lifetime: object };

export class CaptureSqlDrafts {
  private local = new Map<string, Draft>();
  private pending = new Map<string, Draft>();
  private writes = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;
  private disposed = false;

  constructor(
    private save: (id: string, sql: string) => Promise<unknown>,
    private onError?: (id: string, error: unknown) => void,
  ) {}

  read(capture: LogCapture, fallback: string): string {
    return this.local.get(capture.id)?.sql ?? capture.lastSql ?? fallback;
  }

  set(id: string, sql: string): void {
    if (this.disposed) return;
    const draft = { sql, version: ++this.version, lifetime: this.local.get(id)?.lifetime ?? {} };
    this.local.set(id, draft);
    this.pending.set(id, draft);
    this.clearTimer();
    this.timer = setTimeout(() => {
      void this.flush();
    }, 250);
  }

  async flush(): Promise<void> {
    this.clearTimer();
    for (;;) {
      const pending = [...this.pending];
      this.pending.clear();
      for (const [id, draft] of pending) this.enqueue(id, draft);
      const writes = [...this.writes.values()];
      if (!writes.length) return;
      await Promise.all(writes);
      if (!this.pending.size && !this.writes.size) return;
      this.clearTimer();
    }
  }

  forget(id: string): void {
    this.local.delete(id);
    this.pending.delete(id);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.flush();
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private enqueue(id: string, draft: Draft): void {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const write = previous.then(async () => {
      if (this.local.get(id)?.lifetime !== draft.lifetime) return;
      try {
        await this.save(id, draft.sql);
      } catch (error) {
        // retain the local draft without retrying failed writes or reporting obsolete failures
        if (!this.disposed && this.local.get(id)?.version === draft.version) {
          try {
            this.onError?.(id, error);
          } catch {
            /* error feedback must not break later saves */
          }
        }
      }
    });
    const tracked = write.finally(() => {
      if (this.writes.get(id) === tracked) this.writes.delete(id);
    });
    this.writes.set(id, tracked);
  }
}
