import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPowerLogsLimits } from "../common/power-logs-limits";
import {
  acquirePowerLogStream,
  cancelPowerLogPermits,
  releasePowerLogStream,
  renewPowerLogStream,
  requestPowerLogPermit,
  startPowerLogBudget,
} from "./power-logs-budget";

beforeEach(() => {
  vi.useFakeTimers();
  startPowerLogBudget();
});
afterEach(() => {
  applyPowerLogsLimits(undefined);
  cancelPowerLogPermits(true);
  vi.useRealTimers();
});
describe("shared main process log budget", () => {
  it("accepts configured batches above two MiB and rejects bytes above the configured batch limit", async () => {
    applyPowerLogsLimits({ batchBytes: 4 * 1024 * 1024 });
    await expect(requestPowerLogPermit("cluster-example", 3 * 1024 * 1024)).resolves.toBeUndefined();
    await expect(requestPowerLogPermit("cluster-example", 4 * 1024 * 1024 + 1)).rejects.toThrow("Invalid");
    applyPowerLogsLimits({ batchBytes: 1024, recordBytes: 1024 });
    await expect(requestPowerLogPermit("cluster-other", 1028)).rejects.toThrow("Invalid");
  });
  it("uses configured request and byte rates and stream concurrency", async () => {
    applyPowerLogsLimits({
      requestsPerSecond: 4,
      bytesPerSecond: 2 * 1024 * 1024,
      historyConcurrency: 1,
      liveConcurrency: 1,
    });
    await requestPowerLogPermit("cluster-example");
    let started = false;
    const start = requestPowerLogPermit("cluster-example").then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await start;
    await requestPowerLogPermit("cluster-example", 1024 * 1024);
    let transferred = false;
    const bytes = requestPowerLogPermit("cluster-example", 1024).then(() => {
      transferred = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(transferred).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await bytes;
    for (const follow of [false, true]) {
      await acquirePowerLogStream("cluster-example", `first-${follow}`, follow);
      let ready = false;
      const waiting = acquirePowerLogStream("cluster-example", `second-${follow}`, follow).then(() => {
        ready = true;
      });
      await Promise.resolve();
      expect(ready).toBe(false);
      releasePowerLogStream("cluster-example", `first-${follow}`);
      await waiting;
    }
  });
  it("shares two historical and four follow slots across callers", async () => {
    await acquirePowerLogStream("cluster-example", "history-one", false);
    await acquirePowerLogStream("cluster-example", "history-two", false);
    for (let i = 0; i < 4; i++) await acquirePowerLogStream("cluster-example", `follow-${i}`, true);
    let historical = false,
      follow = false;
    const historyWait = acquirePowerLogStream("cluster-example", "history-three", false).then(() => {
      historical = true;
    });
    const followWait = acquirePowerLogStream("cluster-example", "follow-next", true).then(() => {
      follow = true;
    });
    await Promise.resolve();
    expect(historical).toBe(false);
    expect(follow).toBe(false);
    releasePowerLogStream("cluster-example", "history-one");
    await historyWait;
    expect(historical).toBe(true);
    expect(follow).toBe(false);
    releasePowerLogStream("cluster-example", "follow-0");
    await followWait;
    expect(follow).toBe(true);
  });
  it("renews active leases, expires abandoned streams and releases slots on abort", async () => {
    const controller = new AbortController();
    await acquirePowerLogStream("cluster-example", "history-one", false, controller.signal);
    await vi.advanceTimersByTimeAsync(29000);
    renewPowerLogStream("cluster-example", "history-one");
    await vi.advanceTimersByTimeAsync(29000);
    expect(() => renewPowerLogStream("cluster-example", "history-one")).not.toThrow();
    controller.abort();
    expect(() => renewPowerLogStream("cluster-example", "history-one")).toThrow("expired");
    await acquirePowerLogStream("cluster-example", "history-two", false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(() => renewPowerLogStream("cluster-example", "history-two")).toThrow("expired");
  });
  it("cancels bounded pending stream slots on disable", async () => {
    await acquirePowerLogStream("cluster-example", "history-one", false);
    await acquirePowerLogStream("cluster-example", "history-two", false);
    const waiting = Array.from({ length: 16 }, (_, index) =>
      acquirePowerLogStream("cluster-example", `waiting-${index}`, false),
    );
    await expect(acquirePowerLogStream("cluster-example", "too-many", false)).rejects.toThrow("queue");
    await expect(requestPowerLogPermit("cluster-example")).rejects.toThrow("queue");
    const settled = Promise.allSettled(waiting);
    cancelPowerLogPermits();
    expect((await settled).every((value) => value.status === "rejected")).toBe(true);
    expect(() => renewPowerLogStream("cluster-example", "history-one")).toThrow("expired");
  });
  it("shares two starts per second across callers while separating clusters", async () => {
    await requestPowerLogPermit("cluster-example");
    let ready = false;
    const pending = requestPowerLogPermit("cluster-example").then(() => {
      ready = true;
    });
    await requestPowerLogPermit("cluster-other");
    await vi.advanceTimersByTimeAsync(499);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(ready).toBe(true);
  });
  it("shares one MiB per second and bounds queue and chunk size", async () => {
    await requestPowerLogPermit("cluster-example", 1024 * 1024);
    let ready = false;
    const pending = requestPowerLogPermit("cluster-example", 1024).then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    await expect(requestPowerLogPermit("cluster-example", 2 * 1024 * 1024 + 1)).rejects.toThrow("Invalid");
    const queued = Array.from({ length: 16 }, () => requestPowerLogPermit("cluster-example", 1024));
    await expect(requestPowerLogPermit("cluster-example", 1024)).rejects.toThrow("queue");
    const settled = Promise.allSettled(queued);
    cancelPowerLogPermits();
    expect((await settled).every((value) => value.status === "rejected")).toBe(true);
  });
  it("cancels pending permits on disable, stop or caller abort", async () => {
    await requestPowerLogPermit("cluster-example");
    const controller = new AbortController();
    const abort = expect(requestPowerLogPermit("cluster-example", undefined, controller.signal)).rejects.toThrow(
      "canceled",
    );
    controller.abort();
    await abort;
    const disable = expect(requestPowerLogPermit("cluster-example")).rejects.toThrow("canceled");
    cancelPowerLogPermits();
    await disable;
    await requestPowerLogPermit("cluster-example");
    cancelPowerLogPermits(true);
    await expect(requestPowerLogPermit("cluster-example")).rejects.toThrow("canceled");
  });
});
