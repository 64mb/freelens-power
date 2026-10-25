import { ipcRenderer } from "electron";
import {
  type LogCapture,
  type LogPartition,
  type LogQueryResult,
  type LogRecord,
  type LogTarget,
  POWER_LOGS_CHANNEL,
} from "../common/power-logs";

export function createPowerLogsClient(partition: LogPartition) {
  const invoke = <T>(operation: string, fields: object = {}): Promise<T> =>
    ipcRenderer.invoke(POWER_LOGS_CHANNEL, { ...partition, operation, ...fields });
  return {
    list: () => invoke<LogCapture[]>("list"),
    create: (target: LogTarget) => invoke<LogCapture>("create", { target }),
    append: (captureId: string, records: LogRecord[]) => invoke<LogCapture>("append", { captureId, records }),
    finish: (captureId: string, partial: boolean, notes: string[]) =>
      invoke<LogCapture>("finish", { captureId, partial, notes }),
    delete: (captureId: string) => invoke<boolean>("delete", { captureId }),
    saveSql: (captureId: string, sql: string) => invoke<LogCapture>("save-sql", { captureId, sql }),
    query: (captureId: string, queryId: string, sql: string) =>
      invoke<LogQueryResult>("query", { captureId, queryId, sql }),
    cancel: (queryId: string) => invoke<boolean>("cancel", { queryId }),
    export: (captureId: string) => invoke<boolean>("export", { captureId }),
  };
}
