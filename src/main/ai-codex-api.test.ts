import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { aiFailureCode, runAiChat } from "./ai";
import { createCodexApiSession } from "./ai-codex-api";

const mocks = vi.hoisted(() => ({ key: vi.fn(), fetch: vi.fn(), spawn: vi.fn(), socket: vi.fn() }));
vi.mock("./ai-api-key", () => ({ readAiApiKey: mocks.key }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("ws", () => ({
  default: Object.assign(
    function (...args: unknown[]) {
      return mocks.socket(...args);
    },
    { OPEN: 1 },
  ),
}));

const parameters = { type: "object", additionalProperties: false, properties: {}, required: [] };
const read = (method = "pods") => ({
  method,
  resource: null,
  namespace: null,
  name: null,
  ref: null,
  apiVersion: null,
  kind: null,
});
const call = (id: string, method = "pods") => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: id,
  name: "read_context",
  arguments: JSON.stringify(read(method)),
});
const message = (text: string) => ({
  type: "message",
  id: "msg_a",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
const completed = (output: unknown[], id = "resp_a", tier = "default") => ({
  type: "response.completed",
  response: { id, status: "completed", service_tier: tier, output },
});
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const reply = (output: unknown[], tier = "default") =>
  new Response(event(completed(output, "resp_a", tier)), { headers: { "Content-Type": "text/event-stream" } });
const session = (effort = "", options: { webSocket?: boolean; serviceTier?: "default" | "fast" | "ultrafast" } = {}) =>
  createCodexApiSession("bounded evidence", parameters, "", effort, options);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.key.mockResolvedValue("sk-example-key-not-real-123456789");
  mocks.fetch.mockReset().mockResolvedValue(reply([message("Ready")]));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("uses streaming native read functions without an answer schema and keeps medium reasoning by default", async () => {
  expect(JSON.parse(await session().next(false))).toEqual({ tool: null, text: "Ready" });
  const [url, options] = mocks.fetch.mock.calls[0];
  expect(url).toBe("https://api.openai.com/v1/responses");
  expect(options.redirect).toBe("error");
  expect(options.headers.Authorization).toBe("Bearer sk-example-key-not-real-123456789");
  expect(JSON.parse(options.body)).toEqual({
    model: "gpt-6.1-sol",
    store: false,
    stream: true,
    service_tier: "default",
    input: [{ role: "user", content: "bounded evidence" }],
    include: ["reasoning.encrypted_content"],
    max_output_tokens: 12000,
    reasoning: { mode: "standard", effort: "medium" },
    text: { verbosity: "low" },
    parallel_tool_calls: true,
    tools: [{ type: "function", name: "read_context", description: expect.any(String), strict: true, parameters }],
  });
});

it("publishes plain text before completion and handles split UTF-8, CRLF, comments and multiline data", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  mocks.fetch.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          stream = controller;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    ),
  );
  const progress = vi.fn();
  let settled = false;
  const pending = session()
    .next(false, undefined, progress)
    .then((value) => {
      settled = true;
      return value;
    });
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
  const bytes = new TextEncoder().encode(
    ': comment\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"Привет"}\r\n\r\n',
  );
  for (const byte of bytes) stream.enqueue(new Uint8Array([byte]));
  await vi.waitFor(() => expect(progress).toHaveBeenCalledWith("Привет"));
  expect(settled).toBe(false);
  stream.enqueue(new TextEncoder().encode(event(completed([message("Привет")]))));
  expect(JSON.parse(await pending)).toEqual({ tool: null, text: "Привет" });
});

it("replays native output and encrypted reasoning with matching parallel call outputs, without duplicating the initial prompt", async () => {
  const reasoning = { type: "reasoning", id: "rs_a", summary: [], encrypted_content: "encrypted-state" };
  mocks.fetch
    .mockReset()
    .mockResolvedValueOnce(
      new Response(
        event({ type: "response.output_item.done", item: reasoning }) +
          event(completed([{ type: "reasoning", id: "rs_a", summary: [] }, call("first"), call("second", "nodes")])),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    )
    .mockResolvedValueOnce(reply([message("Two reads completed")]));
  const api = session();
  expect(JSON.parse(await api.next(false)).tool).toEqual([read(), read("nodes")]);
  api.addResults([{ items: ["pod"] }, { items: ["node"] }]);
  expect(JSON.parse(await api.next(false)).text).toBe("Two reads completed");
  const body = JSON.parse(mocks.fetch.mock.calls[1][1].body);
  expect(body.previous_response_id).toBeUndefined();
  expect(body.input).toEqual([
    { role: "user", content: "bounded evidence" },
    reasoning,
    call("first"),
    call("second", "nodes"),
    { type: "function_call_output", call_id: "first", output: '{"items":["pod"]}' },
    { type: "function_call_output", call_id: "second", output: '{"items":["node"]}' },
  ]);
  expect(JSON.stringify(body).match(/bounded evidence/g)).toHaveLength(1);
});

it.each([
  [401, "API_AUTHENTICATION"],
  [403, "API_AUTHENTICATION"],
  [429, "API_RATE_LIMIT"],
  [500, "API_FAILURE"],
])("reports safe failure code for HTTP %s", async (status, code) => {
  mocks.fetch.mockResolvedValue(new Response("private upstream headers or credentials", { status: status as number }));
  let failure: unknown;
  try {
    await session().next(false);
  } catch (error) {
    failure = error;
  }
  expect(aiFailureCode(failure)).toBe(code);
  expect(String(failure)).not.toContain("private");
});

it("rejects missing credentials before network access and sanitizes network failures", async () => {
  mocks.key.mockResolvedValueOnce("");
  await expect(session().next(false)).rejects.toThrow("AI API authentication failed");
  expect(mocks.fetch).not.toHaveBeenCalled();
  mocks.fetch.mockRejectedValue(new Error("private connection details and key"));
  await expect(session().next(false)).rejects.toThrow("AI API request failed");
});

it("aborts active streams and times out unfinished network requests", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  mocks.fetch.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          stream = controller;
        },
        cancel: cancelled,
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    ),
  );
  const controller = new AbortController();
  const pending = session().next(false, controller.signal);
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
  const rejected = expect(pending).rejects.toThrow("AI request cancelled");
  stream.enqueue(new TextEncoder().encode(event({ type: "response.output_text.delta", delta: "partial" })));
  controller.abort();
  await rejected;
  expect(cancelled).toHaveBeenCalled();
  mocks.fetch.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  vi.useFakeTimers();
  const timeout = session().next(false);
  const timedOut = expect(timeout).rejects.toThrow("AI request timed out");
  await vi.advanceTimersByTimeAsync(120001);
  await timedOut;
});

it.each([
  { type: "response.incomplete", response: { status: "incomplete" } },
  { type: "error", message: "private" },
  { type: "response.failed", response: { error: { message: "private" } } },
  completed([{ type: "shell_call" }]),
  completed([{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }]),
  completed([{ ...call("unknown"), name: "shell" }]),
  completed([{ ...call("invalid"), arguments: '{"method":"shell"}' }]),
  completed([call("duplicate"), call("duplicate")]),
  completed(Array.from({ length: 5 }, (_, index) => call(`call_${index}`))),
])("rejects failed/refusal/incomplete/unsafe function output without exposing upstream text", async (value) => {
  mocks.fetch.mockResolvedValue(new Response(event(value), { headers: { "Content-Type": "text/event-stream" } }));
  await expect(session().next(false)).rejects.toThrow(/AI (returned|API)/);
});

it("rejects truncated, oversized and malformed streams and prevents calls in the final budget phase", async () => {
  mocks.fetch.mockResolvedValueOnce(
    new Response(event({ type: "response.output_text.delta", delta: "unfinished" }), {
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
  await expect(session().next(false)).rejects.toThrow("incomplete response");
  mocks.fetch.mockResolvedValueOnce(
    new Response(`data: ${"a".repeat(1024 * 1024 + 1)}`, { headers: { "Content-Type": "text/event-stream" } }),
  );
  await expect(session().next(false)).rejects.toThrow("size limit");
  mocks.fetch.mockResolvedValueOnce(
    new Response("data: {invalid}\n\n", { headers: { "Content-Type": "text/event-stream" } }),
  );
  await expect(session().next(false)).rejects.toThrow("invalid response");
  mocks.fetch.mockResolvedValueOnce(reply([call("forbidden")]));
  await expect(session().next(true)).rejects.toThrow("invalid response");
  const last = JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body);
  expect(last.tools).toEqual([]);
  expect(last.tool_choice).toBe("none");
});

it("bounds arguments and text deltas and preserves a completed answer when the server reports a different tier", async () => {
  for (const value of [
    { type: "response.function_call_arguments.delta", output_index: 0, delta: "a".repeat(65537) },
    { type: "response.output_text.delta", delta: "a".repeat(512 * 1024 + 1) },
  ]) {
    mocks.fetch.mockResolvedValueOnce(new Response(event(value), { headers: { "Content-Type": "text/event-stream" } }));
    await expect(session().next(false)).rejects.toThrow("size limit");
  }
  mocks.fetch.mockResolvedValueOnce(reply([message("wrong tier")]));
  expect(JSON.parse(await session("", { serviceTier: "ultrafast" }).next(false)).text).toBe("wrong tier");
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(mocks.fetch.mock.calls[2][1].body).service_tier).toBe("ultrafast");
});

it("routes parallel native reads through the existing broker, preserving final text and read activity", async () => {
  mocks.fetch
    .mockReset()
    .mockResolvedValueOnce(reply([call("pods"), call("nodes", "nodes")]))
    .mockResolvedValueOnce(reply([message("Evidence inspected")]));
  const readCluster = vi.fn().mockResolvedValue({
    items: [{ metadata: { name: "example-resource", namespace: "default" }, status: { phase: "Running" } }],
  });
  const result = await runAiChat(
    {
      provider: "codex-api",
      apiWebSocket: false,
      model: "",
      speed: "default",
      messages: [{ role: "user", text: "Inspect evidence" }],
      context: { clusterId: "example-cluster" },
    },
    () => ({ read: readCluster }),
  );
  expect(result).toMatchObject({
    provider: "codex-api",
    text: "Evidence inspected",
    reads: [
      { method: "pods", status: "ok" },
      { method: "nodes", status: "ok" },
    ],
  });
  expect(readCluster).toHaveBeenCalledTimes(2);
  expect(mocks.spawn).not.toHaveBeenCalled();
  const second = JSON.parse(mocks.fetch.mock.calls[1][1].body);
  expect(
    second.input.filter((item: any) => item.type === "function_call_output").map((item: any) => item.call_id),
  ).toEqual(["pods", "nodes"]);
  expect(JSON.stringify(second)).toContain("example-resource");
  expect(JSON.stringify(second)).not.toContain("sk-example-key");
  expect(second.input[0].content).not.toContain("Return JSON");
  expect(second.input[0].content).not.toContain("tool null");
});

function mockSocket() {
  const socket = Object.assign(new EventEmitter(), { readyState: 0, send: vi.fn(), terminate: vi.fn() });
  mocks.socket.mockImplementation(() => {
    queueMicrotask(() => {
      socket.readyState = 1;
      socket.emit("open");
    });
    return socket;
  });
  return socket;
}

it("keeps one authenticated WebSocket for native read rounds with incremental call outputs and explicit service tier", async () => {
  const socket = mockSocket();
  socket.send.mockImplementation((body: string, callback) => {
    callback();
    const request = JSON.parse(body);
    queueMicrotask(() =>
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify(
            completed(
              request.previous_response_id ? [message("Ready")] : [call("read_a")],
              request.previous_response_id ? "resp_b" : "resp_a",
              "fast",
            ),
          ),
        ),
        false,
      ),
    );
  });
  const api = session("", { webSocket: true, serviceTier: "fast" });
  expect(JSON.parse(await api.next(false)).tool).toEqual([read()]);
  api.addResults([{ items: ["evidence"] }]);
  expect(JSON.parse(await api.next(false)).text).toBe("Ready");
  expect(mocks.socket).toHaveBeenCalledExactlyOnceWith(
    "wss://api.openai.com/v1/responses",
    expect.objectContaining({
      headers: { Authorization: "Bearer sk-example-key-not-real-123456789" },
      followRedirects: false,
    }),
  );
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.key).toHaveBeenCalledOnce();
  const first = JSON.parse(socket.send.mock.calls[0][0]);
  const next = JSON.parse(socket.send.mock.calls[1][0]);
  expect(first.type).toBe("response.create");
  expect(first.stream).toBeUndefined();
  expect(first.service_tier).toBe("fast");
  expect(first.reasoning).toEqual({ mode: "standard", effort: "medium" });
  expect(first.text).toEqual({ verbosity: "low" });
  expect(next.previous_response_id).toBe("resp_a");
  expect(next.input).toEqual([{ type: "function_call_output", call_id: "read_a", output: '{"items":["evidence"]}' }]);
  api.close();
  expect(socket.terminate).toHaveBeenCalledOnce();
});

it("falls back to HTTP only for a failed handshake before sending any generation", async () => {
  const socket = mockSocket();
  mocks.socket.mockImplementation(() => {
    queueMicrotask(() => socket.emit("error", new Error("handshake failed")));
    return socket;
  });
  mocks.fetch.mockResolvedValueOnce(reply([message("Ready")], "ultrafast"));
  const api = session("", { webSocket: true, serviceTier: "ultrafast" });
  expect(JSON.parse(await api.next(false)).text).toBe("Ready");
  expect(socket.send).not.toHaveBeenCalled();
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).service_tier).toBe("ultrafast");
  api.close();
});

it("does not retry a charged WebSocket generation over HTTP and closes on chat cancellation", async () => {
  const socket = mockSocket();
  socket.send.mockImplementation((_body, callback) => {
    callback();
    queueMicrotask(() => socket.emit("close"));
  });
  const api = session("", { webSocket: true });
  await expect(api.next(false)).rejects.toThrow("incomplete response");
  expect(mocks.fetch).not.toHaveBeenCalled();
  api.close();
  expect(socket.terminate).toHaveBeenCalledOnce();
  const active = mockSocket();
  active.send.mockImplementation((_body, callback) => callback());
  const controller = new AbortController();
  const chat = runAiChat(
    { provider: "codex-api", apiWebSocket: true, model: "", speed: "default", messages: [], context: {} },
    vi.fn(),
    controller.signal,
  );
  await vi.waitFor(() => expect(active.send).toHaveBeenCalledOnce());
  const cancelled = expect(chat).rejects.toThrow("AI request cancelled");
  controller.abort();
  await cancelled;
  expect(active.terminate).toHaveBeenCalledOnce();
});
