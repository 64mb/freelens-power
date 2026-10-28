import { readFile } from "node:fs/promises";
import { BrowserWindow, ipcMain, net } from "electron";
import { reaction } from "mobx";
import { version as VERSION } from "../../package.json";
import { EXTENSION_UPDATES_CHANNEL, type ExtensionUpdatesStatus, isValidVersion } from "../common/extension-updates";
import { PowerPreferencesStore } from "../common/store/power-preferences-store";

const PACKAGE = "@64mb/freelens-power";
const MAX_BODY = 64 * 1024;

function trustedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "renderer.freelens.app" || url.hostname.endsWith(".renderer.freelens.app"))
    );
  } catch {
    return false;
  }
}

async function readLatest(signal: AbortSignal): Promise<string | undefined> {
  const response = await net.fetch("https://registry.npmjs.org/@64mb%2Ffreelens-power/latest", {
    signal,
    redirect: "error",
  });
  if (!response.ok || !response.body) throw new Error("invalid response");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error("response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (data?.name !== PACKAGE || !isValidVersion(data.version, true)) throw new Error("invalid package");
  return data.version;
}

export function startExtensionUpdates(extension: { manifestPath: string }): () => void {
  const power = PowerPreferencesStore.getInstanceOrCreate<PowerPreferencesStore>();
  let active = true;
  let latestVersion: string | undefined;
  let expires = 0;
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const allowed = () => active && power.enabled && power.checkUpdates;
  const stop = reaction(
    () => power.enabled && power.checkUpdates,
    (enabled) => {
      if (!enabled) {
        controller?.abort();
        latestVersion = undefined;
        expires = 0;
      }
    },
  );
  const status = async (): Promise<ExtensionUpdatesStatus> => {
    let installedVersion = VERSION;
    try {
      const manifest = JSON.parse(await readFile(extension.manifestPath, "utf8"));
      if (manifest?.name === PACKAGE && isValidVersion(manifest.version)) installedVersion = manifest.version;
    } catch {}
    return { runtimeVersion: VERSION, installedVersion, ...(allowed() && latestVersion ? { latestVersion } : {}) };
  };
  ipcMain.handle(EXTENSION_UPDATES_CHANNEL, async (event, request: unknown) => {
    const sender = event.sender;
    const window = BrowserWindow.fromWebContents(sender);
    if (
      !active ||
      event.senderFrame !== sender.mainFrame ||
      !trustedUrl(event.senderFrame?.url ?? "") ||
      !trustedUrl(sender.getURL()) ||
      !window ||
      window.isDestroyed() ||
      !request ||
      typeof request !== "object" ||
      Object.keys(request).length !== 1 ||
      !("operation" in request) ||
      (request.operation !== "check" && request.operation !== "status")
    )
      return null;
    if (request.operation === "check" && allowed() && Date.now() >= expires) {
      if (!pending) {
        const abort = new AbortController();
        controller = abort;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, 10_000);
        pending = (async () => {
          try {
            const version = await readLatest(abort.signal);
            if (allowed() && !abort.signal.aborted) {
              latestVersion = version;
              expires = Date.now() + 6 * 60 * 60 * 1000;
            }
          } catch {
            if (allowed() && (!abort.signal.aborted || timedOut)) {
              latestVersion = undefined;
              expires = Date.now() + 15 * 60 * 1000;
            }
          } finally {
            clearTimeout(timeout);
            if (controller === abort) controller = undefined;
            pending = undefined;
          }
        })();
      }
      await pending;
    }
    return status();
  });
  return () => {
    active = false;
    stop();
    controller?.abort();
    ipcMain.removeHandler(EXTENSION_UPDATES_CHANNEL);
  };
}
