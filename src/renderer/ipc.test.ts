import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), reset: vi.fn(), warn: vi.fn() }));
vi.mock("@freelensapp/extensions", () => ({
  Common: { logger: { warn: mocks.warn } },
  Renderer: {
    Ipc: class {
      static createInstance() {}
      static getInstance() {
        return { invoke: mocks.invoke };
      }
      static resetInstance() {
        mocks.reset();
      }
    },
  },
}));

import { Renderer } from "@freelensapp/extensions";
import { disposeIpc, initializeIpc, ipcRenderer } from "./ipc";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (channel: string) =>
    channel === "freelens-power:renderer-identity" ? { token: "private-frame-token" } : [],
  );
});
afterEach(() => {
  disposeIpc();
  vi.useRealTimers();
});

it("polls only its frame queue and preserves event order for registered listeners", async () => {
  initializeIpc({} as Renderer.LensExtension);
  const listener = vi.fn();
  ipcRenderer.on("progress", listener);
  mocks.invoke.mockImplementation(async (channel: string) =>
    channel === "freelens-power:events-poll"
      ? [
          { channel: "progress", args: [{ text: "first" }] },
          { channel: "progress", args: [{ text: "second" }] },
        ]
      : undefined,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.invoke).toHaveBeenLastCalledWith("freelens-power:events-poll", "private-frame-token");
  expect(listener.mock.calls).toEqual([
    [undefined, { text: "first" }],
    [undefined, { text: "second" }],
  ]);
  ipcRenderer.removeListener("progress", listener);
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for identity registration before invoking a resource request", async () => {
  let identify!: (value: { token: string }) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        identify = resolve;
      }),
  );
  initializeIpc({} as Renderer.LensExtension);
  const result = ipcRenderer.invoke("resources", { clusterId: "example" });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  identify({ token: "private-frame-token" });
  await result;
  expect(mocks.invoke).toHaveBeenLastCalledWith("resources", { clusterId: "example" });
});

it("does not poll without listeners or after the last listener is removed", async () => {
  initializeIpc({} as Renderer.LensExtension);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  const listener = vi.fn();
  ipcRenderer.on("progress", listener);
  ipcRenderer.removeListener("progress", listener);
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.invoke.mock.calls.some(([channel]) => channel === "freelens-power:events-poll")).toBe(false);
});

it("drops an in-flight poll result after deactivation", async () => {
  let finish!: (value: unknown) => void;
  initializeIpc({} as Renderer.LensExtension);
  const listener = vi.fn();
  ipcRenderer.on("progress", listener);
  mocks.invoke.mockImplementation((channel: string) =>
    channel === "freelens-power:events-poll"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(undefined),
  );
  await vi.advanceTimersByTimeAsync(0);
  disposeIpc();
  finish([{ channel: "progress", args: ["stale"] }]);
  await Promise.resolve();
  expect(listener).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
