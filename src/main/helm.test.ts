import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { decodeRelease, HelmLimiter, HelmService, latestReleases, metadataRelease } from "./helm";

const item = (revision = 1, status = "deployed") => ({
  metadata: {
    name: `sh.helm.release.v1.example.v${revision}`,
    namespace: "default",
    labels: { owner: "helm", name: "example", version: String(revision), status },
  },
});
const page = (items: unknown[], token = "") => ({
  apiVersion: "meta.k8s.io/v1",
  kind: "PartialObjectMetadataList",
  items,
  metadata: { continue: token },
});
const signal = () => new AbortController().signal;
describe("Helm metadata", () => {
  it("selects the newest revision even when a deployed revision exists", () => {
    expect(latestReleases([metadataRelease(item(1))!, metadataRelease(item(2, "failed"))!])[0].status).toBe("failed");
    expect(
      metadataRelease({ metadata: { ...item().metadata, labels: { ...item().metadata.labels, version: "9" } } }),
    ).toBeUndefined();
  });
  it("paginates and reuses bounded metadata until expiry", async () => {
    let now = 0;
    const read = vi
      .fn()
      .mockResolvedValueOnce(page([item()], "next"))
      .mockResolvedValue(page([item(2)]));
    const service = new HelmService(read, () => now);
    expect((await service.list("context", "", signal())).rows).toHaveLength(2);
    expect(read.mock.calls[0][1].limit).toBe(5000);
    expect(read.mock.calls[1][1].continue).toBe("next");
    expect((await service.list("context", "", signal())).cached).toBe(true);
    now = 30_000;
    expect((await service.list("context", "", signal())).cached).toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("does not cache a metadata response invalidated while it was in flight", async () => {
    let finish!: (value: unknown) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(page([item(2)]));
    const service = new HelmService(read);
    const old = service.list("context", "default", signal());
    service.clear();
    finish(page([item(1)]));
    await expect(old).rejects.toMatchObject({ code: "cancelled" });
    expect((await service.list("context", "default", signal())).rows[0].revision).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("reports incomplete listings after four continuation pages", async () => {
    const read = vi.fn().mockResolvedValue(page([item()], "continue"));
    await expect(new HelmService(read).list("context", "", signal())).rejects.toMatchObject({
      code: "limit",
      message: expect.stringContaining("4 page limit"),
    });
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.every((call) => call[1].limit === 5000)).toBe(true);
  });
  it("rejects full Secrets without falling back", async () => {
    const read = vi.fn().mockResolvedValue({ kind: "SecretList", items: [] });
    await expect(new HelmService(read).list("context", "", signal())).rejects.toMatchObject({
      code: "metadata-unavailable",
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("propagates API denial without fetching payloads", async () => {
    const read = vi.fn().mockRejectedValue(new Error("forbidden"));
    await expect(new HelmService(read).list("context", "", signal())).rejects.toThrow("forbidden");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
describe("Helm payload", () => {
  const encode = (value: unknown) =>
    Buffer.from(gzipSync(Buffer.from(JSON.stringify(value))).toString("base64")).toString("base64");
  it("caches bounded string summaries by context and revision with refresh, expiry and invalidation", async () => {
    let now = 0;
    const row = metadataRelease(item())!;
    const read = vi.fn(async () => ({
      ...item(),
      type: "helm.sh/release.v1",
      data: {
        release: encode({
          name: "example",
          namespace: "default",
          version: 1,
          chart: { metadata: { name: "example", version: "9.0.0", appVersion: "2.4.0" } },
        }),
      },
    }));
    const service = new HelmService(read, () => now);
    expect(await service.appVersion("one", row, signal())).toEqual({ appVersion: "2.4.0", chartVersion: "9.0.0" });
    await service.appVersion("one", row, signal());
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]).toBeDefined();
    await service.appVersion("two", row, signal());
    expect(read).toHaveBeenCalledTimes(2);
    await service.appVersion("one", row, signal(), true);
    expect(read).toHaveBeenCalledTimes(3);
    now = 300_000;
    await service.appVersion("one", row, signal());
    expect(read).toHaveBeenCalledTimes(4);
    service.clear();
    await service.appVersion("one", row, signal());
    expect(read).toHaveBeenCalledTimes(5);
  });
  it("does not repopulate detail or version caches from a read invalidated in flight", async () => {
    const row = metadataRelease(item())!;
    const secret = (appVersion: string, uid?: string) => ({
      ...item(),
      metadata: { ...item().metadata, uid },
      type: "helm.sh/release.v1",
      data: {
        release: encode({
          name: "example",
          namespace: "default",
          version: 1,
          chart: { metadata: { version: "1.0.0", appVersion } },
        }),
      },
    });
    let finish!: (value: unknown) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(secret("new"));
    const service = new HelmService(read);
    const pending = service.appVersion("context", row, signal());
    service.clear();
    finish(secret("old"));
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(await service.appVersion("context", row, signal())).toMatchObject({ appVersion: "new" });
    expect(read).toHaveBeenCalledTimes(2);
    read.mockResolvedValue(secret("replacement", "new-uid"));
    expect(await service.appVersion("context", { ...row, uid: "new-uid" }, signal())).toMatchObject({
      appVersion: "replacement",
    });
    expect(read).toHaveBeenCalledTimes(3);
    await expect(service.detail("context", { ...row, uid: "wrong-uid" }, "overview", signal())).rejects.toMatchObject({
      code: "invalid-data",
    });
  });
  it("decodes only the selected identity", () => {
    const row = metadataRelease(item())!;
    expect(decodeRelease(encode({ name: row.name, namespace: row.namespace, version: 1 }), row).version).toBe(1);
    expect(() => decodeRelease(encode({ name: "other", namespace: row.namespace, version: 1 }), row)).toThrow(
      "invalid",
    );
  });
  it("rejects deep and multiline-amplified trees before YAML serialization", () => {
    const row = metadataRelease(item())!;
    let config: unknown = "value";
    for (let depth = 0; depth < 70; depth++) config = { nested: config };
    expect(() => decodeRelease(encode({ name: row.name, namespace: row.namespace, version: 1, config }), row)).toThrow(
      "safety limits",
    );
    config = "value\n".repeat(100_000);
    for (let depth = 0; depth < 50; depth++) config = { nested: config };
    expect(() => decodeRelease(encode({ name: row.name, namespace: row.namespace, version: 1, config }), row)).toThrow(
      "safety limits",
    );
  });
  it("bounds decompression", () => {
    expect(() => decodeRelease(encode({ content: "x".repeat(9 * 1024 * 1024) }), metadataRelease(item())!)).toThrow(
      "safety limits",
    );
  });
});
it("cancels queued reads without starting them", async () => {
  const limiter = new HelmLimiter(1);
  let release!: () => void;
  const running = limiter.run(
    signal(),
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  const action = vi.fn();
  const waiting = limiter.run(controller.signal, action);
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
  release();
  await running;
  expect(action).not.toHaveBeenCalled();
});

it("transfers a reserved permit when the awakened waiter aborts before resuming", async () => {
  const limiter = new HelmLimiter(1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = limiter.run(signal(), () => gate);
  const controller = new AbortController();
  const skipped = vi.fn();
  const second = limiter.run(controller.signal, skipped);
  const started = vi.fn(async () => "started");
  const third = limiter.run(signal(), started);
  gate.then(() => controller.abort());
  release();
  await first;
  await expect(second).rejects.toMatchObject({ code: "cancelled" });
  await expect(third).resolves.toBe("started");
  expect(skipped).not.toHaveBeenCalled();
  expect(started).toHaveBeenCalledTimes(1);
});
