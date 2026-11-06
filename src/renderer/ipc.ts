import { Common, Renderer } from "@freelensapp/extensions";

class PowerIpc extends Renderer.Ipc {}

type Listener = Parameters<Renderer.Ipc["listen"]>[1];
interface QueuedEvent {
  channel: string;
  args: unknown[];
}
let identity: Promise<{ token: string }> | undefined;
const listeners = new Map<string, Set<Listener>>();
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
let generation = 0;
let subscription = Promise.resolve();
let subscriptionRevision = 0;

function syncSubscriptions(): void {
  const currentIdentity = identity;
  const currentGeneration = generation;
  const revision = ++subscriptionRevision;
  const channels = [...listeners.keys()];
  subscription = subscription
    .catch(() => {})
    .then(async () => {
      if (!currentIdentity) return;
      const { token } = await currentIdentity;
      if (currentGeneration !== generation || revision !== subscriptionRevision) return;
      await PowerIpc.getInstance().invoke("freelens-power:events-subscribe", token, channels);
    });
  void subscription.catch(() => {});
}

function schedulePoll(delay = 100): void {
  if (pollTimer !== undefined || polling || listeners.size === 0 || !identity) return;
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    void pollEvents();
  }, delay);
}

async function pollEvents(): Promise<void> {
  const currentIdentity = identity;
  const currentGeneration = generation;
  if (!currentIdentity || listeners.size === 0) return;
  polling = true;
  try {
    const { token } = await currentIdentity;
    await subscription;
    if (currentGeneration !== generation || listeners.size === 0) return;
    const events: QueuedEvent[] = await PowerIpc.getInstance().invoke("freelens-power:events-poll", token);
    if (currentGeneration !== generation) return;
    for (const event of events) {
      for (const listener of [...(listeners.get(event.channel) ?? [])]) {
        if (!listeners.get(event.channel)?.has(listener)) continue;
        try {
          listener(undefined, ...event.args);
        } catch {
          Common.logger.warn("[Freelens Power] event listener failed", { channel: event.channel });
        }
      }
    }
  } catch {
    // a reload or temporary main-process failure is retried while a listener remains
  } finally {
    if (currentGeneration === generation) {
      polling = false;
      schedulePoll();
    }
  }
}

export function initializeIpc(extension: Renderer.LensExtension): void {
  PowerIpc.createInstance(extension);
  identity = PowerIpc.getInstance().invoke("freelens-power:renderer-identity");
  void identity?.catch(() => {});
}

export function disposeIpc(): void {
  generation++;
  subscriptionRevision++;
  subscription = Promise.resolve();
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
  polling = false;
  listeners.clear();
  identity = undefined;
  PowerIpc.resetInstance();
}

export const ipcRenderer = {
  invoke: async (...args: Parameters<Renderer.Ipc["invoke"]>) => {
    if (!identity) throw new Error("Extension IPC is not initialized");
    const currentIdentity = identity;
    await currentIdentity;
    await subscription;
    if (identity !== currentIdentity) throw new Error("Extension IPC was deactivated");
    return PowerIpc.getInstance().invoke(...args);
  },
  on(channel: string, listener: Listener): void {
    if (!identity) throw new Error("Extension IPC is not initialized");
    let channelListeners = listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set();
      listeners.set(channel, channelListeners);
    }
    channelListeners.add(listener);
    syncSubscriptions();
    schedulePoll(0);
  },
  removeListener(channel: string, listener: Listener): void {
    const channelListeners = listeners.get(channel);
    channelListeners?.delete(listener);
    if (channelListeners?.size === 0) {
      listeners.delete(channel);
      syncSubscriptions();
    }
    if (listeners.size === 0 && pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  },
};

export const shell = {
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("freelens-power:open-external", url),
};

export const clipboard = {
  writeText: (text: string): Promise<void> => navigator.clipboard.writeText(text),
};
