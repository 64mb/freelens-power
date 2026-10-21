import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain } from "electron";
import { EXTENSION_DISPLAY_NAME } from "../common/extension-info";

const diagnosticsKey = `sidebar-item-${EXTENSION_DISPLAY_NAME.replace("@", "").replace("/", "--")}`;
const nativeItems = [
  "favorites",
  "cluster-overview",
  "nodes",
  "workloads",
  "config",
  "network",
  "storage",
  "namespaces",
  "events",
  "helm",
  "user-management",
  "custom-resources",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function startDiagnosticsMenuOrder(): () => void {
  try {
    const path = join(app.getPath("userData"), "lens-user-store.json");
    const channel = `store-sync-main:${path}`;
    if (!ipcMain.listenerCount(channel)) return () => {};
    const model: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(model)) return () => {};
    const preferences = model.preferences ?? {};
    if (!isRecord(preferences)) return () => {};
    const order = preferences.clusterPageMenuOrder ?? {};
    if (!isRecord(order) || Object.values(order).some((value) => typeof value !== "number" || !Number.isFinite(value)))
      return () => {};
    // preserve explicit user ordering after the initial native default has been replaced
    if (order[diagnosticsKey] !== undefined && order[diagnosticsKey] !== 9999) return () => {};
    const effectiveOrder = Object.fromEntries(nativeItems.map((id, index) => [`sidebar-item-${id}`, index * 10]));
    Object.assign(effectiveOrder, order);
    const favorites = effectiveOrder["sidebar-item-favorites"];
    const next = Math.min(
      ...Object.entries(effectiveOrder)
        .filter(([key, value]) => key !== diagnosticsKey && value > favorites)
        .map(([, value]) => value),
    );
    const position = Number.isFinite(next) ? favorites / 2 + next / 2 : favorites + 5;
    if (!Number.isFinite(position) || position <= favorites || position >= next) return () => {};
    preferences.clusterPageMenuOrder = { ...order, [diagnosticsKey]: position };
    model.preferences = preferences;
    ipcMain.emit(channel, { frameId: -1, processId: process.pid }, model);
  } catch {
    // native preferences may be unavailable during startup or on unsupported host versions
  }
  return () => {};
}
