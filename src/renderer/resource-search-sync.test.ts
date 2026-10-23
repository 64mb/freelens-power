import { expect, it, vi } from "vitest";
import { discoverSearchCollections, projectMetadataPage, type SearchTransport } from "./resource-search-discovery";
import { createSearchSynchronizer } from "./resource-search-sync";

const type = {
  group: "example.test",
  version: "v1",
  resource: "widgets",
  kind: "Widget",
  namespaced: true,
  aliases: [],
};
it("discovers every named list collection, deduplicating served versions and excluding subresources", async () => {
  const transport: SearchTransport = {
    get: vi.fn(async (path) =>
      path === "/api"
        ? { versions: ["v1"] }
        : path === "/api/v1"
          ? {
              resources: [
                { name: "secrets", kind: "Secret", verbs: ["list"] },
                { name: "configmaps", kind: "ConfigMap", verbs: ["list"] },
                { name: "pods/log", kind: "Pod", verbs: ["get"] },
              ],
            }
          : {
              items: [
                {
                  metadata: { name: "example.test" },
                  versions: [
                    {
                      version: "v2",
                      resources: [
                        { resource: "widgets", responseKind: { kind: "Widget" }, verbs: ["list"], scope: "Namespaced" },
                      ],
                    },
                    {
                      version: "v1",
                      resources: [{ resource: "widgets", responseKind: { kind: "Widget" }, verbs: ["list"] }],
                    },
                  ],
                },
              ],
            },
    ) as SearchTransport["get"],
  };
  const result = await discoverSearchCollections(transport);
  expect(result.map((item) => item.kind)).toEqual(["Secret", "ConfigMap", "Widget"]);
  expect(result[2]).toMatchObject({ version: "v2", namespaced: true });
});
it("projects only metadata identity and labels from sensitive full responses", () => {
  const page = {
    items: [
      {
        metadata: {
          name: "sample",
          namespace: "default",
          annotations: { token: "sensitive-annotation" },
          labels: { app: "demo" },
        },
        data: { token: "sensitive-data" },
        spec: { token: "sensitive-spec" },
      },
    ],
  };
  const result = projectMetadataPage(type, page);
  expect(result[0].path).toBe("/apis/example.test/v1/namespaces/default/widgets/sample");
  expect(JSON.stringify(result)).not.toContain("sensitive");
});
function setup(
  list: (path: string, query?: Record<string, string | number>, headers?: Record<string, string>) => Promise<unknown>,
) {
  const controller = new AbortController();
  const sink = {
    begin: vi.fn(async () => {}),
    append: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    invalidate: vi.fn(async () => {}),
  };
  const transport: SearchTransport = {
    get: vi.fn(async (path, query, headers) => {
      if (path === "/api") return { versions: [] };
      if (path === "/apis")
        return {
          items: [
            {
              metadata: { name: "example.test" },
              versions: [
                {
                  version: "v1",
                  resources: [
                    { resource: "widgets", responseKind: { kind: "Widget" }, verbs: ["list"], scope: "Namespaced" },
                  ],
                },
              ],
            },
          ],
        };
      return list(path, query, headers);
    }) as SearchTransport["get"],
  };
  const onStatus = vi.fn((status) => {
    if (!status.indexing && !status.storageFull) controller.abort();
  });
  return {
    controller,
    sink,
    transport,
    onStatus,
    run: () =>
      createSearchSynchronizer({
        transport,
        sink,
        signal: controller.signal,
        delay: async () => {},
        onStatus,
        namespaces: () => ["default"],
      }).run(),
  };
}
it("consumes all pages before completing and never truncates beyond 500 objects", async () => {
  const task = setup(async (_path, query) => ({
    metadata: { continue: query?.continue ? "" : "next" },
    items: Array.from({ length: query?.continue ? 300 : 250 }, (_, index) => ({
      metadata: { name: `item-${query?.continue ? 250 + index : index}` },
    })),
  }));
  await task.run();
  expect(task.sink.append.mock.calls.flatMap((call) => (call as unknown[])[2])).toHaveLength(550);
  expect(task.sink.complete).toHaveBeenCalledOnce();
});
it("does not complete an interrupted list and restarts expired continuation", async () => {
  let calls = 0;
  const task = setup(async () => {
    calls++;
    if (calls === 2) throw { status: 410 };
    return { metadata: { continue: calls === 1 ? "expired" : "" }, items: [] };
  });
  await task.run();
  expect(task.sink.begin).toHaveBeenCalledTimes(2);
  expect(task.sink.complete).toHaveBeenCalledOnce();
});
it("uses bounded full JSON compatibility for aggregated metadata 406 and strips payloads", async () => {
  const task = setup(async (_path, _query, headers) => {
    if (headers?.Accept.includes("PartialObjectMetadata")) throw { status: 406 };
    return {
      items: [{ metadata: { name: "sample", annotations: { private: "sensitive" } }, spec: { private: "sensitive" } }],
    };
  });
  await task.run();
  expect(task.sink.append).toHaveBeenCalledOnce();
  expect(JSON.stringify(task.sink.append.mock.calls)).not.toContain("sensitive");
});
it("purges forbidden all-namespace scope and tries permitted known namespaces", async () => {
  const task = setup(async (path) => {
    if (path === "/api/v1/namespaces" || !path.includes("/namespaces/default/")) throw { status: 403 };
    return { items: [{ metadata: { name: "visible", namespace: "default" } }] };
  });
  await task.run();
  expect(task.sink.invalidate).toHaveBeenCalledWith("example.test/widgets/*");
  expect(task.sink.complete).toHaveBeenCalledWith("example.test/widgets/default", expect.any(String));
});
it("never commits completion after cancellation", async () => {
  const task = setup(async () => {
    task.controller.abort();
    return { items: [{ metadata: { name: "late" } }] };
  });
  await task.run();
  expect(task.sink.append).not.toHaveBeenCalled();
  expect(task.sink.complete).not.toHaveBeenCalled();
});
it("reconciles disappeared collections only after authoritative complete discovery", async () => {
  const controller = new AbortController();
  const reconcile = vi.fn(async () => {});
  const task = createSearchSynchronizer({
    transport: { get: vi.fn(async () => ({ items: [] })) as SearchTransport["get"] },
    signal: controller.signal,
    sink: { begin: vi.fn(), append: vi.fn(), complete: vi.fn(), invalidate: vi.fn(), reconcile },
    delay: async () => {},
    onStatus: (status) => {
      if (!status.indexing) controller.abort();
    },
  });
  await task.run();
  expect(reconcile).toHaveBeenCalledWith([]);
});
it("retains collection caches when discovery is denied or unavailable", async () => {
  const controller = new AbortController();
  const reconcile = vi.fn(async () => {});
  const task = createSearchSynchronizer({
    transport: {
      get: vi.fn(async () => {
        throw { status: 403 };
      }) as SearchTransport["get"],
    },
    signal: controller.signal,
    sink: { begin: vi.fn(), append: vi.fn(), complete: vi.fn(), invalidate: vi.fn(), reconcile },
    delay: async () => {},
    onStatus: (status) => {
      if (!status.indexing) controller.abort();
    },
  });
  await task.run();
  expect(reconcile).not.toHaveBeenCalled();
});
it("halves oversized metadata pages and retries the same continuation until they fit", async () => {
  const limits: number[] = [];
  const task = setup(async (_path, query) => {
    limits.push(Number(query?.limit));
    if (Number(query?.limit) > 62) throw { oversized: true };
    return { metadata: { continue: "" }, items: [{ metadata: { name: "fits" } }] };
  });
  await task.run();
  expect(limits).toEqual([250, 125, 62]);
  expect(task.sink.complete).toHaveBeenCalledOnce();
});

it("pauses synchronization on the allowlisted storage quota failure without discarding cached rows or rescanning", async () => {
  const task = setup(async () => ({ metadata: { continue: "next" }, items: [{ metadata: { name: "sample" } }] }));
  task.sink.append.mockRejectedValueOnce(
    new Error("Error invoking remote method: Search storage is full; clear the local search cache to continue"),
  );
  await task.run();
  expect(task.controller.signal.aborted).toBe(false);
  expect(task.sink.append).toHaveBeenCalledOnce();
  expect(task.sink.complete).not.toHaveBeenCalled();
  expect(task.sink.invalidate).not.toHaveBeenCalled();
  expect(task.onStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({
      indexing: false,
      storageFull: true,
      message: "Search storage is full; clear the local search cache to continue",
    }),
  );
});
it("treats a stale aggregated discovery response as incomplete even when it returns HTTP success", async () => {
  const unavailable = vi.fn();
  await discoverSearchCollections(
    {
      get: vi.fn(async (path) =>
        path === "/api"
          ? { items: [] }
          : {
              items: [
                {
                  metadata: { name: "example.test" },
                  versions: [{ version: "v1", freshness: "Stale", resources: [] }],
                },
              ],
            },
      ) as SearchTransport["get"],
    },
    unavailable,
  );
  expect(unavailable).toHaveBeenCalledWith("example.test/v1");
});
it("marks a timed-out API unavailable and continues indexing the next discovered type", async () => {
  const controller = new AbortController();
  const sink = { begin: vi.fn(), append: vi.fn(), complete: vi.fn(), invalidate: vi.fn() };
  const onStatus = vi.fn((status) => {
    if (!status.indexing) controller.abort();
  });
  const get = vi.fn(async (path: string) => {
    if (path === "/api") return { items: [] };
    if (path === "/apis")
      return {
        items: [
          {
            metadata: { name: "example.test" },
            versions: [
              {
                version: "v1",
                resources: [
                  { resource: "widgets", responseKind: { kind: "Widget" }, verbs: ["list"] },
                  { resource: "gadgets", responseKind: { kind: "Gadget" }, verbs: ["list"] },
                ],
              },
            ],
          },
        ],
      };
    if (path.endsWith("/widgets")) throw Object.assign(new Error("Resource request timed out"), { timedOut: true });
    return { items: [{ metadata: { name: "available" } }] };
  });
  await createSearchSynchronizer({
    transport: { get: get as SearchTransport["get"] },
    sink,
    signal: controller.signal,
    delay: async () => {},
    onStatus,
  }).run();
  expect(sink.complete).toHaveBeenCalledWith("example.test/gadgets/*", expect.any(String));
  expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ unavailable: 1, scanned: 2, indexing: false }));
});
