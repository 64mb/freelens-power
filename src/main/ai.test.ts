import { describe, expect, it } from "vitest";
import { aiFailureCode, codexAiArguments, parseCodexAiOutput, safeAiContext } from "./ai";
import { aiReadPath, aiReadQuery, summarizeAiResource } from "./ai-resources";

describe("AI read boundary", () => {
  it("pins each read to the selected cluster and rejects unsupported endpoints", () => {
    expect(aiReadQuery({ method: "pods", namespace: "default" })).toEqual({
      apiVersion: "v1",
      kind: "Pod",
      namespace: "default",
    });
    expect(aiReadQuery({ method: "resources", resource: "deployments" })).toEqual({
      apiVersion: "apps/v1",
      kind: "Deployment",
    });
    expect(aiReadQuery({ method: "nodes", name: "example-node" })).toEqual({
      apiVersion: "v1",
      kind: "Node",
      name: "example-node",
    });
    expect(() => aiReadQuery({ method: "resources", resource: "pods/exec" })).toThrow();
    expect(() => aiReadQuery({ method: "resources", resource: "constructor" })).toThrow();
    expect(() => aiReadQuery({ method: "pods", name: "--raw=/" })).toThrow();
    expect(() => aiReadQuery({ method: "pods", name: "example-pod" })).toThrow("namespace");
    expect(() => aiReadQuery({ method: "nodes", namespace: "default" })).toThrow();
    expect(() => aiReadQuery({ method: "logs", name: "example" })).toThrow("withheld");
  });

  it("never forwards environment values or arbitrary nested resource strings", () => {
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
      detailsWithheld: true,
    });
    expect(JSON.stringify(result)).not.toContain("example-sensitive");
  });

  it("returns useful bounded pod and node health without free-form payloads", () => {
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
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("example-sensitive");
  });

  it("removes literal environment values repeated in identities across list entries", () => {
    const items = Array.from({ length: 201 }, () => ({ kind: "Pod", metadata: { name: "example-sensitive-pod" } }));
    items.push({
      kind: "Pod",
      metadata: { name: "example" },
      spec: { containers: [{ env: [{ name: "EXAMPLE_KEY", value: "sensitive" }] }] },
    } as (typeof items)[number]);
    const result = summarizeAiResource({ items }) as { items: unknown[]; truncated: boolean };
    expect(result.items).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("withholds identities exposed through downward API environment references", () => {
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
    expect(result).not.toHaveProperty("name");
    expect(result).not.toHaveProperty("namespace");
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

  it("preserves useful spec structure and Secret key names while dropping nested payloads and env values", () => {
    const result = summarizeAiResource({
      kind: "Deployment",
      spec: {
        replicas: 2,
        enabled: true,
        strategy: { type: "RollingUpdate" },
        template: {
          spec: {
            containers: [
              {
                env: [{ name: "EXAMPLE_KEY", value: "100m" }],
                resources: { requests: { cpu: "100m", memory: "128Mi" } },
                nested: {
                  kind: "Secret",
                  data: { "tls.crt": "example-sensitive" },
                  stringData: { password: "example-sensitive" },
                  binaryData: { payload: "example-sensitive" },
                },
                command: ["example-sensitive"],
              },
            ],
          },
        },
      },
    });
    expect(result).toMatchObject({
      spec: {
        replicas: 2,
        enabled: true,
        strategy: { type: "RollingUpdate" },
        template: {
          spec: {
            containers: [
              {
                env: [{ name: "EXAMPLE_KEY" }],
                resources: { requests: { cpu: "[withheld]", memory: "128Mi" } },
                nested: { dataKeys: ["tls.crt"], stringDataKeys: ["password"], binaryDataKeys: ["payload"] },
                command: ["[withheld]"],
              },
            ],
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("example-sensitive");
    expect(JSON.stringify(result)).not.toContain("100m");
  });

  it("withholds sensitive spec fields for all value types without losing payload key names", () => {
    const result = summarizeAiResource({
      spec: {
        nested: {
          password: 12345,
          access_token: "Always",
          credentials: { enabled: true },
          API_KEY: false,
          privateKey: [123],
        },
        data: { password: "example-sensitive", token: "example-sensitive" },
        replicas: 2,
      },
    });
    expect(result).toMatchObject({
      spec: {
        nested: {
          password: "[withheld]",
          access_token: "[withheld]",
          credentials: "[withheld]",
          API_KEY: "[withheld]",
          privateKey: "[withheld]",
        },
        dataKeys: ["password", "token"],
        replicas: 2,
      },
    });
    expect(JSON.stringify(result)).not.toContain("12345");
    expect(JSON.stringify(result)).not.toContain("Always");
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
