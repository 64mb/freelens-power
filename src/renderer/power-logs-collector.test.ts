import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectHistoricalLogs,
  type PowerLogsTransport,
  resolveLogSources,
  startLiveLogs,
} from "./power-logs-collector";

afterEach(() => vi.useRealTimers());
const target = { kind: "Deployment" as const, namespace: "demo", name: "app", uid: "deployment-1" };
describe("Power Logs discovery", () => {
  it("reports a full tail as partial even when downstream capture filtering drops its records", async () => {
    const source = { namespace: "demo", pod: "worker", podUid: "pod-1", container: "app" };
    const accepted: unknown[] = [];
    const result = await collectHistoricalLogs(
      [source],
      {
        get: vi.fn().mockResolvedValue({ metadata: { uid: source.podUid } }),
        stream: async function* () {
          yield "2026-01-01T00:00:00Z old\n2026-01-01T00:00:01Z old\n";
        },
      } as PowerLogsTransport,
      {
        tailLines: 2,
        onRecords: (records) => {
          accepted.push(...records.filter((record) => record.timestamp! > Date.parse("2026-01-02")));
        },
      },
    );
    expect(accepted).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.notes).toContain("Some source logs reached a collection limit");
  });
  it("requires owner UID chains rather than matching names", async () => {
    vi.useFakeTimers();
    const get = vi
      .fn()
      .mockResolvedValueOnce({ metadata: { uid: target.uid } })
      .mockResolvedValueOnce({
        items: [
          { metadata: { uid: "rs-owned", ownerReferences: [{ uid: target.uid, controller: true }] } },
          { metadata: { uid: "rs-foreign", ownerReferences: [{ uid: "old-deployment", controller: true }] } },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            metadata: { name: "owned", uid: "p1", ownerReferences: [{ uid: "rs-owned", controller: true }] },
            spec: { containers: [{ name: "app" }], initContainers: [{ name: "init" }] },
          },
          {
            metadata: { name: "foreign", uid: "p2", ownerReferences: [{ uid: "rs-foreign", controller: true }] },
            spec: { containers: [{ name: "app" }] },
          },
        ],
      });
    const result = resolveLogSources(target, { get, stream: vi.fn() } as PowerLogsTransport);
    await vi.runAllTimersAsync();
    expect((await result).sources.map((source) => `${source.pod}/${source.container}`)).toEqual([
      "owned/app",
      "owned/init",
    ]);
  });
  it("retries throttled discovery with bounded Retry-After", async () => {
    vi.useFakeTimers();
    const get = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, retryAfter: "9999" })
      .mockResolvedValue({ metadata: { uid: "pod-1", name: "worker" }, spec: { containers: [{ name: "app" }] } });
    const result = resolveLogSources({ kind: "Pod", namespace: "demo", name: "worker", uid: "pod-1" }, {
      get,
      stream: vi.fn(),
    } as PowerLogsTransport);
    await vi.runAllTimersAsync();
    expect((await result).sources).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("polls every source fairly and suppresses repeated tail records", async () => {
    vi.useFakeTimers();
    const visited = new Set<string>();
    const get = vi.fn(async (path: string) => ({ metadata: { uid: path.split("/").pop() } }));
    const stream = async function* (path: string) {
      visited.add(path);
      yield Buffer.from("2026-01-01T00:00:00.000000001Z info hello\n");
    };
    const onRecords = vi.fn();
    const live = startLiveLogs(
      Array.from({ length: 5 }, (_, i) => ({ namespace: "demo", pod: `p${i}`, podUid: `p${i}`, container: "app" })),
      { get, stream } as PowerLogsTransport,
      { onRecords },
    );
    await vi.advanceTimersByTimeAsync(30000);
    expect(visited.size).toBe(5);
    expect(onRecords.mock.calls.flatMap((call) => call[0])).toHaveLength(5);
    live.stop();
    await live.done;
  });
  it("reports bounded live coverage and cancels before requests", async () => {
    const controller = new AbortController();
    controller.abort();
    const get = vi.fn();
    const live = startLiveLogs(
      Array.from({ length: 8 }, (_, i) => ({ namespace: "demo", pod: `p${i}`, podUid: `${i}`, container: "app" })),
      { get, stream: vi.fn() } as PowerLogsTransport,
      { signal: controller.signal, onRecords: vi.fn() },
    );
    await live.done;
    expect(live.coverage).toMatchObject({ active: 0, total: 8, partial: true });
    expect(get).not.toHaveBeenCalled();
  });
});
