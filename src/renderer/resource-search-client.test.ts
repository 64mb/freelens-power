import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ forCluster: vi.fn(), getResponse: vi.fn(), invoke: vi.fn() }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: {
      activeCluster: { get: () => ({ metadata: { uid: "cluster-a" }, spec: { kubeconfigContext: "test" } }) },
    },
    K8sApi: {
      KubeJsonApi: { forCluster: { call: (_this: unknown, clusterId: string) => state.forCluster(clusterId) } },
    },
  },
}));
vi.mock("electron", () => ({ ipcRenderer: { invoke: state.invoke } }));

import { createResourceSearchTransport, searchContextId } from "./resource-search-client";

beforeEach(() => vi.stubGlobal("window", { location: new URL("https://cluster-a.renderer.freelens.app:12345") }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("uses the host legacy factory proxy and bounds raw response parsing without logging bodies", async () => {
  state.forCluster.mockReturnValue({ getResponse: state.getResponse });
  state.getResponse.mockResolvedValue({ ok: true, text: async () => '{"items":[]}' });
  const transport = createResourceSearchTransport("cluster-a");
  await expect(transport.get("/api/v1/secrets", { limit: 250 }, { Accept: "metadata" })).resolves.toEqual({
    items: [],
  });
  expect(state.forCluster).toHaveBeenCalledWith("cluster-a");
  expect(state.getResponse).toHaveBeenCalledWith(
    "/api/v1/secrets",
    { query: { limit: 250 } },
    expect.objectContaining({ size: 4194304 }),
  );
  expect(searchContextId()).toMatch(/^[a-f0-9]{64}$/);
});
it("reports status and retry-after without reading or retaining denied response bodies", async () => {
  const destroy = vi.fn();
  const text = vi.fn();
  state.forCluster.mockReturnValue({ getResponse: state.getResponse });
  state.getResponse.mockResolvedValue({ ok: false, status: 429, headers: { get: () => "3" }, body: { destroy }, text });
  await expect(createResourceSearchTransport("cluster-a").get("/api")).rejects.toMatchObject({
    status: 429,
    retryAfter: "3",
  });
  expect(text).not.toHaveBeenCalled();
  expect(destroy).toHaveBeenCalledOnce();
});
it("exposes a safe oversized marker and requests a global permit before transferring a page", async () => {
  state.invoke.mockClear();
  state.forCluster.mockReturnValue({ getResponse: state.getResponse });
  state.getResponse.mockResolvedValue({
    ok: true,
    text: async () => {
      throw { type: "max-size", message: "sensitive-body" };
    },
  });
  await expect(createResourceSearchTransport("cluster-a").get("/api/v1/secrets")).rejects.toMatchObject({
    oversized: true,
    message: "Resource page exceeded the response budget",
  });
  expect(state.invoke).toHaveBeenCalledWith(
    "freelens-power:resource-search",
    expect.objectContaining({ operation: "permit", clusterId: "cluster-a" }),
  );
});

it("overrides the doubled cluster factory Host while preserving metadata headers, cancellation and bounds", async () => {
  const controller = new AbortController();
  let effectiveHeaders: Record<string, string> = {};
  state.forCluster.mockImplementation((clusterId) => ({
    getResponse: async (
      _path: string,
      _query: unknown,
      init: { headers: Record<string, string>; signal: AbortSignal; size: number },
    ) => {
      effectiveHeaders = { Host: `${clusterId}.cluster-a.renderer.freelens.app:12345`, ...init.headers };
      expect(init.signal.aborted).toBe(false);
      expect(init.size).toBe(4194304);
      return { ok: true, text: async () => '{"items":[]}' };
    },
  }));
  await createResourceSearchTransport("cluster-a", controller.signal).get(
    "/api/v1/secrets",
    { limit: 250 },
    { Accept: "metadata" },
  );
  expect(effectiveHeaders).toEqual({ Host: "cluster-a.renderer.freelens.app:12345", Accept: "metadata" });
});
it("rejects a transport for another cluster or an untrusted frame host", () => {
  expect(() => createResourceSearchTransport("cluster-b")).toThrow("active cluster frame");
  vi.stubGlobal("window", { location: new URL("https://cluster-a.example.test:12345") });
  expect(() => createResourceSearchTransport("cluster-a")).toThrow("active cluster frame");
});

it("aborts stalled network responses at the deadline and removes caller listeners", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const add = vi.spyOn(caller.signal, "addEventListener");
  const remove = vi.spyOn(caller.signal, "removeEventListener");
  let networkSignal!: AbortSignal;
  state.forCluster.mockReturnValue({
    getResponse: (_path: string, _query: unknown, init: { signal: AbortSignal }) => {
      networkSignal = init.signal;
      return new Promise(() => {});
    },
  });
  const result = createResourceSearchTransport("cluster-a", caller.signal, { timeoutMs: 25 }).get("/api");
  const assertion = expect(result).rejects.toMatchObject({ timedOut: true, message: "Resource request timed out" });
  await vi.advanceTimersByTimeAsync(25);
  await assertion;
  expect(networkSignal.aborted).toBe(true);
  expect(add).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds stalled body parsing and destroys the response stream", async () => {
  vi.useFakeTimers();
  const destroy = vi.fn();
  state.forCluster.mockReturnValue({
    getResponse: async () => ({ ok: true, body: { destroy }, text: () => new Promise(() => {}) }),
  });
  const result = createResourceSearchTransport("cluster-a", undefined, { timeoutMs: 25 }).get("/api");
  const assertion = expect(result).rejects.toMatchObject({ timedOut: true });
  await vi.advanceTimersByTimeAsync(25);
  await assertion;
  expect(destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves caller cancellation and ignores late network responses after abort", async () => {
  const caller = new AbortController();
  let resolve!: (value: unknown) => void;
  const text = vi.fn(async () => '{"items":[]}');
  const destroy = vi.fn();
  state.forCluster.mockReturnValue({
    getResponse: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const result = createResourceSearchTransport("cluster-a", caller.signal).get("/api");
  const assertion = expect(result).rejects.toThrow("Resource request canceled");
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  caller.abort();
  await assertion;
  resolve({ ok: true, text, body: { destroy } });
  await Promise.resolve();
  expect(text).not.toHaveBeenCalled();
  expect(destroy).toHaveBeenCalledOnce();
});
it("clears network deadlines and caller listeners after successful parsing", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const remove = vi.spyOn(caller.signal, "removeEventListener");
  state.forCluster.mockReturnValue({ getResponse: async () => ({ ok: true, text: async () => '{"items":[]}' }) });
  await expect(
    createResourceSearchTransport("cluster-a", caller.signal, { timeoutMs: 25 }).get("/api"),
  ).resolves.toEqual({ items: [] });
  expect(remove).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
