import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAiChat } from "./ai";

import type { AiChatRequest } from "../common/ai";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./ai-claude-policy", () => ({ verifyClaudeManagedPolicy: vi.fn().mockResolvedValue(undefined) }));

const request: AiChatRequest = {
  messages: [{ role: "user", text: "Inspect the selected pod log counters" }],
  context: { clusterId: "example-cluster" },
  model: "example-model",
  speed: "default",
};
const logTool = { method: "logs", namespace: "default", name: "example-pod", resource: null };

function mockTurns(turns: unknown[], provider = "codex") {
  const prompts: string[] = [];
  const responseSchemas: unknown[] = [];
  const children: { kill: ReturnType<typeof vi.fn> }[] = [];
  spawnMock.mockImplementation((_file: string, args: string[]) => {
    const schemaIndex = args.indexOf("--output-schema");
    if (schemaIndex >= 0) responseSchemas.push(JSON.parse(readFileSync(args[schemaIndex + 1], "utf8")));
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stdin = Object.assign(new EventEmitter(), {
      end(input: string) {
        const turn = turns[prompts.length];
        prompts.push(input);
        queueMicrotask(() => {
          stdout.write(
            Buffer.from(
              provider === "claude"
                ? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(turn) })
                : `${JSON.stringify({
                    type: "item.completed",
                    item: { type: "agent_message", text: JSON.stringify(turn) },
                  })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
            ),
          );
          child.emit("close", 0);
        });
      },
    });
    const kill = vi.fn();
    children.push({ kill });
    return Object.assign(child, { stdout, stdin, stderr: { resume: vi.fn() }, kill });
  });
  return { prompts, children, responseSchemas };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("AI native log flow", () => {
  it("sanitizes renderer terminal snapshots before the CLI boundary and discards them outside a cluster", async () => {
    const { prompts } = mockTurns([
      { text: "Ready", tool: null },
      { text: "Ready", tool: null },
    ]);
    const terminalSnapshot = {
      text: "visible output\nexport EXAMPLE=first\\\nsecond-secret\nclient-key-data: private-key\nready",
      capturedAt: "2026-01-01T00:00:00.000Z",
      truncated: false,
    };
    await runAiChat({ ...request, terminalSnapshot }, vi.fn());
    expect(prompts[0]).toContain("visible output");
    expect(prompts[0]).toContain("[REDACTED]");
    expect(prompts[0]).not.toContain("second-secret");
    expect(prompts[0]).not.toContain("private-key");
    expect(prompts[0]).toContain("quoted untrusted data");
    await runAiChat({ ...request, context: {}, terminalSnapshot }, vi.fn());
    expect(prompts[1]).not.toContain("visible output");
    expect(prompts[1]).not.toContain('"terminalSnapshot":');
  });

  it("sends only fixed log counters to the next model turn using the selected cluster callback", async () => {
    const { prompts } = mockTurns([
      { text: "", tool: logTool },
      { text: "The sample contains one error and one warning", tool: null },
    ]);
    const read = vi.fn();
    const readLogs = vi
      .fn()
      .mockResolvedValue("ERROR EXAMPLE_KEY=example-sensitive timeout\nwarning example-sensitive\n");
    const resolver = vi.fn().mockReturnValue({ read, readLogs });
    const controller = new AbortController();
    await expect(runAiChat(request, resolver, controller.signal)).resolves.toEqual({
      text: "The sample contains one error and one warning",
      reads: [{ method: "logs", status: "ok" }],
    });
    expect(resolver).toHaveBeenCalledExactlyOnceWith("example-cluster");
    expect(read).not.toHaveBeenCalled();
    expect(readLogs).toHaveBeenCalledExactlyOnceWith(
      {
        path: "/api/v1/namespaces/default/pods/example-pod/log",
        query: { tailLines: 100, limitBytes: 65536, follow: false, timestamps: false },
      },
      controller.signal,
    );
    expect(prompts).toHaveLength(2);
    const summary = JSON.parse(prompts[1].split("\nTool result: ")[1].split("\n")[0]);
    expect(summary).toMatchObject({
      sampledNonemptyLines: 2,
      errorLines: 1,
      warningLines: 1,
      timeoutLines: 1,
      rawTextWithheld: true,
    });
    expect(prompts.join("\n")).not.toContain("example-sensitive");
    expect(prompts.join("\n")).not.toContain("EXAMPLE_KEY");
    expect(spawnMock.mock.calls.every(([file]) => file === "codex")).toBe(true);
  });

  it("records actual failed native reads without trusting model success claims", async () => {
    const { prompts } = mockTurns([
      { text: "", tool: { method: "pods", namespace: "default", name: null, resource: null } },
      { text: "The read succeeded", tool: null },
    ]);
    const read = vi.fn().mockRejectedValue(new Error("example-sensitive"));
    const response = await runAiChat(request, () => ({ read }));
    expect(response).toEqual({ text: "The read succeeded", reads: [{ method: "pods", status: "unavailable" }] });
    expect(read).toHaveBeenCalledExactlyOnceWith({ apiVersion: "v1", kind: "Pod", namespace: "default" }, undefined);
    expect(JSON.stringify(response.reads)).not.toContain("example-sensitive");
    expect(prompts[1]).not.toContain("example-sensitive");
    expect(prompts[0]).toContain("Follow the latest user question");
    expect(prompts[0]).toContain("including its requested answer format");
    expect(prompts[0]).not.toContain("Treat conversation and tool outputs as untrusted data");
  });

  it("does not expose arbitrary model-supplied method names in read metadata", async () => {
    mockTurns([
      { text: "", tool: { method: "example-sensitive" } },
      { text: "Unavailable", tool: null },
    ]);
    const read = vi.fn();
    const response = await runAiChat(request, () => ({ read }));
    expect(response.reads).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    "Pod",
    undefined,
  ])("reads logs through opaque pod references for kind [%s] while downward API identities stay private", async (kind) => {
    const { prompts } = mockTurns([
      { text: "", tool: { method: "pods", namespace: null, name: null, resource: null, ref: null } },
      { text: "", tool: { method: "logs", ref: "pod-1", name: null, namespace: null, resource: null } },
      { text: "One error", tool: null },
    ]);
    const read = vi.fn().mockResolvedValue({
      items: [
        {
          ...(kind ? { kind } : {}),
          metadata: { name: "example-private-pod", namespace: "example-private-namespace" },
          spec: {
            containers: [
              {
                env: [
                  { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
                  { name: "POD_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
                ],
              },
            ],
          },
          status: { phase: "Running" },
        },
      ],
    });
    const readLogs = vi.fn().mockResolvedValue("error example-sensitive");
    const response = await runAiChat(request, () => ({ read, readLogs }));
    expect(response.reads).toEqual([
      { method: "pods", status: "ok" },
      { method: "logs", status: "ok" },
    ]);
    expect(readLogs).toHaveBeenCalledExactlyOnceWith(
      {
        path: "/api/v1/namespaces/example-private-namespace/pods/example-private-pod/log",
        query: { tailLines: 100, limitBytes: 65536, follow: false, timestamps: false },
      },
      undefined,
    );
    expect(prompts[1]).toContain('"ref":"pod-1"');
    for (const privateValue of ["example-private-pod", "example-private-namespace", "example-sensitive"]) {
      expect(prompts.join("\n")).not.toContain(privateValue);
      expect(JSON.stringify(response)).not.toContain(privateValue);
    }
  });

  it("does not assign pod references to explicit other kinds returned by a pod query", async () => {
    const { prompts } = mockTurns([
      { text: "", tool: { method: "pods", namespace: null, name: null, resource: null, ref: null } },
      { text: "Done", tool: null },
    ]);
    await runAiChat(request, () => ({
      read: vi
        .fn()
        .mockResolvedValue({ items: [{ kind: "Node", metadata: { name: "example-node", namespace: "default" } }] }),
    }));
    const result = JSON.parse(prompts[1].split("\nTool result: ")[1].split("\n")[0]);
    expect(result.items[0]).not.toHaveProperty("ref");
  });

  it("rejects unknown pod references without a native log read or name fallback", async () => {
    mockTurns([
      { text: "", tool: { method: "logs", ref: "pod-1", name: "example-pod", namespace: "default", resource: null } },
      { text: "Unavailable", tool: null },
    ]);
    const readLogs = vi.fn();
    const response = await runAiChat(request, () => ({ read: vi.fn(), readLogs }));
    expect(readLogs).not.toHaveBeenCalled();
    expect(response.reads).toEqual([{ method: "logs", status: "unavailable" }]);
  });

  it("reports fixed progress in read order and isolates observer errors", async () => {
    mockTurns([
      { text: "", tool: { method: "nodes", name: null, namespace: null, resource: null, ref: null } },
      { text: "", tool: { method: "logs", ref: "missing", name: null, namespace: null, resource: null } },
      { text: "Done", tool: null },
    ]);
    const events: unknown[] = [];
    const result = await runAiChat(
      request,
      () => ({ read: vi.fn().mockResolvedValue({ items: [] }) }),
      undefined,
      (event) => {
        events.push(event);
        throw new Error("example-sensitive observer failure");
      },
    );
    expect(result.text).toBe("Done");
    expect(events).toEqual([
      { method: "nodes", status: "reading" },
      { method: "nodes", status: "ok" },
      { method: "logs", status: "reading" },
      { method: "logs", status: "unavailable" },
    ]);
  });

  it("discovers a custom API then reads its structural spec through the selected native callback", async () => {
    const { prompts } = mockTurns([
      { text: "", tool: { method: "resources", resource: "discovery" } },
      { text: "", tool: { method: "resources", apiVersion: "example.com/v1", kind: "Example", namespace: "default" } },
      { text: "Done", tool: null },
    ]);
    const discover = vi.fn().mockResolvedValue([
      {
        apiVersion: "example.com/v1",
        kind: "Example",
        resource: "examples",
        namespaced: true,
        verbs: ["get", "list"],
      },
    ]);
    const read = vi.fn().mockResolvedValue({
      items: [
        {
          kind: "Example",
          metadata: { name: "example-object", namespace: "default" },
          spec: { replicas: 2, password: "example-sensitive" },
        },
      ],
    });
    const response = await runAiChat(request, () => ({ discover, read }));
    expect(discover).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledExactlyOnceWith(
      { apiVersion: "example.com/v1", kind: "Example", resource: "examples", namespace: "default" },
      undefined,
    );
    expect(response.reads).toEqual([
      { method: "resources", status: "ok" },
      { method: "resources", status: "ok" },
    ]);
    expect(prompts[1]).toContain('"apiVersion":"example.com/v1"');
    expect(prompts[2]).toContain('"replicas":2');
    expect(prompts.join("\n")).not.toContain("example-sensitive");
  });

  it("distinguishes unsupported resource kinds from unavailable native reads", async () => {
    const { prompts } = mockTurns([
      { text: "", tool: { method: "resources", resource: "unknowns.example.com" } },
      { text: "", tool: { method: "pods" } },
      { text: "Done", tool: null },
    ]);
    const read = vi.fn().mockRejectedValue(new Error("example-sensitive"));
    await runAiChat(request, () => ({ read }));
    expect(prompts[1]).toContain("UNSUPPORTED_RESOURCE:");
    expect(prompts[2]).toContain("READ_UNAVAILABLE:");
    expect(read).toHaveBeenCalledOnce();
    expect(prompts.join("\n")).not.toContain("example-sensitive");
  });

  it("stops awaiting a native read after cancellation without sending another model turn", async () => {
    const { prompts } = mockTurns([{ text: "", tool: logTool }]);
    const controller = new AbortController();
    const readLogs = vi.fn(() => {
      controller.abort();
      return new Promise(() => {});
    });
    await expect(runAiChat(request, () => ({ read: vi.fn(), readLogs }), controller.signal)).rejects.toBeDefined();
    expect(readLogs).toHaveBeenCalledOnce();
    expect(prompts).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("does not invoke tools or launch Codex for an already cancelled request", async () => {
    const resolver = vi.fn().mockReturnValue({ read: vi.fn(), readLogs: vi.fn() });
    const controller = new AbortController();
    controller.abort();
    await expect(runAiChat(request, resolver, controller.signal)).rejects.toBeDefined();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(resolver.mock.results[0].value.read).not.toHaveBeenCalled();
    expect(resolver.mock.results[0].value.readLogs).not.toHaveBeenCalled();
  });
});

describe("Claude native read flow", () => {
  it("uses only approved read callbacks and sends numeric log counters to Claude", async () => {
    for (const key of Object.keys(process.env)) vi.stubEnv(key, undefined);
    vi.stubEnv("ANTHROPIC_API_KEY", "example-native-key");
    vi.stubEnv("HOME", "/tmp/example-ai-test-home");
    const { prompts } = mockTurns(
      [
        { text: "", tool: logTool },
        { text: "One error", tool: null },
      ],
      "claude",
    );
    const readLogs = vi.fn().mockResolvedValue("ERROR EXAMPLE_KEY=example-sensitive\n");
    const read = vi.fn();
    await expect(
      runAiChat({ ...request, provider: "claude", model: "sonnet" }, () => ({ read, readLogs })),
    ).resolves.toEqual({ text: "One error", provider: "claude", reads: [{ method: "logs", status: "ok" }] });
    expect(spawnMock.mock.calls.every(([command]) => command === "claude")).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(readLogs).toHaveBeenCalledTimes(1);
    expect(prompts[1]).toContain('"errorLines":1');
    expect(prompts[1]).not.toContain("example-sensitive");
    const options = spawnMock.mock.calls[0][2];
    expect(options.shell).toBe(false);
    expect(options.env).toHaveProperty("ANTHROPIC_API_KEY", "example-native-key");
    expect(options.env).not.toHaveProperty("CODEX_HOME");
  });
});

it("returns related resources only from successful projected reads and suppresses environment identities", async () => {
  mockTurns([
    { text: "", tool: { method: "pods", namespace: "default" } },
    { text: "worker is running", tool: null },
  ]);
  const read = vi.fn().mockResolvedValue({
    items: [
      { kind: "Pod", metadata: { name: "worker", namespace: "default" } },
      {
        kind: "Pod",
        metadata: { name: "hidden-worker", namespace: "default" },
        spec: { containers: [{ env: [{ name: "VALUE", value: "hidden-worker" }] }] },
      },
    ],
  });
  const result = await runAiChat(request, () => ({ read }));
  expect(result.references).toEqual([{ apiVersion: "v1", kind: "Pod", name: "worker", namespace: "default" }]);
  expect(JSON.stringify(result.references)).not.toContain("hidden-worker");
});

it.each([
  { apiVersion: "example.com/v1", kind: "Widget", resource: "widgetrecords", namespaced: true, verbs: ["get", "list"] },
  { apiVersion: "v1", kind: "ServiceAccount", resource: "serviceaccounts", namespaced: true, verbs: ["get", "list"] },
])("preserves discovered $kind references through the complete sanitized read loop", async (definition) => {
  mockTurns([
    { text: "", tool: { method: "resources", resource: "discovery" } },
    {
      text: "",
      tool: { method: "resources", apiVersion: definition.apiVersion, kind: definition.kind, namespace: "default" },
    },
    { text: "Inspected worker", tool: null },
  ]);
  const read = vi.fn().mockResolvedValue({
    items: [
      {
        kind: definition.kind,
        apiVersion: definition.apiVersion,
        metadata: { name: "worker", namespace: "default" },
      },
    ],
  });
  const discover = vi.fn().mockResolvedValue([definition]);
  const result = await runAiChat(request, () => ({ read, discover }));
  expect(result.references).toEqual([
    { apiVersion: definition.apiVersion, kind: definition.kind, name: "worker", namespace: "default" },
  ]);
});

describe("bounded AI answer synthesis", () => {
  const tools = Array.from({ length: 6 }, (_, index) => ({
    text: "",
    tool: { method: "nodes", name: `worker-${index}` },
  }));
  it.each([
    "codex",
    "claude",
  ] as const)("allows [%s] to answer after six reads with no further read capability", async (provider) => {
    const { prompts, responseSchemas } = mockTurns([...tools, { text: "Six workers inspected", tool: null }], provider);
    const read = vi.fn().mockResolvedValue({ kind: "Node", status: { capacity: { cpu: "2" } } });
    const result = await runAiChat(
      { ...request, provider, model: provider === "claude" ? "sonnet" : request.model },
      () => ({ read }),
    );
    expect(result.text).toBe("Six workers inspected");
    expect(read).toHaveBeenCalledTimes(6);
    expect(result.reads).toHaveLength(6);
    expect(prompts).toHaveLength(7);
    expect(prompts[6]).toContain("bounded read budget is exhausted");
    expect(prompts[6]).toContain("never claim to have read unavailable or withheld data");
    if (provider === "codex") expect(responseSchemas[6]).toMatchObject({ properties: { tool: { type: "null" } } });
    else expect(spawnMock.mock.calls[6][1].join(" ")).toContain('"tool":{"type":"null"}');
  });

  it.each([
    "codex",
    "claude",
  ] as const)("rejects a seventh [%s] tool request without executing it", async (provider) => {
    mockTurns([...tools, { text: "unsupported claim", tool: { method: "nodes", name: "worker-extra" } }], provider);
    const read = vi.fn().mockResolvedValue({ items: [] });
    await expect(
      runAiChat({ ...request, provider, model: provider === "claude" ? "sonnet" : request.model }, () => ({ read })),
    ).rejects.toThrow("maximum number of resource reads");
    expect(read).toHaveBeenCalledTimes(6);
    expect(spawnMock).toHaveBeenCalledTimes(7);
  });

  it("reuses identical successful normalized queries without duplicate native reads or progress", async () => {
    const { prompts } = mockTurns([
      { text: "", tool: { method: "pods", namespace: "default" } },
      { text: "", tool: { method: "resources", resource: "pods", namespace: "default", name: null } },
      { text: "Done", tool: null },
    ]);
    const read = vi.fn().mockResolvedValue({ items: [] });
    const activity = vi.fn();
    const result = await runAiChat(request, () => ({ read }), undefined, activity);
    expect(read).toHaveBeenCalledOnce();
    expect(result.reads).toEqual([{ method: "pods", status: "ok" }]);
    expect(activity.mock.calls.map(([event]) => event)).toEqual([
      { method: "pods", status: "reading" },
      { method: "pods", status: "ok" },
    ]);
    expect(prompts[2]).toContain("without a new read");
  });

  it("reuses the same resource query across API discovery without duplicate native reads or progress", async () => {
    const { prompts } = mockTurns([
      { text: "", tool: { method: "pods", namespace: "default" } },
      { text: "", tool: { method: "resources", resource: "discovery" } },
      { text: "", tool: { method: "pods", namespace: "default" } },
      { text: "Done", tool: null },
    ]);
    const read = vi.fn().mockResolvedValue({ items: [] });
    const discover = vi
      .fn()
      .mockResolvedValue([
        { apiVersion: "v1", kind: "Pod", resource: "pods", namespaced: true, verbs: ["get", "list"] },
      ]);
    const activity = vi.fn();
    const response = await runAiChat(request, () => ({ read, discover }), undefined, activity);
    expect(read).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledOnce();
    expect(response.reads).toEqual([
      { method: "pods", status: "ok" },
      { method: "resources", status: "ok" },
    ]);
    expect(activity).toHaveBeenCalledTimes(4);
    expect(prompts[3]).toContain("without a new read");
  });

  it("retries failed reads and confines successful cached evidence to one request", async () => {
    mockTurns([
      { text: "", tool: logTool },
      { text: "", tool: logTool },
      { text: "Done", tool: null },
      { text: "", tool: logTool },
      { text: "Done", tool: null },
    ]);
    const readLogs = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue("error");
    const resolve = () => ({ read: vi.fn(), readLogs });
    const first = await runAiChat(request, resolve);
    expect(first.reads).toEqual([
      { method: "logs", status: "unavailable" },
      { method: "logs", status: "ok" },
    ]);
    await runAiChat(request, resolve);
    expect(readLogs).toHaveBeenCalledTimes(3);
  });

  it("propagates final provider failures rather than fabricating an answer", async () => {
    mockTurns([...tools, { invalid: true }]);
    const read = vi.fn().mockResolvedValue({ items: [] });
    await expect(runAiChat(request, () => ({ read }))).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(6);
    expect(spawnMock).toHaveBeenCalledTimes(7);
  });

  it("does not launch final synthesis after cancellation during the last read", async () => {
    mockTurns(tools);
    const controller = new AbortController();
    const read = vi.fn().mockImplementation(() => {
      if (read.mock.calls.length === 6) controller.abort();
      return Promise.resolve({ items: [] });
    });
    await expect(runAiChat(request, () => ({ read }), controller.signal)).rejects.toBeDefined();
    expect(spawnMock).toHaveBeenCalledTimes(6);
    expect(read).toHaveBeenCalledTimes(6);
  });
});
