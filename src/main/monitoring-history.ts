import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Main } from "@freelensapp/extensions";
import { app, BrowserWindow, type IpcMainInvokeEvent, ipcMain } from "electron";
import {
  HISTORY_RETENTION,
  type HistoryRequest,
  type HistoryStatus,
  MONITORING_HISTORY_CHANNEL,
  projectHistorySamples,
  validHistoryIdentity,
} from "../common/monitoring-history";
import { MonitoringPreferencesStore } from "../common/store/monitoring-preferences-store";
import { MonitoringHistoryWorker } from "./monitoring-history-worker";

function trusted(event: IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame?.url ?? "");
    const senderUrl = new URL(event.sender.getURL());
    return (
      url.protocol === "https:" &&
      senderUrl.origin === url.origin &&
      (url.hostname === "renderer.freelens.app" || url.hostname.endsWith(".renderer.freelens.app"))
    );
  } catch {
    return false;
  }
}
export function startMonitoringHistory(_extension: Main.LensExtension): () => void {
  let active = true;
  let database: MonitoringHistoryWorker | undefined;
  let error: string | undefined;
  const databasePath = join(app.getPath("userData"), "freelens-power-history", "monitoring.sqlite");
  const preferences = MonitoringPreferencesStore.getInstanceOrCreate<MonitoringPreferencesStore>();
  const open = () => {
    if (!database && !error) {
      try {
        const directory = join(app.getPath("userData"), "freelens-power-history");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        database = new MonitoringHistoryWorker(databasePath);
      } catch {
        error = "Local SQLite history is unavailable in this Freelens runtime";
      }
    }
    return database;
  };
  ipcMain.handle(MONITORING_HISTORY_CHANNEL, async (event, request: HistoryRequest) => {
    if (!active || !trusted(event)) throw new Error("History unavailable");
    if (!request || !["status", "clear", "query", "append"].includes(request.operation))
      throw new Error("Invalid history operation");
    if (request.operation === "clear") {
      await open()?.call("clear");
      return true;
    }
    if (request.operation === "status") {
      const db = preferences.historyEnabled || existsSync(databasePath) ? open() : database;
      let stats = { bytes: 0, samples: 0 };
      if (db) {
        try {
          stats = (await db.call("status")) as typeof stats;
        } catch {
          error = "Local SQLite history is unavailable in this Freelens runtime";
        }
      }
      return { available: !error, enabled: preferences.historyEnabled, ...stats, error } satisfies HistoryStatus;
    }
    if (!preferences.historyEnabled) return request.operation === "query" ? [] : false;
    const db = open();
    if (!db) throw new Error(error);
    if (request.operation === "append") {
      if (!preferences.enabled) return false;
      const samples = projectHistorySamples(request.samples);
      if (samples.some((sample) => !Main.Catalog.getClusterById(sample.clusterId))) throw new Error("Unknown cluster");
      await db.call("append", samples);
      return true;
    }
    if (request.operation !== "query") throw new Error("Invalid history operation");
    const query = request.query;
    const now = Date.now();
    if (
      !validHistoryIdentity(query) ||
      !Number.isSafeInteger(query.from) ||
      !Number.isSafeInteger(query.to) ||
      query.from > query.to ||
      query.from < now - HISTORY_RETENTION ||
      query.to > now + 30_000 ||
      !Main.Catalog.getClusterById(query.clusterId)
    )
      throw new Error("Invalid history query");
    return db.call("query", {
      clusterId: query.clusterId,
      scope: query.scope,
      uid: query.uid,
      from: query.from,
      to: query.to,
    });
  });
  return () => {
    active = false;
    ipcMain.removeHandler(MONITORING_HISTORY_CHANNEL);
    database?.close();
    database = undefined;
  };
}
