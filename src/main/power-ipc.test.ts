import { beforeEach, expect, it, vi } from "vitest";
import { AI_PROGRESS_CHANNEL } from "../common/ai";
import { initializePowerIpc, powerIpc } from "./power-ipc";

const host = vi.hoisted(() => ({ handle: vi.fn(), broadcast: vi.fn() }));
vi.mock("@freelensapp/extensions", () => ({
  Main: {
    Ipc: class {
      static createInstance() {}
      static getInstance() {
        return host;
      }
      static resetInstance() {}
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  initializePowerIpc({} as import("@freelensapp/extensions").Main.LensExtension);
});

function handler(name: string) {
  return host.handle.mock.calls.find(([channel]) => channel === name)![1];
}
const identity = (frame: object) => {
  const result = handler("freelens-power:renderer-identity")({ senderFrame: frame });
  handler("freelens-power:events-subscribe")({ senderFrame: frame }, result.token, [
    "activity",
    AI_PROGRESS_CHANNEL,
    "freelens-power:dashboard-site-icon",
  ]);
  return result;
};
const poll = (frame: object, token: string) => handler("freelens-power:events-poll")({ senderFrame: frame }, token);
const frame = (name: string) => ({ url: `https://${name}.renderer.freelens.app/`, detached: false });

it("retains one host dispatcher while a feature is stopped and restarted", () => {
  powerIpc.handle("feature", () => "first");
  const dispatch = handler("feature");
  expect(dispatch({}, "input")).toBe("first");
  powerIpc.removeHandler("feature");
  expect(() => dispatch({})).toThrow("unavailable");
  powerIpc.handle("feature", () => "second");
  expect(dispatch({})).toBe("second");
  expect(host.handle.mock.calls.filter(([channel]) => channel === "feature")).toHaveLength(1);
});

it("drains replies only to the actual originating frame and never broadcasts payloads", () => {
  const first = frame("one");
  const second = frame("two");
  const a = identity(first);
  const b = identity(second);
  powerIpc.sendToFrame(first as import("electron").WebFrameMain, "activity", { secret: "first-frame-data" });
  expect(() => poll(second, a.token)).toThrow("owner mismatch");
  expect(poll(second, b.token)).toEqual([]);
  expect(poll(first, a.token)).toEqual([{ channel: "activity", args: [{ secret: "first-frame-data" }] }]);
  expect(poll(first, a.token)).toEqual([]);
  expect(host.broadcast).not.toHaveBeenCalled();
});

it("coalesces adjacent progress snapshots and retains ordered read activity", () => {
  const owner = frame("one");
  const { token } = identity(owner);
  for (let index = 0; index < 1000; index++)
    powerIpc.sendToFrame(owner as import("electron").WebFrameMain, AI_PROGRESS_CHANNEL, {
      requestId: "request",
      text: String(index),
    });
  powerIpc.sendToFrame(owner as import("electron").WebFrameMain, "activity", "first");
  powerIpc.sendToFrame(owner as import("electron").WebFrameMain, "activity", "second");
  expect(poll(owner, token)).toEqual([
    { channel: AI_PROGRESS_CHANNEL, args: [{ requestId: "request", text: "999" }] },
    { channel: "activity", args: ["first"] },
    { channel: "activity", args: ["second"] },
  ]);
});

it("bounds queue growth without silently discarding events", () => {
  const owner = frame("one");
  const { token } = identity(owner);
  for (let index = 0; index < 512; index++)
    powerIpc.sendToFrame(owner as import("electron").WebFrameMain, "activity", index);
  expect(() => powerIpc.sendToFrame(owner as import("electron").WebFrameMain, "activity", "overflow")).toThrow(
    "safety limit",
  );
  expect(poll(owner, token)).toHaveLength(512);
});

it("rejects untrusted identities and clears access after navigation to another origin", () => {
  expect(() => identity({ url: "https://example.com/" })).toThrow("Untrusted");
  const owner = frame("one");
  const { token } = identity(owner);
  powerIpc.sendToFrame(owner as import("electron").WebFrameMain, "activity", "old-page");
  owner.url = "https://example.com/";
  expect(() => poll(owner, token)).toThrow("owner mismatch");
  owner.url = "https://two.renderer.freelens.app/";
  const next = identity(owner);
  expect(next.token).not.toBe(token);
  expect(poll(owner, next.token)).toEqual([]);
});

it("discards unsubscribed events and bounds noncritical dashboard icons without throwing", () => {
  const owner = frame("one");
  const { token } = identity(owner);
  const contents = { mainFrame: owner, isDestroyed: () => false } as unknown as import("electron").WebContents;
  for (let index = 0; index < 3; index++)
    expect(() =>
      powerIpc.sendToContents(contents, "freelens-power:dashboard-site-icon", {
        id: String(index),
        url: "a".repeat(720000),
      }),
    ).not.toThrow();
  expect(poll(owner, token).length).toBeLessThanOrEqual(2);
  handler("freelens-power:events-subscribe")({ senderFrame: owner }, token, []);
  for (let index = 0; index < 600; index++)
    powerIpc.sendToFrame(owner as import("electron").WebFrameMain, "activity", index);
  expect(poll(owner, token)).toEqual([]);
});
