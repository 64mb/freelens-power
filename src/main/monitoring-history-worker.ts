import { Worker } from "node:worker_threads";
import { MonitoringHistoryDatabase } from "./monitoring-history-database";

export class MonitoringHistoryWorker {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private failure?: Error;
  constructor(path: string) {
    // the serialized engine has no module-level runtime dependencies and survives bundled builds
    this.worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
      const Engine = ${MonitoringHistoryDatabase.toString()};
      let engine;
      parentPort.on('message', ({id, operation, value}) => {
        try {
          engine ??= new Engine(workerData);
          const result = operation === 'append' ? engine.append(value) : operation === 'query' ? engine.query(value) : operation === 'clear' ? engine.clear() : engine.status();
          parentPort.postMessage({ id, result });
        } catch { parentPort.postMessage({ id, error: true }); }
      });`,
      { eval: true, workerData: path },
    );
    this.worker.on("message", ({ id, result, error }) => {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (error) pending?.reject(new Error("Local SQLite history is unavailable"));
      else pending?.resolve(result);
    });
    this.worker.on("error", () => this.fail());
    this.worker.on("exit", () => this.fail());
  }
  private fail(): void {
    this.failure = new Error("Local SQLite history is unavailable");
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }
  call(operation: "append" | "query" | "clear" | "status", value?: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 8) return Promise.reject(new Error("History is busy"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, operation, value });
    });
  }
  close(): void {
    this.fail();
    void this.worker.terminate();
  }
}
