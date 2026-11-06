// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POWER_LOGS_CHANNEL } from "../common/power-logs";
import { createPowerLogsTransport } from "./power-logs-transport";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), getResponse: vi.fn(), context: "context-a" }));
vi.mock("./ipc", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
vi.mock("./resource-search-client", () => ({ searchContextId: () => mocks.context }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: {
    Catalog: { activeCluster: { get: () => ({ metadata: { uid: "cluster-a" } }) } },
    K8sApi: { KubeJsonApi: { forCluster: () => ({ getResponse: mocks.getResponse }) } },
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.context = "context-a";
  mocks.invoke.mockResolvedValue(true);
  vi.spyOn(window, "location", "get").mockReturnValue({
    protocol: "https:",
    hostname: "cluster-a.renderer.freelens.app",
    host: "cluster-a.renderer.freelens.app:1234",
  } as Location);
});
afterEach(() => vi.restoreAllMocks());
const path = "/api/v1/namespaces/demo/pods/sample/log";
function response(text: string) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  const reader = body.getReader();
  const cancel = vi.spyOn(reader, "cancel");
  vi.spyOn(body, "getReader").mockReturnValue(reader);
  mocks.getResponse.mockResolvedValue({ ok: true, body });
  return cancel;
}
it("uses a shared stream lease and byte budgets with exact context and frame host", async () => {
  const destroy = response("hello 🦆\n");
  const opened = vi.fn(),
    chunks: Uint8Array[] = [];
  for await (const chunk of createPowerLogsTransport("cluster-a").stream(path, { follow: true }, undefined, opened))
    chunks.push(chunk as Uint8Array);
  expect(Buffer.concat(chunks).toString()).toBe("hello 🦆\n");
  expect(opened).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
  const requests = mocks.invoke.mock.calls.map(([channel, request]) => {
    expect(channel).toBe(POWER_LOGS_CHANNEL);
    expect(request.clusterId).toBe("cluster-a");
    expect(request.contextId).toBe("context-a");
    return request;
  });
  expect(requests.map((request) => request.operation)).toEqual(["stream-open", "permit", "permit", "stream-close"]);
  expect(requests[0].follow).toBe(true);
  expect(requests[2].bytes).toBe(Buffer.byteLength("hello 🦆\n"));
  expect(requests[3].streamId).toBe(requests[0].streamId);
  expect(mocks.getResponse.mock.calls[0][2]).not.toHaveProperty("headers.Host");
});
it("stops immediately while a shared permit is queued without issuing HTTP", async () => {
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "permit" ? new Promise(() => {}) : Promise.resolve(true),
  );
  const controller = new AbortController();
  const read = createPowerLogsTransport("cluster-a").stream(path, {}, controller.signal)[Symbol.asyncIterator]().next();
  await vi.waitFor(() =>
    expect(mocks.invoke.mock.calls.some(([, request]) => request.operation === "permit")).toBe(true),
  );
  controller.abort();
  await expect(read).rejects.toThrow("canceled");
  expect(mocks.getResponse).not.toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.at(-1)?.[1].operation).toBe("stream-close");
});
it("destroys a response and releases its lease when canceled in a byte-budget wait", async () => {
  const destroy = response("sample\n");
  mocks.invoke.mockImplementation((_channel, request) =>
    request.operation === "permit" && request.lane === "bytes" ? new Promise(() => {}) : Promise.resolve(true),
  );
  const controller = new AbortController();
  const read = createPowerLogsTransport("cluster-a").stream(path, {}, controller.signal)[Symbol.asyncIterator]().next();
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([, request]) => request.lane === "bytes")).toBe(true));
  controller.abort();
  await expect(read).rejects.toThrow("canceled");
  expect(destroy).toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.at(-1)?.[1].operation).toBe("stream-close");
});
it("rejects a changed context after acquiring a permit", async () => {
  mocks.invoke.mockImplementation(async (_channel, request) => {
    if (request.operation === "permit") mocks.context = "context-b";
    return true;
  });
  const read = createPowerLogsTransport("cluster-a").stream(path, {})[Symbol.asyncIterator]().next();
  await expect(read).rejects.toThrow("context changed");
  expect(mocks.getResponse).not.toHaveBeenCalled();
});

it("decodes resource JSON when a multibyte character crosses stream chunks", async () => {
  const encoded = new TextEncoder().encode('{"message":"hello 🦆"}');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.subarray(0, encoded.length - 4));
      controller.enqueue(encoded.subarray(encoded.length - 4));
      controller.close();
    },
  });
  mocks.getResponse.mockResolvedValue({ ok: true, body });
  await expect(createPowerLogsTransport("cluster-a").get("/api/v1/pods")).resolves.toEqual({ message: "hello 🦆" });
});
