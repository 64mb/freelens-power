import { afterEach, expect, it, vi } from "vitest";
import { waitForDashboardAiRead } from "./dashboard-ai";

afterEach(() => vi.useRealTimers());

it("bounds a stalled read and releases the timeout", async () => {
  vi.useFakeTimers();
  const pending = waitForDashboardAiRead(new Promise(() => {}));
  const rejected = expect(pending).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("promptly cancels a stalled read and removes its listener and timeout", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const pending = waitForDashboardAiRead(new Promise(() => {}), controller.signal);
  const rejected = expect(pending).rejects.toThrow("canceled");
  controller.abort(new Error("canceled"));
  await rejected;
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up after success and a signal already canceled", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  expect(await waitForDashboardAiRead(Promise.resolve("Healthy"), controller.signal)).toBe("Healthy");
  expect(remove).toHaveBeenCalledOnce();
  controller.abort(new Error("canceled"));
  await expect(waitForDashboardAiRead(new Promise(() => {}), controller.signal)).rejects.toThrow("canceled");
  expect(vi.getTimerCount()).toBe(0);
});
