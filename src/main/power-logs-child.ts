import { copyFile } from "node:fs/promises";
import { POWER_LOGS_STORAGE_FULL } from "../common/power-logs";
import { applyPowerLogsLimits } from "../common/power-logs-limits";
import { PowerLogsDatabase } from "./power-logs-database";

import type { LogRequest } from "../common/power-logs";

const port = process.parentPort;
if (!port) throw new Error("Log process requires parent");
const engine = new PowerLogsDatabase(process.argv[2], process.argv[3]);
const queries = new Map<string, { id: number; started: boolean; canceled: boolean }>();
const queryKey = (request: LogRequest & { queryId: string }) =>
  JSON.stringify([request.clusterId, request.contextId, request.queryId]);
let queue = Promise.resolve(),
  queuedCount = 0;
port.on(
  "message",
  ({ data }: { data: { id: number; request: LogRequest; destination?: string; limits?: unknown } }) => {
    if (data.request.operation === "cancel") {
      const pending = queries.get(queryKey(data.request));
      if (pending && !pending.started) {
        if (!pending.canceled) port.postMessage({ id: pending.id, error: "Log query canceled" });
        pending.canceled = true;
        port.postMessage({ id: data.id, result: true });
        return;
      }
      void engine.run(data.request).then(
        (result) => port.postMessage({ id: data.id, result }),
        () => port.postMessage({ id: data.id, error: "Log operation failed or exceeded its limit" }),
      );
      return;
    }
    const key = data.request.operation === "query" ? queryKey(data.request) : undefined;
    if (key && queries.size) {
      port.postMessage({ id: data.id, error: "Log query is busy" });
      return;
    }
    if (queuedCount >= 16) {
      port.postMessage({ id: data.id, error: "Log operation queue is full" });
      return;
    }
    const pending = key ? { id: data.id, started: false, canceled: false } : undefined;
    if (key && pending) queries.set(key, pending);
    queuedCount++;
    const run = async () => {
      try {
        if (pending?.canceled) return;
        applyPowerLogsLimits(data.limits);
        if (pending) pending.started = true;
        const result =
          data.request.operation === "export" && data.destination
            ? await copyFile(engine.exportPath(data.request), data.destination).then(() => true)
            : await engine.run(data.request);
        port.postMessage({ id: data.id, result });
      } catch (error) {
        port.postMessage({
          id: data.id,
          error:
            error instanceof Error &&
            (error.message === POWER_LOGS_STORAGE_FULL ||
              error.message === "Saved snapshot limit reached. Delete a saved snapshot before keeping another.")
              ? error.message
              : "Log operation failed or exceeded its limit",
        });
      } finally {
        queuedCount--;
        if (key) queries.delete(key);
      }
    };
    queue = queue.then(run);
  },
);
