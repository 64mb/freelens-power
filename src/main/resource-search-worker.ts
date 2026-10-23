import { Worker } from "node:worker_threads";
import { ResourceSearchDatabase } from "./resource-search-database";

import type { SearchIndexRequest } from "../common/resource-search";

export class ResourceSearchWorker {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private failure = false;

  constructor(path: string) {
    // the serialized engine remains self-contained in both bundled and preserved builds
    this.worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');
      const Engine=${ResourceSearchDatabase.toString()};let engine;
      parentPort.on('message',({id,request})=>{
        try { engine??=new Engine(workerData);parentPort.postMessage({id,result:engine.run(request)}); }
        catch(error) { parentPort.postMessage({id,error:error?.errcode===13?'Search storage is full; clear the local search cache to continue':'Search index operation failed'}); }
      });`,
      { eval: true, workerData: path },
    );
    this.worker.on("message", ({ id, result, error }) => {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (error) pending?.reject(new Error(error));
      else pending?.resolve(result);
    });
    this.worker.on("error", () => this.fail());
    this.worker.on("exit", () => this.fail());
  }

  private fail(): void {
    this.failure = true;
    for (const pending of this.pending.values()) pending.reject(new Error("Local search index is unavailable"));
    this.pending.clear();
  }

  call(request: SearchIndexRequest): Promise<unknown> {
    if (this.failure) return Promise.reject(new Error("Local search index is unavailable"));
    if (this.pending.size >= 16) return Promise.reject(new Error("Local search index is busy"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, request });
    });
  }

  close(): void {
    this.fail();
    void this.worker.terminate();
  }
}
