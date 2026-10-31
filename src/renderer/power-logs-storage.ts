import { ipcRenderer } from "electron";
import { type LogStorageStatus, POWER_LOGS_STORAGE_CHANNEL } from "../common/power-logs";

export const powerLogsStorage = {
  status: (): Promise<LogStorageStatus> => ipcRenderer.invoke(POWER_LOGS_STORAGE_CHANNEL, { operation: "status" }),
  clear: (): Promise<boolean> => ipcRenderer.invoke(POWER_LOGS_STORAGE_CHANNEL, { operation: "clear" }),
};
