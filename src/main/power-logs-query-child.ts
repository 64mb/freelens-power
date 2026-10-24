import { applyPowerLogsLimits } from "../common/power-logs-limits";
import { runPowerLogsQuery } from "./power-logs-query";

const port = process.parentPort;
if (!port) throw new Error("Log query process requires parent");
port.on("message", ({ data }: { data: { id: number; database: string; sql: string; limits?: unknown } }) => {
  try {
    applyPowerLogsLimits(data.limits);
    port.postMessage({ id: data.id, result: runPowerLogsQuery(data.database, data.sql) });
  } catch {
    port.postMessage({ id: data.id, error: "Log query failed or exceeded its limit" });
  }
});
