import { describe, expect, it } from "vitest";
import { aiLogQuery, summarizeAiLogs } from "./ai-logs";

describe("AI log summaries", () => {
  it("builds only a bounded pod log GET query", () => {
    expect(aiLogQuery({ method: "logs", namespace: "default", name: "example-pod" })).toEqual({
      path: "/api/v1/namespaces/default/pods/example-pod/log",
      query: { tailLines: 100, limitBytes: 65536, follow: false, timestamps: false },
    });
    expect(() => aiLogQuery({ method: "logs", name: "example-pod" })).toThrow();
    expect(() => aiLogQuery({ method: "logs", namespace: "default", name: "../secrets" })).toThrow();
    expect(() => aiLogQuery({ method: "pods", namespace: "default", name: "example-pod" })).toThrow();
  });

  it("returns bounded log text and fixed aggregate counters", () => {
    const summary = summarizeAiLogs(
      [
        "ERROR EXAMPLE_KEY=example-sensitive timeout",
        "warning connection refused example-sensitive",
        "fatal out of memory example-sensitive",
        "permission denied example-sensitive",
        "",
        "ordinary example-sensitive",
        "",
      ].join("\n"),
    );
    expect(summary).toEqual({
      sampledNonemptyLines: 5,
      errorLines: 2,
      warningLines: 1,
      timeoutLines: 1,
      outOfMemoryLines: 1,
      connectionFailureLines: 1,
      permissionFailureLines: 1,
      lines: [
        "ERROR EXAMPLE_KEY=example-sensitive timeout",
        "warning connection refused example-sensitive",
        "fatal out of memory example-sensitive",
        "permission denied example-sensitive",
        "ordinary example-sensitive",
      ],
      boundedSample: true,
    });
    expect(JSON.stringify(summary)).toContain("example-sensitive");
    expect(JSON.stringify(summary)).toContain("EXAMPLE_KEY");
  });

  it.each(["Secret", "ConfigMap"])("hides recognized %s payload values before byte truncation", (kind) => {
    const summary = summarizeAiLogs(
      JSON.stringify({
        kind,
        apiVersion: "v1",
        metadata: { name: "example-config" },
        data: { TOKEN: "payload-value".repeat(6000) },
      }),
    );
    const text = summary.lines.join("\n");
    expect(text).toContain("TOKEN");
    expect(text).toContain("example-config");
    expect(text).not.toContain("payload-value");
    expect(text).toContain("[REDACTED]");
  });

  it("hides recognized YAML payloads while keeping ordinary environment and log text", () => {
    const summary = summarizeAiLogs(
      "kind: ConfigMap\napiVersion: v1\ndata:\n  TOKEN: payload-value\n---\nordinary TOKEN=log-value",
    );
    expect(summary.lines.join("\n")).not.toContain("payload-value");
    expect(summary.lines.join("\n")).toContain("TOKEN");
    expect(summary.lines.join("\n")).toContain("ordinary TOKEN=log-value");
  });

  it("bounds samples by lines and bytes", () => {
    expect(summarizeAiLogs("error\n".repeat(150))).toMatchObject({ sampledNonemptyLines: 100, errorLines: 100 });
    expect(summarizeAiLogs(`${"a".repeat(65536)}\nerror`)).toMatchObject({ sampledNonemptyLines: 1, errorLines: 0 });
    expect(() => summarizeAiLogs({ data: "example-sensitive" })).toThrow();
  });
  it("summarizes a single JSON log line and an empty log response as text", () => {
    expect(summarizeAiLogs('{"level":"error","message":"example-sensitive"}')).toMatchObject({
      errorLines: 1,
      sampledNonemptyLines: 1,
    });
    expect(summarizeAiLogs("")).toMatchObject({ errorLines: 0, sampledNonemptyLines: 0 });
  });
});
