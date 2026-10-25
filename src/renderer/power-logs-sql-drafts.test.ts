import { afterEach, expect, it, vi } from "vitest";
import { CaptureSqlDrafts } from "./power-logs-sql-drafts";

import type { LogCapture } from "../common/power-logs";

afterEach(() => vi.useRealTimers());
const capture = (id: string, lastSql?: string) => ({ id, lastSql }) as LogCapture;
function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = () => no(new Error("unavailable"));
  });
  return { promise, resolve, reject };
}

it("debounces to the latest exact draft and restores local, server, and fallback values", async () => {
  vi.useFakeTimers();
  const save = vi.fn().mockResolvedValue(undefined);
  const drafts = new CaptureSqlDrafts(save);
  expect(drafts.read(capture("a"), "default")).toBe("default");
  expect(drafts.read(capture("a", "server"), "default")).toBe("server");
  drafts.set("a", "old");
  await vi.advanceTimersByTimeAsync(200);
  drafts.set("a", "SELECT '\n");
  expect(drafts.read(capture("a", "stale server"), "default")).toBe("SELECT '\n");
  await vi.advanceTimersByTimeAsync(249);
  expect(save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(save).toHaveBeenCalledExactlyOnceWith("a", "SELECT '\n");
  drafts.set("a", "");
  expect(drafts.read(capture("a", "server"), "default")).toBe("");
  await drafts.flush();
  expect(save).toHaveBeenLastCalledWith("a", "");
  expect(drafts.read(capture("blank", ""), "default")).toBe("");
});

it("serializes writes to each capture while saving different captures independently", async () => {
  vi.useFakeTimers();
  const first = deferred();
  const save = vi.fn((id: string, sql: string) => (id === "a" && sql === "old" ? first.promise : Promise.resolve()));
  const drafts = new CaptureSqlDrafts(save);
  drafts.set("a", "old");
  const initial = drafts.flush();
  await Promise.resolve();
  expect(save).toHaveBeenCalledExactlyOnceWith("a", "old");
  drafts.set("a", "latest");
  drafts.set("b", "other capture");
  let finished = false;
  const flushed = drafts.flush().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(save).toHaveBeenCalledWith("b", "other capture");
  expect(save).not.toHaveBeenCalledWith("a", "latest");
  expect(finished).toBe(false);
  first.resolve();
  await Promise.all([initial, flushed]);
  expect(save.mock.calls.filter(([id]) => id === "a")).toEqual([
    ["a", "old"],
    ["a", "latest"],
  ]);
  expect(finished).toBe(true);
});

it("flushes edits made while an earlier write is in flight before resolving", async () => {
  vi.useFakeTimers();
  const first = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const drafts = new CaptureSqlDrafts(save);
  drafts.set("a", "old");
  const flushed = drafts.flush();
  await Promise.resolve();
  drafts.set("a", "latest");
  first.resolve();
  await flushed;
  expect(save.mock.calls).toEqual([
    ["a", "old"],
    ["a", "latest"],
  ]);
  await vi.runAllTimersAsync();
  expect(save).toHaveBeenCalledTimes(2);
});

it("keeps failed drafts locally, reports only current failures, and retries on a later edit", async () => {
  vi.useFakeTimers();
  const save = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined);
  const onError = vi.fn();
  const drafts = new CaptureSqlDrafts(save, onError);
  drafts.set("a", "invalid draft '");
  await drafts.flush();
  expect(onError).toHaveBeenCalledExactlyOnceWith("a");
  expect(drafts.read(capture("a"), "default")).toBe("invalid draft '");
  await vi.runAllTimersAsync();
  await drafts.flush();
  expect(save).toHaveBeenCalledTimes(1);
  drafts.set("a", "corrected");
  await drafts.flush();
  expect(save).toHaveBeenLastCalledWith("a", "corrected");
  expect(onError).toHaveBeenCalledTimes(1);
});

it("forgets pending drafts and ignores failures from a deleted capture lifetime", async () => {
  vi.useFakeTimers();
  const first = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const onError = vi.fn();
  const drafts = new CaptureSqlDrafts(save, onError);
  drafts.set("pending", "discard");
  drafts.forget("pending");
  drafts.set("a", "in flight");
  const initial = drafts.flush();
  await Promise.resolve();
  drafts.set("a", "queued but deleted");
  const queued = drafts.flush();
  drafts.forget("a");
  drafts.set("a", "new lifetime");
  const latest = drafts.flush();
  first.reject();
  await Promise.all([initial, queued, latest]);
  expect(save.mock.calls).toEqual([
    ["a", "in flight"],
    ["a", "new lifetime"],
  ]);
  expect(onError).not.toHaveBeenCalled();
  expect(drafts.read(capture("pending", "server"), "default")).toBe("server");
});

it("flushes on disposal and suppresses every later error callback", async () => {
  vi.useFakeTimers();
  const first = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise).mockRejectedValue(new Error("unavailable"));
  const onError = vi.fn();
  const drafts = new CaptureSqlDrafts(save, onError);
  drafts.set("a", "old");
  const initial = drafts.flush();
  await Promise.resolve();
  drafts.set("a", "latest");
  const disposed = drafts.dispose();
  drafts.set("ignored", "after dispose");
  first.reject();
  await Promise.all([initial, disposed]);
  await vi.runAllTimersAsync();
  expect(save.mock.calls).toEqual([
    ["a", "old"],
    ["a", "latest"],
  ]);
  expect(onError).not.toHaveBeenCalled();
});

it("suppresses an obsolete save failure when a newer draft is already waiting", async () => {
  vi.useFakeTimers();
  const first = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const onError = vi.fn();
  const drafts = new CaptureSqlDrafts(save, onError);
  drafts.set("a", "old");
  const initial = drafts.flush();
  await Promise.resolve();
  drafts.set("a", "new");
  first.reject();
  await initial;
  expect(save).toHaveBeenLastCalledWith("a", "new");
  expect(onError).not.toHaveBeenCalled();
});
