import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeDashboardNetwork } from "./dashboard-network";

import type { WebContents } from "electron";

function contents(attached = false, setup = Promise.resolve({})) {
  const protocol = Object.assign(new EventEmitter(), {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    sendCommand: vi.fn().mockReturnValue(setup),
  });
  const source = Object.assign(new EventEmitter(), { debugger: protocol });
  return { source, protocol, monitor: observeDashboardNetwork(source as unknown as WebContents) };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("waits for slow SPA requests and a quiet interval after completion or failure", async () => {
  const { monitor, protocol } = contents();
  protocol.emit("message", {}, "Network.requestWillBeSent", { requestId: "fetch", type: "Fetch" });
  protocol.emit("message", {}, "Network.requestWillBeSent", { requestId: "xhr", type: "XHR" });
  const done = vi.fn();
  const waiting = monitor.wait().then(done);
  await vi.advanceTimersByTimeAsync(3000);
  expect(done).not.toHaveBeenCalled();
  protocol.emit("message", {}, "Network.loadingFinished", { requestId: "fetch" });
  await vi.advanceTimersByTimeAsync(500);
  expect(done).not.toHaveBeenCalled();
  protocol.emit("message", {}, "Network.loadingFailed", { requestId: "xhr" });
  await vi.advanceTimersByTimeAsync(349);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await waiting;
  expect(done).toHaveBeenCalledOnce();
  monitor.dispose();
  expect(protocol.detach).toHaveBeenCalledOnce();
  expect(protocol.listenerCount("message")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not wait for streams and releases pending waits when its view is destroyed", async () => {
  const { source, monitor, protocol } = contents();
  for (const type of ["WebSocket", "EventSource"])
    protocol.emit("message", {}, "Network.requestWillBeSent", { requestId: type, type });
  await vi.advanceTimersByTimeAsync(350);
  expect(monitor.quiet()).toBe(true);
  protocol.emit("message", {}, "Network.requestWillBeSent", { requestId: "pending", type: "Fetch" });
  const waiting = monitor.wait();
  source.emit("destroyed");
  await waiting;
  expect(protocol.detach).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("leaves an existing debugger untouched and does not detach a replacement debugger", async () => {
  const existing = contents(true);
  await existing.monitor.wait();
  existing.monitor.dispose();
  expect(existing.protocol.attach).not.toHaveBeenCalled();
  expect(existing.protocol.sendCommand).not.toHaveBeenCalled();
  expect(existing.protocol.detach).not.toHaveBeenCalled();
  const replacement = contents();
  replacement.protocol.emit("detach", {}, "target closed");
  replacement.monitor.dispose();
  expect(replacement.protocol.detach).not.toHaveBeenCalled();
});

it("arms setup fallback only after navigation and does not detach during a slow initial load", async () => {
  const { monitor, protocol } = contents(false, new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(3000);
  expect(protocol.detach).not.toHaveBeenCalled();
  const done = vi.fn();
  const ready = monitor.ready().then(done);
  await vi.advanceTimersByTimeAsync(499);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await ready;
  expect(protocol.detach).toHaveBeenCalledOnce();
  expect(monitor.quiet()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
