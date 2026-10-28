import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTENSION_UPDATES_CHANNEL, isNewerVersion } from "../common/extension-updates";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  fetch: vi.fn(),
  readFile: vi.fn(),
  window: vi.fn(),
  store: {} as { enabled: boolean; checkUpdates: boolean },
}));
vi.mock("electron", () => ({
  ipcMain: { handle: mocks.handle, removeHandler: mocks.removeHandler },
  BrowserWindow: { fromWebContents: mocks.window },
  net: { fetch: mocks.fetch },
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("../common/store/power-preferences-store", () => ({
  PowerPreferencesStore: { getInstanceOrCreate: () => mocks.store },
}));

import { startExtensionUpdates } from "./extension-updates";

const manifest = (version: string) => ({ name: "@64mb/freelens-power", version });
const response = (value: unknown) => new Response(JSON.stringify(value));
function event(url = "https://renderer.freelens.app/") {
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: frame, getURL: () => url } };
}
let dispose: (() => void) | undefined;
let call: (senderEvent: ReturnType<typeof event>, request: unknown) => Promise<any>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.store = observable({ enabled: true, checkUpdates: true });
  mocks.window.mockReturnValue({ isDestroyed: () => false });
  mocks.readFile.mockResolvedValue(JSON.stringify(manifest("2.8.4")));
  mocks.fetch.mockImplementation(async () => response(manifest("3.0.0")));
  dispose = startExtensionUpdates({ manifestPath: "/extension/package.json" });
  call = mocks.handle.mock.calls[0][1];
});
afterEach(() => {
  dispose?.();
  vi.useRealTimers();
});

describe("extension update backend", () => {
  it("reads installed version without networking and falls back when missing", async () => {
    expect((await call(event(), { operation: "status" })).installedVersion).toBe("2.8.4");
    mocks.readFile.mockRejectedValue(new Error("missing"));
    const result = await call(event(), { operation: "status" });
    expect(result.installedVersion).toBe(result.runtimeVersion);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects untrusted frames and arbitrary request fields", async () => {
    expect(await call(event("https://example.invalid/"), { operation: "check" })).toBeNull();
    const child = event();
    child.senderFrame = { url: child.senderFrame.url };
    expect(await call(child, { operation: "check" })).toBeNull();
    expect(await call(event(), { operation: "check", url: "https://example.invalid" })).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent checks and caches successful versions for six hours", async () => {
    const results = await Promise.all([call(event(), { operation: "check" }), call(event(), { operation: "check" })]);
    expect(results[0].latestVersion).toBe("3.0.0");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await call(event(), { operation: "check" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    await call(event(), { operation: "check" });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    manifest("3.0.0-beta.1"),
    manifest("03.0.0"),
    { name: "other", version: "3.0.0" },
    "invalid",
  ])("rejects invalid releases and backs off failures", async (value) => {
    mocks.fetch.mockImplementation(async () => response(value));
    expect((await call(event(), { operation: "check" })).latestVersion).toBeUndefined();
    await call(event(), { operation: "check" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15 * 60 * 1000);
    await call(event(), { operation: "check" });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("aborts pending checks when disabled and hides cached versions", async () => {
    let signal: AbortSignal | undefined;
    mocks.fetch.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const result = call(event(), { operation: "check" });
    runInAction(() => {
      mocks.store.checkUpdates = false;
    });
    expect(signal?.aborted).toBe(true);
    expect((await result).latestVersion).toBeUndefined();
    await call(event(), { operation: "check" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized metadata and caches the failure", async () => {
    mocks.fetch.mockImplementation(async () => new Response(" ".repeat(64 * 1024 + 1)));
    expect((await call(event(), { operation: "check" })).latestVersion).toBeUndefined();
    await call(event(), { operation: "check" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("times out stalled requests and backs off for fifteen minutes", async () => {
    mocks.fetch.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const result = call(event(), { operation: "check" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).latestVersion).toBeUndefined();
    await call(event(), { operation: "check" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("aborts pending checks on disposal", async () => {
    let signal: AbortSignal | undefined;
    mocks.fetch.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const result = call(event(), { operation: "check" });
    dispose?.();
    expect(signal?.aborted).toBe(true);
    await result;
    expect(mocks.removeHandler).toHaveBeenCalledWith(EXTENSION_UPDATES_CHANNEL);
  });
});

it("compares SemVer numeric components and prerelease precedence without precision loss", () => {
  expect(isNewerVersion("2.10.0", "2.9.9")).toBe(true);
  expect(isNewerVersion("2.0.0", "2.0.0-rc.1")).toBe(true);
  expect(isNewerVersion("2.0.0-rc.10", "2.0.0-rc.2")).toBe(true);
  expect(isNewerVersion("2.0.0+build", "2.0.0")).toBe(false);
  expect(isNewerVersion("999999999999999999999.0.1", "999999999999999999998.9.9")).toBe(true);
  expect(isNewerVersion("2.0.0-01", "1.0.0")).toBe(false);
});
