import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aiFailureCode,
  claudeAiArguments,
  claudeAiEnvironment,
  codexAiArguments,
  parseClaudeAiOutput,
  parseCodexAiOutput,
  readClaudeAiEnvironment,
  safeAiContext,
} from "./ai";
import { collectAiReferences } from "./ai-references";
import { aiReadPath, aiReadQuery, summarizeAiResource } from "./ai-resources";

describe("AI read boundary", () => {
  it("pins each read to the selected cluster and rejects unsupported endpoints", () => {
    expect(aiReadQuery({ method: "pods", namespace: "default" })).toEqual({
      apiVersion: "v1",
      kind: "Pod",
      resource: "pods",
      namespace: "default",
    });
    expect(aiReadQuery({ method: "resources", resource: "deployments" })).toEqual({
      apiVersion: "apps/v1",
      kind: "Deployment",
      resource: "deployments",
    });
    expect(aiReadQuery({ method: "nodes", name: "example-node" })).toEqual({
      apiVersion: "v1",
      kind: "Node",
      resource: "nodes",
      name: "example-node",
    });
    expect(() => aiReadQuery({ method: "resources", resource: "pods/exec" })).toThrow();
    expect(() => aiReadQuery({ method: "resources", resource: "constructor" })).toThrow();
    expect(() => aiReadQuery({ method: "pods", name: "--raw=/" })).toThrow();
    expect(() => aiReadQuery({ method: "pods", name: "example-pod" })).toThrow("namespace");
    expect(() => aiReadQuery({ method: "nodes", namespace: "default" })).toThrow();
    expect(() => aiReadQuery({ method: "logs", name: "example" })).toThrow("withheld");
  });

  it("preserves ordinary environment values and arbitrary resource content", () => {
    const result = summarizeAiResource({
      kind: "Pod",
      metadata: { annotations: { arbitrary: "example-sensitive" } },
      spec: {
        template: {
          spec: {
            containers: [
              {
                env: [{ name: "EXAMPLE_KEY", value: "example-sensitive" }],
                args: ["example-sensitive"],
                envFrom: [{ secretRef: { name: "example-sensitive" } }],
              },
            ],
          },
        },
      },
      status: { readyReplicas: 2, message: "example-sensitive", phase: "example-sensitive" },
      data: { EXAMPLE_KEY: "example-sensitive" },
      stringData: { EXAMPLE_KEY: "example-sensitive" },
    });
    expect(result).toMatchObject({
      kind: "Pod",
      counts: { readyReplicas: 2 },
      environmentNames: ["EXAMPLE_KEY"],
      detailsWithheld: false,
    });
    expect(JSON.stringify(result)).toContain("example-sensitive");
  });

  it("returns bounded pod and node health with free-form messages", () => {
    const result = summarizeAiResource({
      items: [
        {
          kind: "Pod",
          metadata: { name: "example-pod", namespace: "default" },
          status: {
            phase: "Running",
            conditions: [{ type: "Ready", status: "False", message: "example-sensitive" }],
            containerStatuses: [
              {
                name: "example-container",
                ready: false,
                restartCount: 4,
                state: { waiting: { reason: "CrashLoopBackOff", message: "example-sensitive" } },
              },
            ],
          },
        },
        {
          kind: "Node",
          metadata: { name: "example-node" },
          status: {
            conditions: [
              { type: "Ready", status: "True" },
              { type: "MemoryPressure", status: "False" },
              { type: "example-sensitive", status: "True" },
            ],
          },
        },
      ],
    });
    expect(result).toMatchObject({
      truncated: false,
      items: [
        {
          kind: "Pod",
          name: "example-pod",
          namespace: "default",
          phase: "Running",
          conditions: [{ type: "Ready", status: "False" }],
          containers: [
            { name: "example-container", ready: false, restartCount: 4, state: "waiting", reason: "CrashLoopBackOff" },
          ],
        },
        {
          kind: "Node",
          name: "example-node",
          conditions: [
            { type: "Ready", status: "True" },
            { type: "MemoryPressure", status: "False" },
            { type: "example-sensitive", status: "True" },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).toContain("example-sensitive");
  });

  it("preserves identities matching environment values across list entries", () => {
    const items = Array.from({ length: 201 }, () => ({ kind: "Pod", metadata: { name: "example-sensitive-pod" } }));
    items.push({
      kind: "Pod",
      metadata: { name: "example" },
      spec: { containers: [{ env: [{ name: "EXAMPLE_KEY", value: "sensitive" }] }] },
    } as (typeof items)[number]);
    const result = summarizeAiResource({ items }) as { items: unknown[]; truncated: boolean };
    expect(result.items).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).toContain("example-sensitive-pod");
  });

  it("does not suppress identities or keys matching another list entry's environment", () => {
    expect(
      summarizeAiResource({
        items: [
          { kind: "Pod", metadata: { name: "example-pod", namespace: "default" }, spec: { example: "visible" } },
          {
            kind: "Pod",
            metadata: { name: "other-pod" },
            spec: {
              containers: [
                {
                  env: [
                    { name: "EXAMPLE", value: "example" },
                    { name: "NAMESPACE", value: "default" },
                  ],
                },
              ],
            },
          },
        ],
      }),
    ).toMatchObject({
      items: [{ name: "example-pod", namespace: "default", spec: { example: "visible" } }, { name: "other-pod" }],
    });
  });

  it("preserves identities exposed through downward API environment references", () => {
    const result = summarizeAiResource({
      kind: "Pod",
      metadata: { name: "example-pod", namespace: "default" },
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
    });
    expect(result).toHaveProperty("name", "example-pod");
    expect(result).toHaveProperty("namespace", "default");
    expect(result).toMatchObject({ phase: "Running", environmentNames: ["POD_NAME", "POD_NAMESPACE"] });
  });

  it("disables built-in tools and config inheritance without changing authentication", () => {
    const args = codexAiArguments("example-model", "default", "/tmp/example");
    for (const flag of [
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "features.shell_tool=false",
      "features.unified_exec=false",
      "features.hooks=false",
      "features.apps=false",
      "features.plugins=false",
      'web_search="disabled"',
    ])
      expect(args).toContain(flag);
    expect(args).not.toContain('service_tier="fast"');
    expect(codexAiArguments("example-model", "fast", "/tmp/example")).toContain('service_tier="fast"');
    expect(() => codexAiArguments("--bad-model", "fast", "/tmp/example")).not.toThrow();
    expect(() => codexAiArguments("bad model", "fast", "/tmp/example")).toThrow();
  });

  it("reads known certificate resources and authorizes discovered custom kinds only", () => {
    expect(aiReadQuery({ method: "resources", resource: "certificates.cert-manager.io" })).toEqual({
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      resource: "certificates",
    });
    const catalog = [
      {
        apiVersion: "example.com/v1",
        kind: "Example",
        resource: "examples",
        namespaced: true,
        verbs: ["get", "list"] as ("get" | "list")[],
      },
    ];
    expect(
      aiReadQuery(
        { method: "resources", apiVersion: "example.com/v1", kind: "Example", namespace: "default" },
        catalog,
      ),
    ).toEqual({ apiVersion: "example.com/v1", kind: "Example", resource: "examples", namespace: "default" });
    expect(() => aiReadQuery({ method: "resources", apiVersion: "example.com/v1", kind: "Other" }, catalog)).toThrow(
      "UNSUPPORTED_RESOURCE",
    );
    expect(() => aiReadQuery({ method: "resources", resource: "examples/status" }, catalog)).toThrow(
      "UNSUPPORTED_RESOURCE",
    );
  });

  it("uses the discovered irregular plural in a validated native GET path", () => {
    const query = aiReadQuery(
      {
        method: "resources",
        apiVersion: "example.com/v1",
        kind: "Widget",
        namespace: "default",
        name: "example-widget",
      },
      [
        {
          apiVersion: "example.com/v1",
          kind: "Widget",
          resource: "widgetrecords",
          namespaced: true,
          verbs: ["get", "list"],
        },
      ],
    );
    expect(aiReadPath(query)).toBe("/apis/example.com/v1/namespaces/default/widgetrecords/example-widget");
    expect(() => aiReadPath({ ...query, resource: "widgets/exec" })).toThrow();
    expect(() => aiReadPath({ ...query, apiVersion: "../v1" })).toThrow();
    expect(() => aiReadPath({ ...query, namespace: "../default" })).toThrow();
  });

  it("redacts nested Kubernetes payloads while preserving ordinary spec values and payload keys", () => {
    const result = summarizeAiResource({
      kind: "Deployment",
      spec: {
        containers: [{ env: [{ name: "EXAMPLE_KEY", value: "100m" }], command: ["example-command"] }],
        data: { ordinary: "visible" },
        nested: {
          kind: "Secret",
          apiVersion: "v1",
          data: { "tls.crt": "private-certificate" },
          stringData: { password: "private-password" },
        },
      },
    });
    expect(result).toMatchObject({
      spec: {
        containers: [{ env: [{ name: "EXAMPLE_KEY", value: "100m" }], command: ["example-command"] }],
        data: { ordinary: "visible" },
        nested: { data: { "tls.crt": "[REDACTED]" }, stringData: { password: "[REDACTED]" } },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-certificate");
    expect(JSON.stringify(result)).not.toContain("private-password");
  });

  it("uses the approved root identity and redacts last-applied payloads", () => {
    const annotation = "kubectl.kubernetes.io/last-applied-configuration";
    const result = summarizeAiResource(
      {
        metadata: {
          name: "example",
          annotations: {
            ordinary: "visible",
            [annotation]: JSON.stringify({ apiVersion: "v1", kind: "ConfigMap", data: { setting: "private-setting" } }),
          },
        },
        data: { setting: "private-setting" },
        binaryData: { file: "private-binary" },
      },
      { kind: "ConfigMap", apiVersion: "v1" },
    );
    expect(result).toMatchObject({
      name: "example",
      kind: "ConfigMap",
      dataKeys: ["setting"],
      binaryDataKeys: ["file"],
      data: { setting: "[REDACTED]" },
      metadata: { annotations: { ordinary: "visible" } },
    });
    expect(JSON.stringify(result)).not.toContain("private-setting");
    expect(JSON.stringify(result)).not.toContain("private-binary");
  });

  it("redacts actual Secret payloads even when the approved query kind differs", () => {
    const result = summarizeAiResource(
      {
        kind: "Secret",
        apiVersion: "v1",
        metadata: { name: "example", namespace: "default" },
        data: { key: "private-payload" },
      },
      { kind: "Pod", apiVersion: "v1" },
    );
    expect(result).toMatchObject({ kind: "Secret", data: { key: "[REDACTED]" } });
    expect(JSON.stringify(result)).not.toContain("private-payload");
    expect(collectAiReferences(result, { kind: "Pod", apiVersion: "v1" })).toEqual([]);
  });

  it("redacts approved Secret payloads even when the returned kind differs", () => {
    const result = summarizeAiResource(
      { kind: "Pod", data: { key: "private-payload" } },
      { kind: "Secret", apiVersion: "v1" },
    );
    expect(result).toMatchObject({ kind: "Pod", data: { key: "[REDACTED]" } });
    expect(JSON.stringify(result)).not.toContain("private-payload");
  });

  it.each([
    "Secret",
    "ConfigMap",
  ])("redacts actual %sList items without allowing a mismatched query to forge references", (kind) => {
    const input = {
      kind: `${kind}List`,
      items: [{ metadata: { name: "example", namespace: "default" }, data: { key: "private-payload" } }],
    };
    for (const approved of [undefined, { kind: "Pod", apiVersion: "v1" }]) {
      const result = summarizeAiResource(input, approved);
      expect(result).toMatchObject({ items: [{ data: { key: "[REDACTED]" } }] });
      expect(JSON.stringify(result)).not.toContain("private-payload");
      expect(collectAiReferences(result, { kind: "Pod", apiVersion: "v1" })).toEqual([]);
    }
  });

  it("preserves every pod identity and restart count fairly within a bounded verbose list", () => {
    const result = summarizeAiResource(
      {
        items: Array.from({ length: 200 }, (_, index) => ({
          kind: "Pod",
          metadata: { name: `example-${index}`, namespace: "default", annotations: { note: "a".repeat(8000) } },
          spec: { containers: [{ args: ["b".repeat(8000)] }] },
          status: {
            phase: "Running",
            readyReplicas: 1,
            containerStatuses: [{ name: "app", ready: true, restartCount: index }],
          },
        })),
      },
      { kind: "Pod", apiVersion: "v1" },
    ) as { items: Record<string, unknown>[]; truncated: boolean };
    expect(result.items).toHaveLength(200);
    for (let index = 0; index < 200; index++)
      expect(result.items[index]).toMatchObject({
        name: `example-${index}`,
        namespace: "default",
        kind: "Pod",
        phase: "Running",
        counts: { readyReplicas: 1 },
        containers: [{ name: "app", restartCount: index }],
        truncated: true,
      });
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(200000);
  });

  it("preserves ordinary credential-like field names and custom resource payloads", () => {
    expect(
      summarizeAiResource({
        kind: "Widget",
        spec: {
          password: 12345,
          access_token: "Always",
          credentials: { enabled: true },
          API_KEY: false,
          data: { password: "visible" },
        },
      }),
    ).toMatchObject({
      kind: "Widget",
      spec: {
        password: 12345,
        access_token: "Always",
        credentials: { enabled: true },
        API_KEY: false,
        data: { password: "visible" },
      },
    });
  });

  it("passes only supported explicit reasoning efforts and leaves the default unset", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
      expect(codexAiArguments("example-model", "default", "/tmp/example", effort)).toContain(
        `model_reasoning_effort="${effort}"`,
      );
    }
    expect(
      codexAiArguments("example-model", "default", "/tmp/example").some((arg) =>
        arg.startsWith("model_reasoning_effort="),
      ),
    ).toBe(false);
    expect(() =>
      codexAiArguments("example-model", "default", "/tmp/example", 'high" arbitrary="example-sensitive'),
    ).toThrow("Invalid Codex reasoning effort");
  });

  it("classifies failures without exposing arbitrary error messages or data", () => {
    const cases = [
      [new Error("CLI request failed. Check CLI authentication and model access"), "CLI_FAILURE"],
      [new Error("Codex returned an incomplete response"), "INVALID_REPLY"],
      [new SyntaxError("example-sensitive"), "INVALID_REPLY"],
      [new Error("AI reached the maximum number of resource reads"), "READ_LIMIT"],
      [new Error("AI request timed out"), "TIMEOUT"],
      [new Error("AI request cancelled"), "CANCELLED"],
      [new DOMException("example-sensitive", "AbortError"), "CANCELLED"],
      [new Error("Conversation is too large. Start a new conversation"), "INPUT_LIMIT"],
      [new Error("example-sensitive"), "UNAVAILABLE"],
      [new Error("__proto__"), "UNAVAILABLE"],
      ["example-sensitive", "UNAVAILABLE"],
      [{ message: "example-sensitive", data: "example-sensitive" }, "UNAVAILABLE"],
    ] as const;
    for (const [error, expected] of cases) {
      expect(aiFailureCode(error)).toBe(expected);
      expect(aiFailureCode(error)).not.toContain("example-sensitive");
    }
  });

  it("requires a successful complete Codex turn before accepting structured output", () => {
    const item = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ text: "example answer", tool: null }) },
    });
    expect(() => parseCodexAiOutput(item)).toThrow("incomplete");
    expect(parseCodexAiOutput(`${item}\n{"type":"turn.completed"}`)).toEqual({ text: "example answer", tool: null });
    expect(() => parseCodexAiOutput(`${item}\n{"type":"turn.failed"}`)).toThrow();
  });
});

it("keeps only approved context metadata and never forwards extra resource fields", () => {
  const context = {
    clusterId: "example",
    screen: "/workloads",
    resource: { name: "example", env: [{ name: "EXAMPLE", value: "withheld" }] },
    env: "withheld",
  };
  expect(safeAiContext(context)).toEqual({ clusterId: "example", screen: "/workloads", resource: { name: "example" } });
});

describe("Claude native CLI boundary", () => {
  it("disables built-in tools, MCP, hooks, settings and session persistence", () => {
    const args = claudeAiArguments("sonnet");
    for (const flag of ["--safe-mode", "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"])
      expect(args).toContain(flag);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--json-schema");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("*");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: {} });
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toMatchObject({ disableAllHooks: true });
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(() => claudeAiArguments("--unsafe")).toThrow();
    expect(() => claudeAiArguments("gpt-example")).toThrow();
  });

  it("opts in to fast mode only for the fast speed", () => {
    const standard = claudeAiArguments("opus");
    const fast = claudeAiArguments("opus", "fast");
    expect(JSON.parse(standard[standard.indexOf("--settings") + 1])).not.toHaveProperty("fastMode");
    expect(JSON.parse(fast[fast.indexOf("--settings") + 1])).toMatchObject({ disableAllHooks: true, fastMode: true });
  });

  it("accepts only successful structured results, never arbitrary result text", () => {
    expect(
      parseClaudeAiOutput(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify({ text: "Approved summary", tool: null }),
        }),
      ),
    ).toEqual({ text: "Approved summary", tool: null });
    expect(() =>
      parseClaudeAiOutput(JSON.stringify({ type: "result", subtype: "success", result: "unstructured" })),
    ).toThrow();
    expect(() =>
      parseClaudeAiOutput(
        JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          result: JSON.stringify({ text: "Partial", tool: null }),
        }),
      ),
    ).toThrow();
  });
});

it("preserves native Claude authentication and transport only in the child environment", () => {
  const environment = claudeAiEnvironment({
    HOME: "example-home",
    PATH: "example-path",
    TMPDIR: "example-tmp",
    USER: "example-user",
    ANTHROPIC_AUTH_TOKEN: "example-token",
    ANTHROPIC_API_KEY: "example-key",
    CLAUDE_CODE_OAUTH_TOKEN: "example-oauth",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    HTTPS_PROXY: "http://example.invalid",
    NODE_EXTRA_CA_CERTS: "example-ca.pem",
    ANTHROPIC_MODEL: "example-model",
    NODE_OPTIONS: "--require=example",
    BUN_OPTIONS: "--preload=example",
    CLAUDE_CODE_SYSTEM_PROMPT: "example",
    CODEX_HOME: "example",
    EXAMPLE_SECRET: "example",
    CLAUDE_CONFIG_DIR: "example",
  });
  expect(environment).toEqual({
    HOME: "example-home",
    PATH: "example-path",
    TMPDIR: "example-tmp",
    USER: "example-user",
    ANTHROPIC_AUTH_TOKEN: "example-token",
    ANTHROPIC_API_KEY: "example-key",
    CLAUDE_CODE_OAUTH_TOKEN: "example-oauth",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    HTTPS_PROXY: "http://example.invalid",
    NODE_EXTRA_CA_CERTS: "example-ca.pem",
    ANTHROPIC_MODEL: "example-model",
  });
});

it("reads only approved native profile environment and lets process configuration win", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-native-profile-"));
  const file = join(directory, "settings.json");
  try {
    await expect(readClaudeAiEnvironment({}, directory)).resolves.toEqual({
      HOME: undefined,
      PATH: undefined,
      TMPDIR: undefined,
    });
    await writeFile(
      file,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://example.invalid",
          ANTHROPIC_AUTH_TOKEN: "example-profile-token",
          NODE_OPTIONS: "--require=example",
          BUN_OPTIONS: "--preload=example",
          EXAMPLE_SECRET: "example",
          HOME: "example-home",
        },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "example-helper" }] }] },
        apiKeyHelper: "example-helper",
        statusLine: { command: "example-helper" },
      }),
    );
    await expect(
      readClaudeAiEnvironment({ ANTHROPIC_AUTH_TOKEN: "example-process-token" }, directory),
    ).resolves.toEqual({
      HOME: undefined,
      PATH: undefined,
      TMPDIR: undefined,
      ANTHROPIC_BASE_URL: "https://example.invalid",
      ANTHROPIC_AUTH_TOKEN: "example-process-token",
    });
    for (const invalid of ["invalid", "[]", '{"env":[]}', " ".repeat(1024 * 1024 + 1)]) {
      await writeFile(file, invalid);
      await expect(readClaudeAiEnvironment({}, directory)).rejects.toThrow("CLI request failed");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects unstructured, malformed and executable Claude replies before any reads", () => {
  const envelope = (result: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result });
  for (const result of [
    "free text",
    '```json\n{"text":"example","tool":null}\n```',
    "null",
    "[]",
    '{"text":"example"}',
    '{"text":"example","tool":{"method":"exec","command":"example"}}',
    '{"text":"example","tool":{"method":"pods","command":"example"}}',
    '{"text":"example","tool":{"method":"pods","namespace":{}}}',
  ])
    expect(() => parseClaudeAiOutput(envelope(result))).toThrow();
  expect(() =>
    parseClaudeAiOutput(
      JSON.stringify({ type: "result", subtype: "success", is_error: true, result: '{"text":"example","tool":null}' }),
    ),
  ).toThrow();
  expect(
    parseClaudeAiOutput(envelope('{"text":"Approved summary","tool":{"method":"pods","namespace":"default"}}')),
  ).toEqual({ text: "Approved summary", tool: { method: "pods", namespace: "default" } });
});
