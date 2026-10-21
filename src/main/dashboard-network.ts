import type { WebContents } from "electron";

export function observeDashboardNetwork(contents: WebContents) {
  const protocol = contents.debugger;
  const pending = new Set<string>();
  let lastChange = Date.now();
  let owned = false;
  let active = false;
  let disposed = false;
  let ready: Promise<void> | undefined;
  let setupFinished = false;
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  let finishSetup: (() => void) | undefined;
  const waits = new Map<ReturnType<typeof setInterval>, () => void>();
  const quiet = () => !active || (pending.size === 0 && Date.now() - lastChange >= 350);
  const release = () => {
    for (const [timer, resolve] of waits) {
      clearInterval(timer);
      resolve();
    }
    waits.clear();
  };
  const detached = () => {
    owned = false;
    active = false;
    pending.clear();
    finishSetup?.();
    release();
  };
  const message = (_event: unknown, method: string, params: { requestId?: unknown; type?: unknown }) => {
    if (!active || typeof params?.requestId !== "string") return;
    const id = params.requestId;
    if (method === "Network.requestWillBeSent") {
      if (params.type === "WebSocket" || params.type === "EventSource") return;
      pending.add(id);
      lastChange = Date.now();
    } else if (method === "Network.responseReceived" && params.type === "EventSource") {
      if (pending.delete(id)) lastChange = Date.now();
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      if (pending.delete(id)) lastChange = Date.now();
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    finishSetup?.();
    active = false;
    pending.clear();
    release();
    contents.removeListener("destroyed", dispose);
    protocol?.removeListener("message", message);
    protocol?.removeListener("detach", detached);
    if (owned) {
      owned = false;
      try {
        if (protocol.isAttached()) protocol.detach();
      } catch {}
    }
  };
  try {
    if (protocol && !protocol.isAttached()) {
      protocol.attach("1.3");
      owned = true;
      active = true;
      protocol.on("message", message);
      protocol.on("detach", detached);
      contents.on("destroyed", dispose);
      ready = new Promise<void>((resolve) => {
        finishSetup = () => {
          setupFinished = true;
          clearTimeout(setupTimer);
          resolve();
        };
      });
      void protocol.sendCommand("Network.enable").then(() => finishSetup?.(), dispose);
    }
  } catch {
    dispose();
  }
  return {
    ready: () => {
      if (ready && !setupFinished && !setupTimer) setupTimer = setTimeout(dispose, 500);
      return ready ?? Promise.resolve();
    },
    quiet,
    wait: () =>
      new Promise<void>((resolve) => {
        if (quiet()) {
          resolve();
          return;
        }
        const timer = setInterval(() => {
          if (!quiet()) return;
          clearInterval(timer);
          waits.delete(timer);
          resolve();
        }, 50);
        waits.set(timer, resolve);
      }),
    dispose,
  };
}
