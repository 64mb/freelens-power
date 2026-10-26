import { expect, it } from "vitest";
import { powerLogLineEvidence, powerLogQueryEvidence } from "./power-logs-ai";

import type { LogCapture, LogRecord } from "./power-logs";

const target = { kind: "Pod" as const, namespace: "demo", name: "sample", uid: "pod-1" };
it("preserves ordinary nested JSON fields before serializing evidence", () => {
  const line: LogRecord = {
    timestamp: null,
    pod: "sample",
    podUid: "pod-1",
    container: "app",
    level: "info",
    message: "started",
    fieldsJson: JSON.stringify({ token: "sample-sensitive", nested: JSON.stringify({ password: "sample-password" }) }),
  };
  const evidence = powerLogLineEvidence(target, line);
  expect(evidence).toContain("sample-sensitive");
  expect(evidence).toContain("sample-password");
  expect(evidence).toContain("started");
});
it("preserves ordinary SQL columns and structured cells with snapshot identity", () => {
  const capture: LogCapture = {
    id: "capture-1",
    target,
    createdAt: 1000,
    expiresAt: 2000,
    state: "partial",
    notes: ["Limited source"],
    rows: 1,
    bytes: 10,
  };
  const evidence = powerLogQueryEvidence(capture, "SELECT * FROM logs", {
    columns: ["token", "data"],
    rows: [["sample-sensitive", JSON.stringify({ api_key: "sample-key", text: "hello" })]],
    truncated: false,
    elapsedMs: 1,
  });
  expect(evidence).toContain("sample-sensitive");
  expect(evidence).toContain("sample-key");
  expect(evidence).toContain("hello");
  expect(evidence).toContain("Limited source");
  expect(evidence).toContain('"createdAt": 1000');
});

it("keeps a redacted query failure ahead of a long SQL draft", () => {
  const capture: LogCapture = {
    id: "capture-failed",
    target,
    createdAt: 1000,
    expiresAt: 2000,
    state: "ready",
    notes: [],
    rows: 0,
    bytes: 0,
  };
  const evidence = powerLogQueryEvidence(capture, `SELECT '${"x".repeat(65500)}'`, {
    columns: [],
    rows: [],
    truncated: false,
    elapsedMs: 1,
    error: "Query stopped or failed. Check SQL syntax.",
  });
  expect(evidence.length).toBeLessThanOrEqual(6000);
  expect(evidence).toContain('"state": "Query failed"');
  expect(evidence).toContain("Query stopped or failed. Check SQL syntax.");
});

it("keeps oversized line evidence valid JSON", () => {
  const evidence = powerLogLineEvidence(target, {
    timestamp: null,
    pod: "sample",
    podUid: "pod-1",
    container: "app",
    level: "info",
    message: "x".repeat(20000),
    fieldsJson: "{}",
  });
  expect(evidence.length).toBeLessThanOrEqual(6000);
  expect(JSON.parse(evidence).line.pod).toBe("sample");
});

it("masks recognized ConfigMap values inside SQL cells without masking ordinary columns", () => {
  const capture = {
    id: "capture-1",
    target,
    createdAt: 1000,
    expiresAt: 2000,
    state: "ready",
    notes: [],
    rows: 1,
    bytes: 10,
  } as LogCapture;
  const evidence = powerLogQueryEvidence(capture, "SELECT * FROM logs", {
    columns: ["token", "json"],
    rows: [
      [
        "visible",
        JSON.stringify({ kind: "ConfigMap", metadata: { name: "settings" }, data: { SETTING: "withheld-setting" } }),
      ],
    ],
    truncated: false,
    elapsedMs: 1,
  });
  expect(evidence).toContain("visible");
  expect(evidence).toContain("SETTING");
  expect(evidence).not.toContain("withheld-setting");
});
