import { type LogStorageStatus, POWER_LOGS_STORAGE_CHANNEL } from "../common/power-logs";
import { ipcRenderer } from "./ipc";

export const powerLogsStorage = {
  status: (): Promise<LogStorageStatus> => ipcRenderer.invoke(POWER_LOGS_STORAGE_CHANNEL, { operation: "status" }),
  clear: (): Promise<boolean> => ipcRenderer.invoke(POWER_LOGS_STORAGE_CHANNEL, { operation: "clear" }),
};
