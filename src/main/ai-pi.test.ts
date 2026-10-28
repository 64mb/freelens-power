import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePiAiOutput } from "./ai";
import { createAiAnswerStream } from "./ai-answer-stream";
import {
  PiAiResponseError,
  piAiArguments,
  piAiEnvironment,
  piAiOutputDiagnostics,
  preparePiAiEnvironment,
  writePiResponseExtension,
} from "./ai-pi";

const events = (text: string, stopReason = "stop") =>
  [
    { type: "message_end", message: { role: "assistant", stopReason, content: [{ type: "text", text }] } },
    { type: "agent_settled", aborted: false },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

describe("Pi read-only CLI", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("passes qualified model identifiers and disables executable resources", () => {
    const args = piAiArguments("example/deepseek-v4-flash", "max", { type: "object" });
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "example/deepseek-v4-flash",
    ]);
    for (const flag of [
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-mcp",
      "--offline",
      "--no-approve",
      "--no-context-files",
      "--no-session",
    ])
      expect(args).toContain(flag);
    expect(args).toContain("max");
    expect(args).toContain("--system-prompt");
    for (const model of ["--help", "example/model:high", "example/model*", "example/model\nother"])
      expect(() => piAiArguments(model)).toThrow("Invalid Pi model");
    expect(() => piAiArguments("example/glm-5-3", "ultra")).toThrow("Invalid Pi reasoning effort");
  });

  it("isolates config and resolves credential variables without inheriting runtime variables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-isolation-test-"));
    try {
      await writeFile(
        join(directory, "models.json"),
        JSON.stringify({ providers: { example: { apiKey: "$EXAMPLE_TOKEN", models: [] } } }),
      );
      await writeFile(join(directory, "settings.json"), JSON.stringify({ extensions: ["untrusted"] }));
      const env = await preparePiAiEnvironment(directory, {
        PI_CODING_AGENT_DIR: directory,
        EXAMPLE_TOKEN: "example-value",
        NODE_OPTIONS: "untrusted",
        UNRELATED_SECRET: "private",
      });
      expect(env).not.toHaveProperty("NODE_OPTIONS");
      expect(env).not.toHaveProperty("EXAMPLE_TOKEN");
      expect(env).not.toHaveProperty("UNRELATED_SECRET");
      expect(JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8"))).toMatchObject({
        providers: { example: { apiKey: "example-value" } },
      });
      await expect(readFile(join(env.PI_CODING_AGENT_DIR!, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(
        join(directory, "auth.json"),
        JSON.stringify({ example: { type: "api_key", key: "!execute-example" } }),
      );
      await expect(preparePiAiEnvironment(directory, { PI_CODING_AGENT_DIR: directory })).rejects.toThrow(
        "command credentials",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves credential escapes and leaves model metadata and OAuth tokens unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-template-test-"));
    try {
      await writeFile(
        join(directory, "models.json"),
        JSON.stringify({
          providers: {
            example: {
              apiKey: "$EXAMPLE_TOKEN",
              headers: { "X-Test": "prefix-$$LITERAL-$!-${EXAMPLE_HEADER}" },
              models: [{ id: "model", name: "$NAME", baseUrl: "https://example.invalid/$PATH" }],
            },
          },
        }),
      );
      await writeFile(
        join(directory, "auth.json"),
        JSON.stringify({
          example: {
            type: "oauth",
            access: "$OAUTH_LITERAL",
            refresh: "!literal-refresh",
            expires: 1,
          },
        }),
      );
      const env = await preparePiAiEnvironment(directory, {
        PI_CODING_AGENT_DIR: directory,
        EXAMPLE_TOKEN: "!token$part",
        EXAMPLE_HEADER: "header$value",
      });
      const models = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8"));
      expect(models.providers.example.apiKey).toBe("$!token$$part");
      expect(models.providers.example.headers["X-Test"]).toBe("prefix-$$LITERAL-!-header$$value");
      expect(models.providers.example.models[0]).toMatchObject({
        name: "$NAME",
        baseUrl: "https://example.invalid/$PATH",
      });
      const auth = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8"));
      expect(auth.example).toMatchObject({ access: "$OAUTH_LITERAL", refresh: "!literal-refresh" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("isolates ambient SDK auth and excludes executable auth environment paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-sdk-isolation-test-"));
    try {
      await writeFile(
        join(directory, "auth.json"),
        JSON.stringify({
          "amazon-bedrock": {
            type: "api_key",
            env: {
              AWS_PROFILE: "hostile",
              AWS_CONFIG_FILE: "/tmp/hostile-config",
              AWS_SHARED_CREDENTIALS_FILE: "/tmp/hostile-credentials",
            },
          },
          "google-vertex": {
            type: "api_key",
            env: {
              GOOGLE_APPLICATION_CREDENTIALS: "/tmp/hostile-google",
              GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: "1",
              CLOUDSDK_CONFIG: "/tmp/hostile-cloudsdk",
            },
          },
          example: {
            type: "api_key",
            key: "$CUSTOM_TOKEN",
            env: { CUSTOM_TOKEN: "local-token", ZAI_API_KEY: "safe-key", NODE_OPTIONS: "hostile" },
          },
        }),
      );
      const env = await preparePiAiEnvironment(directory, {
        PI_CODING_AGENT_DIR: directory,
        HOME: "/tmp/example-original-home",
        AWS_PROFILE: "hostile",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/hostile-google",
      });
      expect(env.HOME).toBe(join(directory, "pi-agent", "home"));
      expect(env.AWS_CONFIG_FILE).toBe(join(directory, "pi-agent", "disabled-aws-config"));
      expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe(join(directory, "pi-agent", "disabled-aws-credentials"));
      expect(env.AWS_EC2_METADATA_DISABLED).toBe("true");
      expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe(join(directory, "pi-agent", "disabled-google-credentials.json"));
      expect(env.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES).toBe("0");
      expect(env).not.toHaveProperty("AWS_PROFILE");
      const auth = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8"));
      expect(auth["amazon-bedrock"].env).toEqual({});
      expect(auth["google-vertex"].env).toEqual({});
      expect(auth.example).toMatchObject({ key: "local-token", env: { ZAI_API_KEY: "safe-key" } });
      expect(auth.example.env).not.toHaveProperty("NODE_OPTIONS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps available providers when an unrelated optional credential variable is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-optional-provider-test-"));
    try {
      await writeFile(
        join(directory, "models.json"),
        JSON.stringify({
          providers: {
            available: { apiKey: "literal-token", models: [{ id: "example-model" }] },
            unavailable: { apiKey: "$UNSET_OPTIONAL_TOKEN", models: [{ id: "other-model" }] },
          },
        }),
      );
      await writeFile(
        join(directory, "auth.json"),
        JSON.stringify({
          available: { type: "api_key", key: "literal-token" },
          unavailable: { type: "api_key", key: "$UNSET_OPTIONAL_TOKEN" },
        }),
      );
      const env = await preparePiAiEnvironment(directory, { PI_CODING_AGENT_DIR: directory });
      const models = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8"));
      const auth = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8"));
      expect(models.providers.available.apiKey).toBe("literal-token");
      expect(models.providers.unavailable).not.toHaveProperty("apiKey");
      expect(auth.available.key).toBe("literal-token");
      expect(auth).not.toHaveProperty("unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves model definitions when stored auth overrides a missing optional model API key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-auth-fallback-test-"));
    try {
      await writeFile(
        join(directory, "models.json"),
        JSON.stringify({
          providers: {
            example: {
              baseUrl: "https://example.invalid",
              apiKey: "$UNSET_OPTIONAL_TOKEN",
              models: [{ id: "example-model" }],
            },
          },
        }),
      );
      await writeFile(
        join(directory, "auth.json"),
        JSON.stringify({ example: { type: "api_key", key: "stored-token" } }),
      );
      const env = await preparePiAiEnvironment(directory, { PI_CODING_AGENT_DIR: directory });
      const models = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8"));
      const auth = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8"));
      expect(models.providers.example).toEqual({
        baseUrl: "https://example.invalid",
        models: [{ id: "example-model" }],
      });
      expect(auth.example.key).toBe("stored-token");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes absent text only for validated Pi read requests", () => {
    for (const text of [undefined, null]) {
      expect(
        parsePiAiOutput(
          events(JSON.stringify({ tool: { method: "nodes", name: "example-node", namespace: null }, text })),
        ),
      ).toEqual({ tool: { method: "nodes", name: "example-node", namespace: null }, text: "" });
      expect(parsePiAiOutput(events(JSON.stringify({ tool: [{ method: "nodes" }], text })))).toEqual({
        tool: [{ method: "nodes" }],
        text: "",
      });
      for (const tool of [null, { method: "bash" }, [], [{ method: "bash" }]])
        expect(() => parsePiAiOutput(events(JSON.stringify({ tool, text })))).toThrow();
    }
  });

  it("reports failure metadata without response text, provider details or credentials", () => {
    const sensitive = "example-sensitive-response";
    const output = events(sensitive, "error");
    const metadata = piAiOutputDiagnostics(output);
    expect(metadata).toMatchObject({
      assistantMessages: 1,
      stopReason: "error",
      settled: true,
      textLength: sensitive.length,
      textFormat: "other",
    });
    expect(JSON.stringify(metadata)).not.toContain(sensitive);
    try {
      parsePiAiOutput(output);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PiAiResponseError);
      expect((error as PiAiResponseError).diagnostics).toEqual(metadata);
    }
    expect(piAiOutputDiagnostics(events('{"tool":null,"text":"Ready"}').split("\n")[0])).toMatchObject({
      stopReason: "stop",
      settled: null,
      textFormat: "json",
    });
  });

  it("registers only the terminating response adapter and forces its provider function", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-response-extension-test-"));
    try {
      const schema = { type: "object", required: ["tool", "text"] };
      const path = await writePiResponseExtension(directory, schema);
      const source = await readFile(path, "utf8");
      const registerTool = vi.fn();
      const on = vi.fn();
      new Function(source.replace("export default function", "return function"))()({ registerTool, on });
      expect(registerTool).toHaveBeenCalledOnce();
      const tool = registerTool.mock.calls[0][0];
      expect(tool.name).toBe("freelens_response");
      expect(tool.parameters).toEqual(schema);
      const response = { tool: null, text: "Ready" };
      expect(await tool.execute("example-call", response)).toMatchObject({
        terminate: true,
        details: { freelensResponse: response },
      });
      const hook = on.mock.calls[0][1];
      expect(hook({ payload: { messages: [] } }, { model: { api: "openai-completions" } })).toEqual({
        messages: [],
        tool_choice: { type: "function", function: { name: "freelens_response" } },
      });
      expect(piAiArguments("example/glm-5-3", "high", schema, path)).toEqual(
        expect.arrayContaining(["--no-tools", "--no-extensions", "--extension", path, "--tools", "freelens_response"]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts exactly one successful controlled response tool and rejects unexpected executions", () => {
    const response = { tool: null, text: "Ready" };
    const assistant = {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-example", name: "freelens_response", arguments: response }],
      },
    };
    const start = {
      type: "tool_execution_start",
      toolName: "freelens_response",
      toolCallId: "call-example",
      args: response,
    };
    const end = {
      type: "tool_execution_end",
      toolName: "freelens_response",
      toolCallId: "call-example",
      isError: false,
      result: { details: { freelensResponse: response } },
    };
    const settled = { type: "agent_settled", aborted: false };
    const lines = (...values: unknown[]) => values.map((value) => JSON.stringify(value)).join("\n");
    expect(parsePiAiOutput(lines(assistant, start, end, settled))).toEqual(response);
    for (const output of [
      lines(end, settled),
      lines(start, end, settled),
      lines(assistant, { ...start, args: { tool: null, text: "Forged" } }, end, settled),
      lines(
        assistant,
        start,
        { ...end, result: { details: { freelensResponse: { tool: null, text: "Forged" } } } },
        settled,
      ),
      lines(assistant, start, end, { type: "message_start", message: { role: "assistant" } }, settled),
      lines(assistant, start, end, { type: "agent_start" }, settled),
      lines(assistant, start, end, end, settled),
      lines(assistant, start, { ...end, isError: true }, settled),
      lines(assistant, start, { ...end, toolCallId: "other-call" }, settled),
      lines(assistant, { ...start, toolName: "bash" }, end, settled),
      lines(assistant, start, end, { ...settled, aborted: true }),
      lines(assistant, start, end),
    ])
      expect(() => parsePiAiOutput(output)).toThrow();
    const text: string[] = [];
    const stream = createAiAnswerStream("pi", (value) => text.push(value));
    stream(`${lines(assistant, start, end, settled)}\n`);
    expect(text).toEqual(["Ready"]);
    const hidden: string[] = [];
    const forgedStream = createAiAnswerStream("pi", (value) => hidden.push(value));
    forgedStream(`${lines(end, assistant, start, end, settled)}\n`);
    expect(hidden).toEqual([]);
  });

  it("adds supported model reasoning mappings while preserving explicit user overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reasoning-map-test-"));
    try {
      await writeFile(
        join(directory, "models.json"),
        JSON.stringify({
          providers: {
            example: {
              api: "openai-completions",
              models: [
                { id: "deepseek-v4-flash", thinkingLevelMap: { high: "custom-high" } },
                { id: "glm-5-3" },
                { id: "unrelated" },
              ],
            },
          },
        }),
      );
      const env = await preparePiAiEnvironment(directory, { PI_CODING_AGENT_DIR: directory });
      const config = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8"));
      const [deepseek, glm, unrelated] = config.providers.example.models;
      expect(deepseek.thinkingLevelMap).toMatchObject({ off: "none", xhigh: "xhigh", high: "custom-high", max: null });
      expect(glm.thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      });
      expect(unrelated).not.toHaveProperty("thinkingLevelMap");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not inherit executable process controls", () => {
    expect(
      piAiEnvironment({ NODE_OPTIONS: "private", OPENAI_API_KEY: "example", PI_CODING_AGENT_DIR: "/tmp/example" }),
    ).toMatchObject({ OPENAI_API_KEY: "example", PI_TELEMETRY: "0" });
    expect(piAiEnvironment({ NODE_OPTIONS: "private" })).not.toHaveProperty("NODE_OPTIONS");
  });

  it("accepts only settled successful assistant JSON and strict approved reads", () => {
    expect(parsePiAiOutput(events('{"tool":null,"text":"Ready"}'))).toEqual({ tool: null, text: "Ready" });
    expect(parsePiAiOutput(events('{"tool":{"method":"pods"},"text":""}')).tool).toEqual({ method: "pods" });
    for (const output of [
      events('{"tool":null,"text":"Ready"}', "length"),
      events('{"tool":{"method":"bash"},"text":""}'),
      events('{"tool":null,"text":"Ready","extra":true}'),
      events('{"tool":null,"text":"Ready"}').split("\n")[0],
      events('{"tool":null,"text":"Ready"}').replace('"aborted":false', '"aborted":true'),
    ])
      expect(() => parsePiAiOutput(output)).toThrow();
  });

  it.each([
    "error",
    "length",
    "aborted",
  ])("uses a successful retry after an earlier [%s] assistant result", (stopReason) => {
    const failed = events("", stopReason).split("\n")[0];
    const retry = JSON.stringify({ type: "message_start", message: { role: "assistant" } });
    expect(parsePiAiOutput(`${failed}\n${retry}\n${events('{"tool":null,"text":"Recovered"}')}`)).toEqual({
      tool: null,
      text: "Recovered",
    });
    expect(() =>
      parsePiAiOutput(
        `${events('{"tool":null,"text":"Earlier"}').split("\n")[0]}\n${retry}\n${events("", stopReason)}`,
      ),
    ).toThrow(stopReason === "error" ? "CLI request failed" : "AI returned an incomplete response");
  });

  it("preserves documented Pi provider credentials while excluding process hooks", () => {
    const source = {
      ZAI_API_KEY: "example",
      ZAI_CODING_CN_API_KEY: "example-cn",
      HF_TOKEN: "example-hf",
      MOONSHOT_API_KEY: "example-moonshot",
      NODE_OPTIONS: "untrusted",
      NODE_PATH: "untrusted",
    };
    const environment = piAiEnvironment(source);
    for (const key of ["ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "HF_TOKEN", "MOONSHOT_API_KEY"])
      expect(environment[key]).toBe(source[key as keyof typeof source]);
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("NODE_PATH");
  });

  it("rejects native tool calls and provider errors", () => {
    for (const event of [
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start" } },
      { type: "tool_execution_start" },
    ])
      expect(() => parsePiAiOutput(`${JSON.stringify(event)}\n${events('{"tool":null,"text":"Ready"}')}`)).toThrow();
  });

  it("streams text deltas split across transport chunks without exposing thinking or reads", () => {
    const visible: string[] = [];
    const stream = createAiAnswerStream("pi", (text) => visible.push(text));
    for (const delta of ['{"tool":null,"text":"Re', 'ady"}']) {
      const line = `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } })}\n`;
      stream(line.slice(0, 8));
      stream(line.slice(8));
    }
    expect(visible).toEqual(["Re", "Ready"]);
    const hidden: string[] = [];
    const read = createAiAnswerStream("pi", (text) => hidden.push(text));
    read(
      `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private" } })}\n`,
    );
    read(`${events('{"tool":{"method":"pods"},"text":"private"}')}\n`);
    expect(hidden).toEqual([]);
  });
});
