import { beforeEach, expect, it, vi } from "vitest";
import { startRendererServices } from "./renderer-services";

const state = vi.hoisted(() => ({ handle: vi.fn(), remove: vi.fn(), open: vi.fn() }));
vi.mock("./power-ipc", () => ({ powerIpc: { handle: state.handle, removeHandler: state.remove } }));
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
  shell: { openExternal: state.open },
}));

beforeEach(() => {
  vi.clearAllMocks();
  startRendererServices();
});

function invoke(channel: string, input: unknown, origin = "https://renderer.freelens.app/") {
  const frame = { url: origin, detached: false };
  const event = { senderFrame: frame, sender: { mainFrame: frame, getURL: () => origin } };
  const handler = state.handle.mock.calls.find(([name]) => name === channel)![1];
  return handler(event, input);
}

it("opens only HTTP(S) URLs from a trusted renderer", async () => {
  await invoke("freelens-power:open-external", "https://example.com/docs");
  expect(state.open).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
  for (const url of ["file:///tmp/example", "javascript:alert(1)"])
    await expect(invoke("freelens-power:open-external", url)).rejects.toThrow("Invalid external URL");
  await expect(
    invoke("freelens-power:open-external", "https://example.com/", "https://example.com/"),
  ).rejects.toThrow();
  await invoke("freelens-power:open-external", "https://name:password@example.com/");
  expect(state.open).toHaveBeenLastCalledWith("https://name:password@example.com/");
  expect(state.open).toHaveBeenCalledTimes(2);
});

it("validates certificate payload sizes before decoding data", () => {
  const channel = "freelens-power:secret-certificates";
  expect(invoke(channel, { "tls.crt": "aW52YWxpZA==" })).toEqual([]);
  expect(() => invoke(channel, { "tls.crt": 123 })).toThrow("Invalid certificate entry");
  expect(() => invoke(channel, { "tls.crt": "a".repeat(4 * 1024 * 1024 + 1) })).toThrow("safety limit");
  expect(() => invoke(channel, {}, "https://example.com/")).toThrow("Untrusted renderer");
});
