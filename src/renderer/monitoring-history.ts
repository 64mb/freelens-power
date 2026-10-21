import { ipcRenderer } from "electron";
import {
  type HistoryPoint,
  type HistoryQuery,
  type HistorySample,
  type HistoryStatus,
  MONITORING_HISTORY_CHANNEL,
} from "../common/monitoring-history";
export const monitoringHistory = {
  append: (samples: HistorySample[]): Promise<boolean> =>
    ipcRenderer.invoke(MONITORING_HISTORY_CHANNEL, { operation: "append", samples }),
  query: (query: HistoryQuery): Promise<HistoryPoint[]> =>
    ipcRenderer.invoke(MONITORING_HISTORY_CHANNEL, { operation: "query", query }),
  status: (): Promise<HistoryStatus> => ipcRenderer.invoke(MONITORING_HISTORY_CHANNEL, { operation: "status" }),
  clear: (): Promise<boolean> => ipcRenderer.invoke(MONITORING_HISTORY_CHANNEL, { operation: "clear" }),
};
