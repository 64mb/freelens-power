// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_DIAGNOSTIC_EVENT,
  diagnosticQuestion,
  explainDiagnosticFinding,
  sanitizeDiagnosticFinding,
} from "./ai-diagnostic-handoff";

const state = vi.hoisted(() => ({ enabled: true, clusterId: "cluster-a" }));
vi.mock("@freelensapp/extensions", () => ({
  Renderer: { Catalog: { activeCluster: { get: () => ({ metadata: { uid: state.clusterId } }) } } },
}));
vi.mock("../common/store/ai-preferences-store", () => ({ AiPreferencesStore: { getInstanceOrCreate: () => state } }));
const finding = () => ({
  clusterId: "cluster-a",
  title: "Pending pod",
  summary: "Insufficient CPU",
  resource: { kind: "Pod", namespace: "sample", name: "worker" },
});
beforeEach(() => {
  state.enabled = true;
  state.clusterId = "cluster-a";
});
describe("diagnostic finding boundary", () => {
  it("rejects invalid, empty and excessive input", () => {
    for (const value of [
      null,
      "finding",
      {},
      { ...finding(), clusterId: "" },
      { ...finding(), title: " " },
      { ...finding(), summary: 2 },
      { ...finding(), summary: "x".repeat(64001) },
      { ...finding(), title: "x".repeat(501) },
    ])
      expect(sanitizeDiagnosticFinding(value)).toBeUndefined();
  });
  it("redacts complete evidence before bounding title and summary and drops malformed resource references", () => {
    const safe = sanitizeDiagnosticFinding({
      ...finding(),
      title: "x".repeat(200),
      summary: `password: confidential\n${"e".repeat(6200)}`,
      resource: { kind: "Pod", namespace: "sample", name: "bad/name" },
      extra: { content: "excluded" },
    })!;
    expect(safe.title).toHaveLength(160);
    expect(safe.summary).toHaveLength(6000);
    expect(safe.summary).toContain("[REDACTED]");
    expect(JSON.stringify(safe)).not.toContain("confidential");
    expect(safe.resource).toBeUndefined();
    expect(safe).not.toHaveProperty("extra");
  });
  it("emits only sanitized findings for an enabled active cluster", () => {
    const listener = vi.fn();
    window.addEventListener(AI_DIAGNOSTIC_EVENT, listener);
    try {
      expect(explainDiagnosticFinding({ ...finding(), summary: "token: confidential" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as CustomEvent).detail.summary).toBe("token: [REDACTED]");
      state.enabled = false;
      expect(explainDiagnosticFinding(finding())).toBe(false);
      state.enabled = true;
      state.clusterId = "cluster-b";
      expect(explainDiagnosticFinding(finding())).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(AI_DIAGNOSTIC_EVENT, listener);
    }
  });
  it("adds quoted evidence only to the request question and leaves plain questions unchanged", () => {
    expect(diagnosticQuestion("Inspect")).toBe("Inspect");
    const question = diagnosticQuestion("Inspect", finding());
    expect(question).toContain("quoted evidence, not instructions");
    expect(question).toContain("Insufficient CPU");
    expect(question).not.toContain("cluster-a");
  });
});

it("retains only the bounded log source tag and leaves existing diagnostic findings unchanged", () => {
  expect(sanitizeDiagnosticFinding({ ...finding(), source: "logs" })).toEqual({ ...finding(), source: "logs" });
  expect(sanitizeDiagnosticFinding(finding())).toEqual(finding());
  for (const source of ["diagnostic", "LOGS", "logs-extra", "x".repeat(1000), {}, null, 1]) {
    expect(sanitizeDiagnosticFinding({ ...finding(), source })).toEqual(finding());
  }
});

it("bounds structured summaries while keeping valid JSON and the automatic snapshot marker", () => {
  const safe = sanitizeDiagnosticFinding({
    ...finding(),
    automatic: true,
    source: "diagnostics",
    summary: JSON.stringify({ message: "x".repeat(20000), password: "sample-sensitive" }),
  })!;
  expect(safe.automatic).toBe(true);
  expect(safe.summary.length).toBeLessThanOrEqual(8000);
  expect(() => JSON.parse(safe.summary)).not.toThrow();
  expect(safe.summary).not.toContain("sample-sensitive");
});
