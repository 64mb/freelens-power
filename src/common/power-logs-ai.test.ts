import { expect, it } from "vitest";
import { powerLogLineEvidence, powerLogQueryEvidence } from "./power-logs-ai";

import type { LogCapture, LogRecord } from "./power-logs";

const target = { kind: "Pod" as const, namespace: "demo", name: "sample", uid: "pod-1" };
it("redacts nested and repeatedly escaped JSON fields before serializing evidence", () => {
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
  expect(evidence).not.toContain("sample-sensitive");
  expect(evidence).not.toContain("sample-password");
  expect(evidence).toContain("started");
});
it("redacts sensitive SQL columns and structured string cells, preserving snapshot identity", () => {
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
  expect(evidence).not.toContain("sample-sensitive");
  expect(evidence).not.toContain("sample-key");
  expect(evidence).toContain("hello");
  expect(evidence).toContain("Limited source");
  expect(evidence).toContain('"createdAt": 1000');
});
