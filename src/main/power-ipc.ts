import { randomUUID } from "node:crypto";
import { Main } from "@freelensapp/extensions";
import { AI_PROGRESS_CHANNEL } from "../common/ai";

import type { WebContents, WebFrameMain } from "electron";

type Handler = Parameters<Main.Ipc["handle"]>[1];
type FrameEvent = { channel: string; args: unknown[] };
type Recipient = { channels: Set<string>; origin: string; token: string; events: FrameEvent[]; bytes: number };
let recipients = new WeakMap<WebFrameMain, Recipient>();

export class PowerIpc extends Main.Ipc {}

const handlers = new Map<string, Handler>();
const registered = new Set<string>();
const maximumQueuedEvents = 512;
const maximumQueuedBytes = 2 * 1024 * 1024;

export const powerIpc = {
  handle(channel: string, handler: Handler): void {
    if (handlers.has(channel)) throw new Error(`IPC handler already registered: ${channel}`);
    handlers.set(channel, handler);
    if (!registered.has(channel)) {
      PowerIpc.getInstance().handle(channel, (event, ...args: unknown[]) => {
        const current = handlers.get(channel);
        if (!current) throw new Error("Extension feature is unavailable");
        return current(event, ...args);
      });
      registered.add(channel);
    }
  },
  removeHandler(channel: string): void {
    handlers.delete(channel);
  },
  sendToFrame(frame: WebFrameMain, channel: string, ...args: unknown[]): void {
    const recipient = recipients.get(frame);
    if (
      !recipient ||
      frame.detached ||
      new URL(frame.url).origin !== recipient.origin ||
      !recipient.channels.has(channel)
    )
      return;
    const event = { channel, args: structuredClone(args) };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (channel.startsWith("freelens-power:dashboard")) {
      const index = recipient.events.findIndex(
        (pending) =>
          pending.channel === channel &&
          (pending.args[0] as { id?: unknown } | undefined)?.id === (args[0] as { id?: unknown } | undefined)?.id,
      );
      if (index >= 0) {
        recipient.bytes -= Buffer.byteLength(JSON.stringify(recipient.events[index]));
        recipient.events.splice(index, 1);
      }
    }
    const previous = recipient.events.at(-1);
    const request = args[0] as { requestId?: unknown } | undefined;
    const priorRequest = previous?.args[0] as { requestId?: unknown } | undefined;
    if (
      channel === AI_PROGRESS_CHANNEL &&
      previous?.channel === channel &&
      request?.requestId === priorRequest?.requestId
    ) {
      recipient.bytes -= Buffer.byteLength(JSON.stringify(previous));
      recipient.events.pop();
    }
    if (recipient.events.length >= maximumQueuedEvents || recipient.bytes + bytes > maximumQueuedBytes) {
      if (channel.startsWith("freelens-power:dashboard")) return;
      throw new Error("Renderer event queue exceeds the safety limit");
    }
    recipient.events.push(event);
    recipient.bytes += bytes;
  },
  sendToContents(sender: WebContents, channel: string, ...args: unknown[]): void {
    if (!sender.isDestroyed()) powerIpc.sendToFrame(sender.mainFrame, channel, ...args);
  },
};

export function initializePowerIpc(extension: Main.LensExtension): void {
  handlers.clear();
  registered.clear();
  recipients = new WeakMap();
  PowerIpc.createInstance(extension);
  powerIpc.handle("freelens-power:renderer-identity", (event) => {
    const frame = event.senderFrame;
    if (!frame || frame.detached) throw new Error("Renderer frame is unavailable");
    const url = new URL(frame.url);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "renderer.freelens.app" || url.hostname.endsWith(".renderer.freelens.app"))
    )
      throw new Error("Untrusted renderer");
    let recipient = recipients.get(frame);
    if (!recipient || recipient.origin !== url.origin) {
      recipient = { channels: new Set(), origin: url.origin, token: randomUUID(), events: [], bytes: 0 };
      recipients.set(frame, recipient);
    }
    return { token: recipient.token };
  });
  powerIpc.handle("freelens-power:events-subscribe", (event, token: unknown, channels: unknown) => {
    const frame = event.senderFrame;
    const recipient = frame && !frame.detached ? recipients.get(frame) : undefined;
    if (!recipient || !frame || new URL(frame.url).origin !== recipient.origin || token !== recipient.token)
      throw new Error("Renderer event owner mismatch");
    if (
      !Array.isArray(channels) ||
      channels.length > 64 ||
      channels.some((channel) => typeof channel !== "string" || channel.length > 256)
    )
      throw new Error("Invalid renderer event subscription");
    recipient.channels = new Set(channels);
    recipient.events = recipient.events.filter((event) => recipient.channels.has(event.channel));
    recipient.bytes = recipient.events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
  });
  powerIpc.handle("freelens-power:events-poll", (event, token: unknown) => {
    const frame = event.senderFrame;
    const recipient = frame && !frame.detached ? recipients.get(frame) : undefined;
    if (!recipient || !frame || new URL(frame.url).origin !== recipient.origin || token !== recipient.token)
      throw new Error("Renderer event owner mismatch");
    const events = recipient.events;
    recipient.events = [];
    recipient.bytes = 0;
    return events;
  });
}

export function disposePowerIpc(): void {
  handlers.clear();
  registered.clear();
  recipients = new WeakMap();
  PowerIpc.resetInstance();
}
